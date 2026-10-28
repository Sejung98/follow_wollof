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
import re
import socket
import sys
import time

HOME = os.path.expanduser("~")
SESSIONS_DIR = os.path.join(HOME, ".claude", "sessions")
PROJECTS_DIR = os.path.join(HOME, ".claude", "projects")
FOLLOW_DIR = os.path.join(HOME, ".follow_wollof", "sessions")
INTERVAL = float(sys.argv[sys.argv.index("--interval") + 1]) if "--interval" in sys.argv else 2.0
PING_EVERY = 20.0
ENDED_DAYS = 7  # sessions that closed this recently stay on the board (ontology links) as "ended"
# Remote Control / routine sessions (entrypoint sdk-cli) keep their process after the work is done;
# idle this long, they are treated as closed
SDK_IDLE_HOURS = 6
TAIL_BYTES = 256 * 1024
REGISTRY_KEYS = ("pid", "sessionId", "cwd", "name", "nameSource", "status", "waitingFor", "kind",
                 "entrypoint", "startedAt", "updatedAt", "statusUpdatedAt", "version")

# the analysis folder a session is writing in: the latest daily_analysis/<date>/<slug> its transcript mentions
WORK_RE = re.compile(r'((?:[A-Za-z]:)?/[^"\s\\]*?/daily_analysis/\d{4}-\d{2}-\d{2}/[A-Za-z0-9_.\-]+)')
# data a session touched: paths in its transcript that pass through a data folder (00_raw_data/…, 02_data/…, _cohort/…),
# cut to the dataset folder right below that data folder
DATA_PATH_RE = re.compile(r'(?:(?:[A-Za-z]:)?/[^\s"\'`<>|;,()\[\]{}\\]*?/|(?<![\w./-]))(?:\d+[_-]?)?(?:raw[_-]?data|rawdata|data|datasets?|_?cohorts?)/[^\s"\'`<>|;,()\[\]{}\\/]+')
WORK_EXT = ("r", "py", "sh", "ipynb", "rmd", "qmd", "nf", "smk", "tsv", "csv", "txt", "xlsx", "rds", "parquet", "json",
            "png", "svg", "pdf", "jpg", "md", "html", "h5ad", "vcf")
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
    """One full pass on first sight of a large transcript, for the title, last prompt and the user's requests."""
    title = prompt = None
    asks = []
    with open(path, "rb") as fh:
        for raw in fh:
            ask = b'"type":"user"' in raw and b'"tool_result"' not in raw
            if not ask and b'"ai-title"' not in raw and b'"custom-title"' not in raw and b'"last-prompt"' not in raw:
                continue
            try:
                d = json.loads(raw.decode("utf-8", "ignore"))
            except ValueError:
                continue
            title = d.get("customTitle") or d.get("aiTitle") or title
            prompt = d.get("lastPrompt") or prompt
            text = ask and not d.get("isMeta") and user_text((d.get("message") or {}).get("content"))
            if text:
                asks.append({"t": text, "at": d.get("timestamp")})
    return title, prompt, asks[-8:]


def merge_asks(old, new):
    seen, out = set(), []
    for a in old + new:
        if (a.get("at"), a["t"]) not in seen:
            seen.add((a.get("at"), a["t"]))
            out.append(a)
    return out[-8:]


def parse_transcript(path):
    """Pull the session title and last prompt (label fallback) from the transcript tail."""
    st = os.stat(path)
    cached = _transcript_cache.get(path)
    if cached and cached[0] == st.st_mtime and cached[1] == st.st_size:
        return cached[2]
    out = {"mtime": st.st_mtime, "title": None, "lastPrompt": None, "workDir": None, "dataRefs": [], "todos": [], "agents": [], "asks": []}
    if cached:
        # values that may now sit before the tail window carry over
        for k in ("title", "lastPrompt", "workDir", "dataRefs", "todos", "agents", "asks"):
            out[k] = cached[2][k]
    elif st.st_size > TAIL_BYTES:
        out["title"], out["lastPrompt"], out["asks"] = _scan_head_fields(path)
    with open(path, "rb") as fh:
        if st.st_size > TAIL_BYTES:
            fh.seek(st.st_size - TAIL_BYTES)
            fh.readline()  # drop the partial first line
        lines = fh.read().decode("utf-8", "ignore").splitlines()
    tail = "\n".join(lines)
    tasks, agents, asks = [], {}, []
    for m in WORK_RE.finditer(tail):
        if "/./" not in m.group(1) and "/../" not in m.group(1) and not m.group(1).startswith(("/.", "/..")):
            out["workDir"] = m.group(1)
    refs = dict(out["dataRefs"])
    for m in DATA_PATH_RE.finditer(tail):
        p = m.group(0)
        if "daily_analysis/" not in p and "/." not in p:
            refs[p] = refs.get(p, 0) + 1
    out["dataRefs"] = sorted(refs.items(), key=lambda x: -x[1])[:30]
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
        content = (d.get("message") or {}).get("content") if isinstance(d.get("message"), dict) else None
        ask = typ == "user" and not d.get("isMeta") and user_text(content)
        if ask:   # each request the user typed is one piece of work, in order
            asks.append({"t": ask, "at": d.get("timestamp")})
        for c in content if isinstance(content, list) else []:
            if isinstance(c, dict) and c.get("type") == "tool_use":
                work_item(out, tasks, agents, c)
            elif isinstance(c, dict) and c.get("type") == "tool_result" and c.get("tool_use_id") in agents:
                text = json.dumps(c.get("content"), ensure_ascii=False)[:400].lower()
                agents[c["tool_use_id"]]["s"] = "now" if any(w in text for w in ("async", "background", "launched")) else "done"
    if tasks:
        out["todos"] = [t for t in tasks if t["s"] != "deleted"][:30]
    if agents:
        out["agents"] = list(agents.values())[-8:]
    if asks:
        out["asks"] = merge_asks(out["asks"], asks)
    if out["lastPrompt"] and len(out["lastPrompt"]) > 120:
        out["lastPrompt"] = out["lastPrompt"][:120] + "…"
    _transcript_cache[path] = (st.st_mtime, st.st_size, out)
    return out


def user_text(content):
    """The words of a message the user typed: no tool results, commands, interruptions or system notes."""
    if isinstance(content, list):
        if any(isinstance(c, dict) and c.get("type") == "tool_result" for c in content):
            return None
        content = " ".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
    text = re.sub(r"<(system-reminder|ide_[a-z_]+|local-command-[a-z]+|command-[a-z]+)>.*?</\1>", "", str(content or ""), flags=re.S).strip()
    text = re.sub(r"^\[Request interrupted[^\]]*\]\s*", "", text).strip()
    if not text or text.startswith(("<", "Caveat:", "Stop hook feedback")):
        return None
    line = next((l.strip() for l in text.splitlines() if l.strip()), "")
    return line[:120] + ("…" if len(line) > 120 else "")


def work_item(out, tasks, agents, c):
    """What the session is doing, from Claude Code's own records: its to-do list (TodoWrite, or TaskCreate and
    TaskUpdate in newer versions) and the subagents it started (Agent). Status: done, now or left."""
    name, inp = c.get("name"), c.get("input") or {}
    state = {"completed": "done", "in_progress": "now", "pending": "left"}
    if name == "TodoWrite" and isinstance(inp.get("todos"), list):
        out["todos"] = [{"t": str(x.get("content") or x.get("activeForm") or "")[:120], "s": state.get(x.get("status"), "left")}
                        for x in inp["todos"] if isinstance(x, dict)][:30]
    elif name == "TaskCreate" and (inp.get("subject") or inp.get("description")):
        tasks.append({"t": str(inp.get("subject") or inp.get("description"))[:120], "s": "left"})
    elif name == "TaskUpdate":
        try:
            t = tasks[int(str(inp.get("taskId")).lstrip("#")) - 1]   # task ids count up from 1 in each session
        except (ValueError, IndexError):
            return
        t["s"] = "deleted" if inp.get("status") == "deleted" else state.get(inp.get("status"), t["s"])
        t["t"] = str(inp.get("subject") or t["t"])[:120]
    elif name in ("Agent", "Task") and inp.get("description"):
        agents[c.get("id")] = {"t": str(inp["description"])[:100], "s": "now"}


def work_files(path, limit=300):
    """[[relative path, size, mtime]] of the analysis folder a live session is writing, so the page can show
    scripts, tables and figures appearing as they are made."""
    out = []
    for base, dirs, files in os.walk(path):
        dirs[:] = sorted(d for d in dirs if not d.startswith((".", "__")))
        if base[len(path):].count(os.sep) >= 3:
            dirs[:] = []
        for f in sorted(files):
            if f.startswith(".") or f.rsplit(".", 1)[-1].lower() not in WORK_EXT:
                continue
            full = os.path.join(base, f)
            try:
                st = os.stat(full)
            except OSError:
                continue
            out.append([os.path.relpath(full, path).replace(os.sep, "/"), st.st_size, int(st.st_mtime)])
            if len(out) >= limit:
                return out
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
    idle_cutoff = (time.time() - SDK_IDLE_HOURS * 3600) * 1000
    for f in glob.glob(os.path.join(SESSIONS_DIR, "*.json")):
        try:
            with open(f, encoding="utf-8") as fh:
                reg = json.load(fh)
        except Exception:
            continue
        if not isinstance(reg, dict) or "sessionId" not in reg or not pid_alive(reg.get("pid", -1)):
            continue
        if (reg.get("entrypoint") == "sdk-cli" and reg.get("status") == "idle"
                and (reg.get("statusUpdatedAt") or 0) < idle_cutoff):
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
        if s.get("workDir") and os.path.isdir(s["workDir"]):
            s["work"] = work_files(s["workDir"])
        sessions.append(s)
    cutoff = time.time() - ENDED_DAYS * 86400
    for path in glob.glob(os.path.join(FOLLOW_DIR, "*", "events.jsonl")):
        sid = os.path.basename(os.path.dirname(path))
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        if sid in by_id or mtime < cutoff:
            continue
        s = {k: None for k in REGISTRY_KEYS}
        s.update(sessionId=sid, status="ended", updatedAt=int(mtime * 1000))
        tpath = find_transcript(sid)
        if tpath:
            try:
                s.update(parse_transcript(tpath))
            except OSError:
                pass
        s["plan"] = read_plan(sid)
        s["cwd"] = next((e.get("cwd") for e in s["plan"] or [] if e.get("cwd")), None)
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
