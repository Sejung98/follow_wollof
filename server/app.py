#!/usr/bin/env python3
"""follow_wollof central server: one agent stream per host, merged state pushed to the web board.

    python3 server/app.py          (normally started by `fw`)
Hosts and port come from config.ini (see config.example.ini). Stdlib only; macOS, Linux, Windows.
"""
import atexit
import base64
import collections
import glob
import json
import os
import queue
import re
import shlex
import shutil
import socket
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402
import notify  # noqa: E402

ROOT = config.ROOT
AGENT = os.path.join(ROOT, "agent", "agent.py")
INVENTORY = os.path.join(ROOT, "agent", "inventory.py")
TODO = os.path.join(ROOT, "agent", "todo.py")
MAX_BODY = 256 * 1024
INVENTORY_CACHE = os.path.join(config.STATE_DIR, "inventory.json")
WEB = os.path.join(ROOT, "web")
# no console window per ssh child when the server runs windowless (pythonw) on Windows
NO_WINDOW = {"creationflags": 0x08000000} if config.IS_WINDOWS else {}
STALE_AFTER = 60  # seconds without any line before a host is shown as disconnected
MAX_FILE = 80 * 1024 * 1024  # largest step output the viewer will fetch
FILE_TYPES = {"pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
              "webp": "image/webp", "svg": "image/svg+xml", "html": "text/html", "htm": "text/html",
              "txt": "text/plain", "md": "text/plain", "csv": "text/plain", "tsv": "text/plain", "log": "text/plain",
              "json": "text/plain", "tex": "text/plain"}


def _norm(path):
    """Compare folders the way the host does: Windows paths ignore case and slash direction."""
    p = str(path or "").replace("\\", "/").rstrip("/")
    return p.lower() if len(p) > 1 and p[1] == ":" else p


def project_of(projects, host, s):
    """The configured project whose folder holds the session: the folder the plan was made in first, then the
    folder Claude was started in. The longest matching folder wins."""
    plan_cwd = next((e.get("cwd") for e in s.get("plan") or [] if e.get("cwd")), None)
    for cwd in (plan_cwd, s.get("cwd")):
        if not cwd:
            continue
        c, best = _norm(cwd), (0, None)
        for p in projects:
            for f in p["folders"].get(host, []):
                f = _norm(f)
                if (c == f or c.startswith(f + "/")) and len(f) > best[0]:
                    best = (len(f), p["name"])
        if best[1]:
            return best[1]
    return None


class State:
    def __init__(self, hosts, projects=None):
        self.lock = threading.Lock()
        self.hosts = {h["name"]: {"name": h["name"], "type": h.get("type", "ssh"), "connected": False, "lastSeen": None,
                                  "error": None, "hostname": None, "sessions": []}
                      for h in hosts}
        self.order = [h["name"] for h in hosts]
        self.subscribers = set()
        self.projects = projects or []
        self.inventory = {}   # host -> {"t", "error", "running", "folders": {folder: scan}}
        self.inventory_view = {}   # the same, with older reports cut to what the page shows
        self.todo = {}        # {"host", "t", "error", "next", "items"} of the questions and to-dos page

    def update(self, name, **fields):
        with self.lock:
            self.hosts[name].update(fields)
        self.broadcast()

    def snapshot(self):
        with self.lock:
            now = time.time()
            hosts = []
            for n in self.order:
                h = dict(self.hosts[n])
                if h["lastSeen"] and now - h["lastSeen"] > STALE_AFTER:
                    h["connected"] = False
                if self.projects:
                    h["sessions"] = [dict(s, mainProject=project_of(self.projects, n, s)) for s in h["sessions"]]
                hosts.append(h)
            return {"t": now, "hosts": hosts, "projects": self.projects, "inventory": self.inventory_view, "todo": self.todo}

    def set_todo(self, **fields):
        with self.lock:
            self.todo = dict(self.todo, **fields)
        self.broadcast()

    def set_inventory(self, host, **fields):
        with self.lock:
            self.inventory[host] = dict(self.inventory.get(host) or {"folders": {}}, **fields)
            self.inventory_view[host] = trim_scan(self.inventory[host])
        self.broadcast()

    def is_output(self, host, path):
        """Only files a session recorded with `follow.py out`, and the meeting notes the data scan listed, can be
        fetched: the viewer is not a file browser."""
        with self.lock:
            h = self.hosts.get(host)
            if bool(h) and any(e.get("op") == "out" and any(f.get("path") == path for f in e.get("files", []))
                               for s in h["sessions"] for e in (s.get("plan") or [])):
                return True
            return any(n.get("path") == path for r in ((self.inventory.get(host) or {}).get("folders") or {}).values()
                       for n in (r or {}).get("notes") or [])

    def broadcast(self):
        data = json.dumps(self.snapshot(), ensure_ascii=False)
        for q in list(self.subscribers):
            try:
                q.put_nowait(data)
            except queue.Full:
                pass


def agent_command(cfg, host):
    interval = ["--interval", str(cfg["interval"])]
    if host["type"] == "local":
        return [host["python"], "-u", AGENT, "--stream"] + interval, None
    remote = "nice -n 10 %s -u - --stream --interval %s" % (host["python"], cfg["interval"])
    return ["ssh"] + cfg["ssh_options"] + [host["ssh"], remote], AGENT


def drain(stream, tail):
    """Keep reading stderr so a chatty ssh can never fill the pipe and stall the stream."""
    for raw in stream:
        line = raw.decode("utf-8", "ignore").strip()
        if line and not line.startswith("**"):  # skip OpenSSH post-quantum notices
            tail.append(line)


def run_host(state, cfg, host, watcher=None):
    """Keep one agent stream alive for this host, reconnecting with backoff."""
    name, backoff = host["name"], 2
    while True:
        cmd, stdin_file = agent_command(cfg, host)
        try:
            stdin = open(stdin_file, "rb") if stdin_file else subprocess.DEVNULL
            proc = subprocess.Popen(cmd, stdin=stdin, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, **NO_WINDOW)
            tail = collections.deque(maxlen=5)
            threading.Thread(target=drain, args=(proc.stderr, tail), daemon=True).start()
            for raw in proc.stdout:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                backoff = 2
                fields = {"connected": True, "lastSeen": time.time(), "hostname": msg.get("host")}
                if msg.get("type") == "snapshot":
                    fields.update(sessions=msg["sessions"], error=None)
                    if watcher:
                        watcher.update(name, msg["sessions"])
                elif msg.get("type") == "error":
                    fields["error"] = msg.get("error")
                state.update(name, **fields)
            proc.wait()
            time.sleep(0.2)
            reason = tail[-1] if tail else "stream ended (exit %s)" % proc.returncode
        except Exception as e:
            reason = repr(e)
        state.update(name, connected=False, error=reason)
        time.sleep(backoff)
        backoff = min(backoff * 2, 60)


def inventory_requests(cfg, host):
    return [{"folder": f, "data": p["data"]} for p in cfg["projects"] for f in p["folders"].get(host["name"], [])]


def run_inventory(cfg, host):
    """One scan of this host's project folders (agent/inventory.py, sent over ssh like the agent)."""
    arg = base64.b64encode(json.dumps(inventory_requests(cfg, host)).encode("utf-8")).decode("ascii")
    if host["type"] == "local":
        cmd, stdin = [host["python"], INVENTORY, arg], None
    else:
        with open(INVENTORY, "rb") as fh:
            stdin = fh.read()
        cmd = ["ssh"] + cfg["ssh_options"] + [host["ssh"], "nice -n 10 %s - %s" % (host["python"], arg)]
    r = subprocess.run(cmd, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300, **NO_WINDOW)
    if r.returncode:
        lines = [l for l in r.stderr.decode("utf-8", "ignore").splitlines() if l.strip() and not l.startswith("**")]
        raise OSError(lines[-1] if lines else "exit %d" % r.returncode)
    return json.loads(r.stdout.decode("utf-8"))


def inventory_loop(state, cfg, host, wake, notes=None):
    """Rescan every [projects] inventory_minutes, or at once when the page asks; keep the last good scan on disk."""
    if not inventory_requests(cfg, host):
        return
    time.sleep(3)
    while True:
        state.set_inventory(host["name"], running=True)
        try:
            out = run_inventory(cfg, host)
            state.set_inventory(host["name"], running=False, error=None, t=out["t"], folders=out["folders"])
            save_inventory(state)
            if notes:
                notes.set()
        except Exception as e:
            state.set_inventory(host["name"], running=False, error=str(e) or repr(e), tried=time.time())
        wake.wait(max(60, cfg["inventory_minutes"] * 60))
        wake.clear()


def run_todo(cfg, op):
    """One read or change of the questions and to-dos list on its host (agent/todo.py, sent like the agent)."""
    host = next(h for h in cfg["hosts"] if h["name"] == cfg["todo"]["host"])
    arg = base64.b64encode(json.dumps(dict(op, path=cfg["todo"]["path"]), ensure_ascii=False).encode("utf-8")).decode("ascii")
    if host["type"] == "local":
        cmd, stdin = [host["python"], TODO, arg], None
    else:
        with open(TODO, "rb") as fh:
            stdin = fh.read()
        cmd = ["ssh"] + cfg["ssh_options"] + [host["ssh"], "%s - %s" % (host["python"], arg)]
    r = subprocess.run(cmd, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, **NO_WINDOW)
    if r.returncode:
        lines = [l for l in r.stderr.decode("utf-8", "ignore").splitlines() if l.strip() and not l.startswith("**")]
        raise OSError(lines[-1] if lines else "exit %d" % r.returncode)
    return json.loads(r.stdout.decode("utf-8"))


def todo_loop(state, cfg, notes):
    """Pick up changes made from the other desktop once a minute; pull new meeting notes in when the data scan
    has seen them (notes is set after each scan, or by the page)."""
    while True:
        try:
            db = run_todo(cfg, {"do": "get"})
            state.set_todo(error=None, t=time.time(), **db)
            if notes.is_set():   # a new data scan: new notes to read, new reports to check items against
                notes.clear()
                if cfg["todo"]["import"]:
                    import_notes(state, cfg)
                review_imported(state, cfg)
        except Exception as e:
            state.set_todo(error=str(e) or repr(e))
        notes.wait(60)


def claude_cli(cfg):
    if cfg["todo"]["claude"]:
        return cfg["todo"]["claude"]
    home = os.path.expanduser("~")
    for c in (shutil.which("claude"), os.path.join(home, ".local", "bin", "claude"), os.path.join(home, ".local", "bin", "claude.exe"),
              os.path.join(home, ".claude", "local", "claude"), os.path.join(os.environ.get("APPDATA", ""), "npm", "claude.cmd")):
        if c and os.path.isfile(c):
            return c
    # Only the editor extension installed (Antigravity, VS Code, Cursor): its bundled binary, newest first
    bundled = [p for d in (".antigravity", ".vscode", ".cursor") for n in ("claude", "claude.exe")
               for p in glob.glob(os.path.join(home, d, "extensions", "anthropic.claude-code-*", "resources", "native-binary", n))]
    return max(bundled, key=os.path.getmtime) if bundled else None


def split_memo(text):
    """Without Claude: one item per line or bullet; a line ending in ? is a question."""
    items = []
    for line in text.splitlines():
        line = re.sub(r"^\s*([-*•]|\d+[.)]|\[[ xX]?\])\s*", "", line).strip()
        if line:
            items.append({"text": line, "kind": "question" if line.rstrip().endswith(("?", "？")) else "todo"})
    return items


def claude_json(cfg, prompt, system, model=None):
    """One small Claude call that must answer with a JSON array (see classify for the flags)."""
    exe = claude_cli(cfg) if cfg["todo"]["classify"] == "claude" else None
    if not exe:
        raise OSError("Claude 를 쓰지 않음 ([todo] classify)")
    r = subprocess.run([exe, "-p", "--model", model or cfg["todo"]["model"], "--output-format", "json", "--tools", "", "--strict-mcp-config",
                        "--disable-slash-commands", "--no-session-persistence", "--setting-sources", "", "--system-prompt", system],
                       input=prompt.encode("utf-8"), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180,
                       cwd=config.STATE_DIR, **NO_WINDOW)
    out = json.loads(r.stdout.decode("utf-8")).get("result") or ""
    return json.loads(out[out.index("["):out.rindex("]") + 1])


def read_note(cfg, host, path, limit=40000):
    if host["type"] == "local":
        with open(path, encoding="utf-8", errors="ignore") as fh:
            return fh.read(limit)
    r = subprocess.run(["ssh"] + cfg["ssh_options"] + [host["ssh"], "head -c %d -- %s" % (limit * 3, shlex.quote(path))],
                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, **NO_WINDOW)
    if r.returncode:
        raise OSError(r.stderr.decode("utf-8", "ignore").strip().splitlines()[-1:] or "ssh exit %d" % r.returncode)
    return r.stdout.decode("utf-8", "ignore")[:limit]


def note_items(cfg, state, project, note, text):
    """What a meeting note leaves to do: agreed next steps, requests and instructions, questions left open."""
    snap = state.snapshot()
    mine = [it for it in snap["todo"].get("items", []) if it.get("project") == project]
    themes = sorted({it["theme"] for it in mine if it.get("theme")})
    prompt = ("아래는 '%s' 프로젝트의 회의록·코멘트·메모 '%s'(%s) 이다. 여기서 아직 남아 있는 것만 뽑는다:\n"
              "회의에서 합의한 다음 작업, 교수님·참석자의 지시나 요청, 답이 나오지 않은 질문.\n"
              "끝났다고 적힌 것, 이미 알려진 사실, 단순한 결과 요약은 뽑지 않는다. 한 메모에서 많아야 8개.\n"
              "각 항목은 원문의 뜻 그대로 한 문장으로 짧게. 질문이면 question, 할 일이면 todo.\n"
              "테마는 기존 테마 중 맞는 것을 글자 그대로 쓰고, 없으면 2~6 단어의 새 테마.\n"
              "기존 테마: %s\n이미 있는 항목(같은 것은 다시 뽑지 않는다):\n%s\n\n메모:\n\"\"\"\n%s\n\"\"\"\n\n"
              'JSON 배열만 출력한다: [{"text": "...", "kind": "question|todo", "theme": "..."}]. 남은 것이 없으면 [].'
              % (project, note["title"], note["date"], ", ".join(themes) or "없음",
                 "\n".join("- " + it["text"][:120] for it in mine[-60:]) or "없음", text))
    items = claude_json(cfg, prompt, "너는 연구 회의록에서 남은 할 일과 질문을 뽑는 도구다. 요청한 JSON 만 출력한다.")
    return [it for it in items if isinstance(it, dict) and it.get("text")][:8]


def tracker_items(cfg, project, note, host):
    """A feedback tracker is already a list: keep its status and the analyses each line points to; a theme from Claude."""
    rows = note["tracker"]
    themes = [r["section"] for r in rows]
    try:
        got = claude_json(cfg, "'%s' 프로젝트의 요청 목록이다. 각 줄에 2~6 단어의 주제(테마)를 붙인다. 비슷한 것은 같은 테마로.\n%s\n\n"
                               "줄 순서대로 JSON 문자열 배열만 출력한다." % (project, "\n".join("%d. %s" % (i + 1, r["text"][:160]) for i, r in enumerate(rows))),
                          "너는 요청 목록에 주제를 붙이는 도구다. JSON 만 출력한다.")
        if len(got) == len(rows):
            themes = [str(t)[:60] for t in got]
    except Exception:
        pass
    return [{"text": r["text"], "kind": "todo", "theme": themes[i], "ref": r["ref"], "done": r["status"] in ("반영함", "접음"),
             "links": ["r:%s:%s" % (host, l) for l in r["links"]]} for i, r in enumerate(rows)]


REVIEWING = threading.Lock()


def review_imported(state, cfg):
    """Mark items taken from meeting notes as done when a later analysis report clearly dealt with them, with that
    report as the evidence. Each item is asked about again only when a newer report has appeared since."""
    if cfg["todo"]["classify"] != "claude" or not REVIEWING.acquire(blocking=False):   # one run at a time
        return 0
    try:
        return _review(state, cfg)
    finally:
        REVIEWING.release()


def _review(state, cfg):
    snap = dict(state.snapshot(), inventory=state.inventory)
    items = [it for it in snap["todo"].get("items", []) if it.get("source") and not it.get("done") and not it.get("ref")]
    marked = 0
    state.set_todo(reviewing={"running": True, "t": time.time()})
    for p in cfg["projects"]:
        reports = []
        for host, folders in p["folders"].items():
            for f in folders:
                for r in ((snap["inventory"].get(host) or {}).get("folders", {}).get(f) or {}).get("reports") or []:
                    reports.append(dict(r, host=host, id="r:%s:%s" % (host, r["path"])))
        reports.sort(key=lambda r: r["date"], reverse=True)
        reports = reports[:150]
        for host, folders in p["folders"].items():   # the question log: a question tested or closed there has been dealt with
            for f in folders:
                for q in ((snap["inventory"].get(host) or {}).get("folders", {}).get(f) or {}).get("questions") or []:
                    if q.get("status") == "closed" or re.match(r"[1-9]", q.get("tests") or ""):
                        reports.append({"id": "q:%s:%s" % (p["name"], q["id"]), "date": q.get("updated") or "",
                                        "title": "질문 기록 %s: %s" % (q["id"], q["text"]), "slug": q["id"],
                                        "why": None, "checks": [{"text": "상태 %s · 검정 %s" % (q.get("status"), q.get("tests")), "verdict": q.get("verdict") or "미결"}]})
        if not reports:
            continue
        newest = "%s/%d" % (max(r["date"] for r in reports), len(reports))   # asked again when this changes
        todo = [it for it in items if it.get("project") == p["name"] and (it.get("reviewed") or "") != newest]
        for chunk in [todo[i:i + 60] for i in range(0, len(todo), 60)]:
            rep_lines = "\n".join("[%d] %s · %s%s%s" % (i, r["date"], (r.get("title") or r["slug"])[:140],
                                    " · 질문: " + r["why"][:120] if r.get("why") else "",
                                    " · 판정: " + "; ".join(c["text"][:50] + "→" + c["verdict"] for c in (r.get("checks") or [])[:6]) if r.get("checks") else "")
                                   for i, r in enumerate(reports))
            item_lines = "\n".join("%s · %s · %s" % (it["id"], (it.get("source") or {}).get("date") or "", it["text"][:160]) for it in chunk)
            prompt = ("'%s' 프로젝트의 회의·메모에서 나온 할 일과 질문 목록, 그리고 그 뒤의 분석 보고서와 질문 기록(검정 횟수·판정) 목록이다.\n"
                      "각 항목이 메모 날짜 이후의 보고서나, 이미 검정된 질문 기록으로 실제로 처리(실행됐거나 답이 나옴)됐는지 판단한다.\n"
                      "보고서 제목·질문·판정으로 분명히 확인되는 것만 고른다. 비슷한 주제일 뿐이면 고르지 않는다.\n\n"
                      "보고서:\n%s\n\n항목:\n%s\n\n"
                      'JSON 배열만 출력한다: [{"id": "Q-0001", "report": 보고서 번호, "reason": "한 문장"}]. 처리된 것이 없으면 [].'
                      % (p["name"], rep_lines, item_lines))
            try:
                got = claude_json(cfg, prompt, "너는 연구 할 일이 이후 분석 보고서로 처리됐는지 판정하는 도구다. 요청한 JSON 만 출력한다.",
                                  cfg["todo"]["judge_model"])
            except Exception as e:
                sys.stderr.write("review %s: %r\n" % (p["name"], e))
                continue
            done = {}
            for g in got if isinstance(got, list) else []:
                try:
                    r = reports[int(g.get("report"))]
                except (TypeError, ValueError, IndexError):
                    continue
                it = next((x for x in chunk if x["id"] == g.get("id")), None)
                if it and (r["id"].startswith("q:") or r["date"] >= ((it.get("source") or {}).get("date") or "")):
                    done[it["id"]] = (r, str(g.get("reason") or "")[:200])
            ops = []
            for it in chunk:
                if it["id"] in done:
                    r, why = done[it["id"]]
                    ops.append({"do": "update", "id": it["id"], "set": {"done": True, "reviewed": newest,
                                "links": list(dict.fromkeys((it.get("links") or []) + [r["id"]])),
                                "evidence": {"id": r["id"], "title": r.get("title") or r["slug"], "date": r["date"], "why": why}}})
                else:
                    ops.append({"do": "update", "id": it["id"], "set": {"reviewed": newest}})
            try:
                db = run_todo(cfg, {"do": "batch", "ops": ops})
                state.set_todo(error=None, t=time.time(), **db)
                marked += len(done)
            except Exception as e:
                sys.stderr.write("review write: %r\n" % e)
    state.set_todo(reviewing={"running": False, "t": time.time(), "marked": marked})
    return marked


def import_notes(state, cfg, limit=40):
    """Bring what each project's meeting notes ask for onto the questions page, newest notes first. A note is read
    again only when it changes; the list host remembers which versions are in, so the other desktop skips them."""
    snap = state.snapshot()
    done = (snap["todo"] or {}).get("sources") or {}
    hosts = {h["name"]: h for h in cfg["hosts"]}
    jobs = []
    for p in cfg["projects"]:
        for host, folders in p["folders"].items():
            for f in folders:
                notes = ((snap["inventory"].get(host) or {}).get("folders", {}).get(f) or {}).get("notes") or []
                tracked = [os.path.dirname(n["rel"]) for n in notes if n.get("tracker")]
                for n in notes:
                    if not n.get("tracker") and any(t and n["rel"].startswith(t + "/") for t in tracked):
                        continue   # the tracker next to these minutes already lists what they asked for
                    key = "%s:%s" % (p["name"], n["rel"])
                    if done.get(key) != n["mtime"]:
                        jobs.append((n["date"], p["name"], host, n, key))
    jobs.sort(key=lambda j: j[0], reverse=True)
    state.set_todo(importing={"pending": len(jobs), "t": time.time()})
    count = 0
    for _, project, host, note, key in jobs[:limit]:
        try:
            if note.get("tracker"):
                items = tracker_items(cfg, project, note, host)
            elif cfg["todo"]["classify"] == "claude":
                items = note_items(cfg, state, project, note, read_note(cfg, hosts[host], note["path"]))
            else:
                continue
            db = run_todo(cfg, {"do": "import", "by": socket.gethostname(), "items": items,
                                "source": {"key": key, "version": note["mtime"], "project": project, "title": note["title"],
                                           "date": note["date"], "path": note["path"], "host": host}})
            count += 1
            state.set_todo(error=None, t=time.time(), importing={"pending": len(jobs) - count, "t": time.time()}, **db)
        except Exception as e:
            sys.stderr.write("import %s: %r\n" % (key, e))
    state.set_todo(importing={"pending": max(0, len(jobs) - count), "t": time.time(), "last": time.time()})


def classify(cfg, state, text):
    """Split a memo into questions and to-dos and file each under a project and theme, with the Claude Code on this
    computer (a small model, no tools, no settings: about a tenth of a cent). Falls back to one item per line."""
    exe = claude_cli(cfg) if cfg["todo"]["classify"] == "claude" else None
    if not exe:
        return split_memo(text), None
    snap = state.snapshot()
    themes = {}
    for it in snap["todo"].get("items", []):
        if it.get("project") and it.get("theme"):
            themes.setdefault(it["project"], set()).add(it["theme"])
    lines = []
    for p in snap["projects"]:
        cats, reps = [], []
        for host, folders in p["folders"].items():
            for f in folders:
                r = (snap["inventory"].get(host) or {}).get("folders", {}).get(f) or {}
                cats += [c["name"] for c in sorted(r.get("data") or [], key=lambda c: -c["bytes"])[:6]]
                reps += [x.get("title") or x["slug"] for x in (r.get("reports") or [])[:4]]
        lines.append("- %s | 테마: %s | 데이터: %s | 최근 분석: %s" % (p["name"], ", ".join(sorted(themes.get(p["name"], []))) or "없음",
                                                                ", ".join(cats[:8]) or "-", " / ".join(x[:60] for x in reps[:4]) or "-"))
    prompt = ("연구자가 회의나 공부 중에 남긴 메모를 정리한다. 메모를 항목으로 나눈다. 알아내야 할 것은 question, 해야 할 작업은 todo.\n"
              "각 항목은 원문의 뜻을 바꾸지 말고 한 문장으로 짧게 쓴다. 각 항목을 아래 프로젝트 중 하나에 넣고 그 안의 테마를 고른다.\n"
              "맞는 기존 테마가 있으면 글자 그대로 쓰고, 없으면 2~6 단어의 새 테마를 만든다. 어느 프로젝트에도 맞지 않으면 project 는 null.\n\n"
              "프로젝트:\n%s\n\n메모:\n\"\"\"\n%s\n\"\"\"\n\n"
              'JSON 배열만 출력한다: [{"text": "...", "kind": "question|todo", "project": "프로젝트 이름 또는 null", "theme": "..."}]'
              % ("\n".join(lines), text))
    try:
        r = subprocess.run([exe, "-p", "--model", cfg["todo"]["model"], "--output-format", "json", "--tools", "", "--strict-mcp-config",
                            "--disable-slash-commands", "--no-session-persistence", "--setting-sources", "",
                            "--system-prompt", "너는 연구 메모를 항목으로 나누고 분류하는 도구다. 요청한 JSON 만 출력한다."],
                           input=prompt.encode("utf-8"), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120,
                           cwd=config.STATE_DIR, **NO_WINDOW)
        out = json.loads(r.stdout.decode("utf-8")).get("result") or ""
        items = json.loads(out[out.index("["):out.rindex("]") + 1])
        names = {p["name"] for p in snap["projects"]}
        for it in items:
            if it.get("project") not in names:
                it["project"] = None
        return [it for it in items if isinstance(it, dict) and it.get("text")], None
    except Exception as e:
        return split_memo(text), "Claude 분류 실패 (%s) — 줄마다 한 항목으로 넣었습니다" % (str(e)[:120] or repr(e))


def trim_scan(h):
    """What the page needs of one host's scan: older reports (kept whole for the processed-check) only by name."""
    keep = ("date", "slug", "path", "report", "title", "mtime", "archive")
    folders = {f: dict(r, reports=[x if i < 40 else {k: x.get(k) for k in keep} for i, x in enumerate(r.get("reports") or [])])
               for f, r in (h.get("folders") or {}).items() if isinstance(r, dict)}
    return dict(h, folders=folders)


def load_inventory(state):
    try:
        with open(INVENTORY_CACHE, encoding="utf-8") as fh:
            cached = json.load(fh)
        state.inventory = {h: dict(v, running=False) for h, v in cached.items() if h in state.hosts}
        state.inventory_view = {h: trim_scan(v) for h, v in state.inventory.items()}
    except (OSError, ValueError):
        pass


def save_inventory(state):
    with state.lock:
        data = json.dumps({h: v for h, v in state.inventory.items() if v.get("t")}, ensure_ascii=False)
    try:
        config.ensure_state_dir()
        tmp = INVENTORY_CACHE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(data)
        os.replace(tmp, INVENTORY_CACHE)
    except OSError:
        pass


def read_output(cfg, host, path):
    """Bytes of a step output, from this computer or over the host's ssh connection settings."""
    if host["type"] == "local":
        with open(path, "rb") as fh:
            data = fh.read(MAX_FILE + 1)
    else:
        remote = "head -c %d -- %s" % (MAX_FILE + 1, shlex.quote(path))
        r = subprocess.run(["ssh"] + cfg["ssh_options"] + [host["ssh"], remote], stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, **NO_WINDOW)
        if r.returncode:
            lines = r.stderr.decode("utf-8", "ignore").strip().splitlines()
            raise OSError(lines[-1] if lines else "ssh exit %d" % r.returncode)
        data = r.stdout
    if len(data) > MAX_FILE:
        raise OSError("파일이 %dMB 보다 큼" % (MAX_FILE // 2 ** 20))
    return data


def make_handler(state, bind="127.0.0.1", cfg=None, wake=None):
    hosts = {h["name"]: h for h in (cfg or {}).get("hosts", [])}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if not self._host_ok():
                return self._send(403, "text/plain", b"forbidden host")
            path = urlsplit(self.path).path
            if path == "/api/state":
                body = json.dumps(state.snapshot(), ensure_ascii=False).encode()
                self._send(200, "application/json; charset=utf-8", body)
            elif path == "/events":
                self._sse()
            elif path == "/api/file":
                self._file(parse_qs(urlsplit(self.path).query))
            else:
                path = "index.html" if path in ("/", "") else path.lstrip("/")
                full = os.path.normpath(os.path.join(WEB, path))
                if not full.startswith(WEB) or not os.path.isfile(full):
                    return self._send(404, "text/plain", b"not found")
                ctype = {"html": "text/html", "js": "text/javascript", "css": "text/css"}.get(
                    full.rsplit(".", 1)[-1], "application/octet-stream")
                with open(full, "rb") as fh:
                    self._send(200, ctype + "; charset=utf-8", fh.read())

        def do_POST(self):
            # only this dashboard's own page may ask: a form on another site cannot set a JSON content type
            # without a preflight, and its Origin would differ
            origin = (self.headers.get("Origin") or "").lower()
            port = self.server.server_address[1]
            same = origin in ("http://localhost:%d" % port, "http://127.0.0.1:%d" % port)
            if not self._host_ok() or not same or not (self.headers.get("Content-Type") or "").startswith("application/json"):
                return self._send(403, "text/plain", b"forbidden")
            if urlsplit(self.path).path == "/api/refresh":
                for ev in (wake or {}).values():
                    ev.set()
                return self._send(200, "application/json", b'{"ok": true}')
            if urlsplit(self.path).path == "/api/todo":
                return self._todo()
            self._send(404, "text/plain", b"not found")

        def _todo(self):
            reply = lambda code, obj: self._send(code, "application/json; charset=utf-8", json.dumps(obj, ensure_ascii=False).encode())
            if not cfg or not cfg["todo"]["host"]:
                return reply(400, {"ok": False, "error": "config.ini 에 [todo] host = <호스트 이름> 이 없습니다"})
            try:
                size = int(self.headers.get("Content-Length") or 0)
                op = json.loads(self.rfile.read(min(size, MAX_BODY)).decode("utf-8")) if 0 < size <= MAX_BODY else None
            except ValueError:
                op = None
            if not isinstance(op, dict) or op.get("do") not in ("get", "add", "update", "delete", "capture", "review"):
                return reply(400, {"ok": False, "error": "잘못된 요청"})
            note = None
            if op["do"] == "review":   # long: runs on its own, the page sees the result in the next snapshots
                threading.Thread(target=review_imported, args=(state, cfg), daemon=True).start()
                return reply(200, {"ok": True, "note": "처리된 것을 확인하는 중", "added": []})
            if op["do"] == "capture":
                items, note = classify(cfg, state, str(op.get("text") or "")[:20000])
                op = {"do": "add", "items": items}
            op["by"] = socket.gethostname()
            try:
                db = run_todo(cfg, op)
            except Exception as e:
                state.set_todo(error=str(e) or repr(e))
                return reply(502, {"ok": False, "error": "목록 서버에 쓰지 못함: %s" % e})
            state.set_todo(error=None, t=time.time(), **db)
            return reply(200, {"ok": True, "note": note, "added": [it["id"] for it in db["items"][-len(op.get("items") or []):]] if op["do"] == "add" and op.get("items") else []})

        def _host_ok(self):
            """Loopback-only servers answer only to loopback names, so a web page that rebinds its own
            domain to 127.0.0.1 (DNS rebinding) cannot read session data through the browser."""
            if bind not in ("127.0.0.1", "localhost", "::1"):
                return True
            host = (self.headers.get("Host") or "").lower()
            name = host.rsplit(":", 1)[0] if not host.endswith("]") else host
            return name in ("localhost", "127.0.0.1", "[::1]") or name.endswith(".localhost")

        def _file(self, q):
            host, fpath = q.get("host", [""])[0], q.get("path", [""])[0]
            if host not in hosts or not state.is_output(host, fpath):
                return self._send(403, "text/plain; charset=utf-8", "기록된 산출물이 아님".encode())
            try:
                data = read_output(cfg, hosts[host], fpath)
            except Exception as e:
                return self._send(502, "text/plain; charset=utf-8", ("가져오지 못함: %s" % e).encode())
            name = fpath.replace("\\", "/").rsplit("/", 1)[-1]
            ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
            ctype = FILE_TYPES.get(ext, "application/octet-stream")
            extra = {"Content-Disposition": "%s; filename*=UTF-8''%s" % ("attachment" if "dl" in q else "inline", quote(name))}
            if ctype in ("text/html", "image/svg+xml"):   # report scripts run, but never with the dashboard's origin
                extra["Content-Security-Policy"] = "sandbox allow-scripts allow-popups allow-downloads"
            self._send(200, ctype + ("; charset=utf-8" if ctype.startswith("text/") else ""), data, extra)

        def _send(self, code, ctype, body, extra=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _sse(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            q = queue.Queue(maxsize=16)
            state.subscribers.add(q)
            try:
                q.put_nowait(json.dumps(state.snapshot(), ensure_ascii=False))
                while True:
                    try:
                        data = q.get(timeout=15)
                        self.wfile.write(("data: %s\n\n" % data).encode())
                    except queue.Empty:
                        self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                state.subscribers.discard(q)

    return Handler


def pid_file(port):
    return os.path.join(config.STATE_DIR, "server-%d.pid" % port)


def write_pid(port):
    PID_FILE = pid_file(port)
    config.ensure_state_dir()
    with open(PID_FILE, "w") as fh:
        fh.write(str(os.getpid()))

    def cleanup():
        try:
            with open(PID_FILE) as fh:
                if fh.read().strip() == str(os.getpid()):
                    os.remove(PID_FILE)
        except OSError:
            pass
    atexit.register(cleanup)


def main():
    try:
        cfg = config.load()
    except config.ConfigError as e:
        sys.exit(str(e))
    state = State(cfg["hosts"], cfg["projects"])
    load_inventory(state)
    watcher = notify.Watcher(cfg)
    notes = threading.Event()
    if cfg["todo"]["host"]:
        state.todo = {"host": cfg["todo"]["host"], "items": [], "t": None}
        threading.Thread(target=todo_loop, args=(state, cfg, notes), daemon=True).start()
    if state.inventory:   # notes already known from the last run's scan
        notes.set()
    wake = {h["name"]: threading.Event() for h in cfg["hosts"]}
    for h in cfg["hosts"]:
        threading.Thread(target=run_host, args=(state, cfg, h, watcher), daemon=True).start()
        threading.Thread(target=inventory_loop, args=(state, cfg, h, wake[h["name"]], notes), daemon=True).start()

    # periodic rebroadcast so "n분 전" labels and stale detection stay current
    def tick():
        while True:
            time.sleep(30)
            state.broadcast()
            watcher.tick()
    threading.Thread(target=tick, daemon=True).start()
    server = ThreadingHTTPServer((cfg["bind"], cfg["port"]), make_handler(state, cfg["bind"], cfg, wake))
    server.daemon_threads = True
    write_pid(cfg["port"])
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # run atexit cleanup on `fw stop`
    print("follow_wollof: http://localhost:%d  (%s)" % (cfg["port"], cfg["path"]), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
