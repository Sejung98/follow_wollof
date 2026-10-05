#!/usr/bin/env python3
"""follow_wollof agent: watch Claude Code sessions on this host and stream snapshots.

Stdlib only, Python 3.6+. Run locally or piped over ssh (nothing is installed on the host):
    ssh host 'nice -n 10 python3 -u - --stream [--interval 2]' < agent.py
Linux, macOS and Windows.
Each output line is one JSON object:
    {"type": "snapshot", "host": ..., "t": ..., "sessions": [...]}   when anything changed
    {"type": "ping", "host": ..., "t": ...}                           every PING_EVERY seconds
"""
import glob
import json
import os
import socket
import sys
import time

HOME = os.path.expanduser("~")
SESSIONS_DIR = os.path.join(HOME, ".claude", "sessions")
PROJECTS_DIR = os.path.join(HOME, ".claude", "projects")
FOLLOW_DIR = os.path.join(HOME, ".follow_wollof", "sessions")
INTERVAL = float(sys.argv[sys.argv.index("--interval") + 1]) if "--interval" in sys.argv else 2.0
PING_EVERY = 20.0
TAIL_BYTES = 256 * 1024
REGISTRY_KEYS = ("pid", "sessionId", "cwd", "name", "status", "waitingFor", "kind",
                 "entrypoint", "startedAt", "updatedAt", "statusUpdatedAt", "version")

# transcript path -> (mtime, size, parsed) so unchanged transcripts are not re-read
_transcript_cache = {}
# plan events path -> (mtime, size, events)
_plan_cache = {}


if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    _k32.OpenProcess.restype = wintypes.HANDLE
    _k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    _k32.GetExitCodeProcess.restype = wintypes.BOOL
    _k32.CloseHandle.argtypes = (wintypes.HANDLE,)

    def pid_alive(pid):
        # os.kill(pid, 0) would terminate the process on Windows; query it instead
        k32 = _k32
        h = k32.OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return ctypes.get_last_error() == 5  # ERROR_ACCESS_DENIED: exists (e.g. elevated), like EPERM
        code = wintypes.DWORD()
        ok = k32.GetExitCodeProcess(h, ctypes.byref(code))
        k32.CloseHandle(h)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
else:
    def pid_alive(pid):
        try:
            os.kill(int(pid), 0)
            return True
        except PermissionError:
            return True
        except Exception:
            return False


def find_transcript(session_id):
    hits = glob.glob(os.path.join(PROJECTS_DIR, "*", session_id + ".jsonl"))
    return max(hits, key=os.path.getmtime) if hits else None


def _scan_head_fields(path):
    """One full pass on first sight of a large transcript, for title/prompt lines only."""
    title = prompt = None
    with open(path, "rb") as fh:
        for raw in fh:
            if b'"ai-title"' not in raw and b'"custom-title"' not in raw and b'"last-prompt"' not in raw:
                continue
            try:
                d = json.loads(raw.decode("utf-8", "ignore"))
            except ValueError:
                continue
            title = d.get("customTitle") or d.get("aiTitle") or title
            prompt = d.get("lastPrompt") or prompt
    return title, prompt


def parse_transcript(path):
    """Pull the session title and last prompt (label fallback) from the transcript tail."""
    st = os.stat(path)
    cached = _transcript_cache.get(path)
    if cached and cached[0] == st.st_mtime and cached[1] == st.st_size:
        return cached[2]
    out = {"mtime": st.st_mtime, "title": None, "lastPrompt": None}
    if cached:
        # values that may now sit before the tail window carry over
        for k in ("title", "lastPrompt"):
            out[k] = cached[2][k]
    elif st.st_size > TAIL_BYTES:
        out["title"], out["lastPrompt"] = _scan_head_fields(path)
    with open(path, "rb") as fh:
        if st.st_size > TAIL_BYTES:
            fh.seek(st.st_size - TAIL_BYTES)
            fh.readline()  # drop the partial first line
        lines = fh.read().decode("utf-8", "ignore").splitlines()
    for line in lines:
        try:
            d = json.loads(line)
        except ValueError:
            continue
        typ = d.get("type")
        if typ == "ai-title":
            out["title"] = d.get("aiTitle") or out["title"]
        elif typ == "custom-title":
            out["title"] = d.get("customTitle") or out["title"]
        elif typ == "last-prompt":
            out["lastPrompt"] = d.get("lastPrompt") or out["lastPrompt"]
    if out["lastPrompt"] and len(out["lastPrompt"]) > 120:
        out["lastPrompt"] = out["lastPrompt"][:120] + "…"
    _transcript_cache[path] = (st.st_mtime, st.st_size, out)
    return out


def read_plan(session_id):
    """Raw plan events written by the /follow skill (P1). Absent until then."""
    path = os.path.join(FOLLOW_DIR, session_id, "events.jsonl")
    try:
        st = os.stat(path)
    except OSError:
        return None
    cached = _plan_cache.get(path)
    if cached and cached[0] == st.st_mtime and cached[1] == st.st_size:
        return cached[2]
    events = []
    with open(path, encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            try:
                events.append(json.loads(line))
            except ValueError:
                continue
    _plan_cache[path] = (st.st_mtime, st.st_size, events)
    return events


def _liveliness(reg):
    """Sort key: an active process beats an idle one, then the most recently updated wins."""
    active = reg.get("status") in ("busy", "waiting")
    return (active, reg.get("statusUpdatedAt") or 0, reg.get("updatedAt") or 0)


def collect():
    # A resumed session can run in a second process under the same sessionId;
    # keep one entry per session so the dashboard shows it once.
    by_id = {}
    for f in glob.glob(os.path.join(SESSIONS_DIR, "*.json")):
        try:
            with open(f, encoding="utf-8") as fh:
                reg = json.load(fh)
        except Exception:
            continue
        if not isinstance(reg, dict) or "sessionId" not in reg or not pid_alive(reg.get("pid", -1)):
            continue
        cur = by_id.get(reg["sessionId"])
        if cur is None or _liveliness(reg) > _liveliness(cur):
            by_id[reg["sessionId"]] = reg
    sessions = []
    for reg in by_id.values():
        s = {k: reg.get(k) for k in REGISTRY_KEYS}
        tpath = find_transcript(reg["sessionId"])
        if tpath:
            try:
                s.update(parse_transcript(tpath))
            except OSError:
                pass
        s["plan"] = read_plan(reg["sessionId"])
        sessions.append(s)
    sessions.sort(key=lambda s: s.get("startedAt") or 0)
    return sessions


def emit(obj):
    # bytes, so a remote shell without a UTF-8 locale (or a Windows code page) cannot break it
    sys.stdout.buffer.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
    sys.stdout.flush()


def main():
    host = socket.gethostname()
    if "--once" in sys.argv:
        emit({"type": "snapshot", "host": host, "t": time.time(), "sessions": collect()})
        return
    last, last_out = None, 0.0
    while True:
        now = time.time()
        try:
            sessions = collect()
            key = json.dumps(sessions, sort_keys=True, ensure_ascii=False)
            if key != last:
                last, last_out = key, now
                emit({"type": "snapshot", "host": host, "t": now, "sessions": sessions})
            elif now - last_out >= PING_EVERY:
                last_out = now
                emit({"type": "ping", "host": host, "t": now})
        except BrokenPipeError:
            return
        except Exception as e:  # keep streaming; report instead of dying
            emit({"type": "error", "host": host, "t": now, "error": repr(e)})
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
