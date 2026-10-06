#!/usr/bin/env python3
"""follow_wollof central server: one agent stream per host, merged state pushed to the web board.

    python3 server/app.py          (normally started by `fw`)
Hosts and port come from config.ini (see config.example.ini). Stdlib only; macOS, Linux, Windows.
"""
import atexit
import collections
import json
import os
import queue
import shlex
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402

ROOT = config.ROOT
AGENT = os.path.join(ROOT, "agent", "agent.py")
WEB = os.path.join(ROOT, "web")
# no console window per ssh child when the server runs windowless (pythonw) on Windows
NO_WINDOW = {"creationflags": 0x08000000} if config.IS_WINDOWS else {}
STALE_AFTER = 60  # seconds without any line before a host is shown as disconnected
MAX_FILE = 80 * 1024 * 1024  # largest step output the viewer will fetch
FILE_TYPES = {"pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
              "webp": "image/webp", "svg": "image/svg+xml", "html": "text/html", "htm": "text/html",
              "txt": "text/plain", "md": "text/plain", "csv": "text/plain", "tsv": "text/plain", "log": "text/plain",
              "json": "text/plain", "tex": "text/plain"}


class State:
    def __init__(self, hosts):
        self.lock = threading.Lock()
        self.hosts = {h["name"]: {"name": h["name"], "connected": False, "lastSeen": None,
                                  "error": None, "hostname": None, "sessions": []}
                      for h in hosts}
        self.order = [h["name"] for h in hosts]
        self.subscribers = set()

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
                hosts.append(h)
            return {"t": now, "hosts": hosts}

    def is_output(self, host, path):
        """Only files a session recorded with `follow.py out` can be fetched: the viewer is not a file browser."""
        with self.lock:
            h = self.hosts.get(host)
            return bool(h) and any(e.get("op") == "out" and any(f.get("path") == path for f in e.get("files", []))
                                   for s in h["sessions"] for e in (s.get("plan") or []))

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


def run_host(state, cfg, host):
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


def make_handler(state, bind="127.0.0.1", cfg=None):
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
    state = State(cfg["hosts"])
    for h in cfg["hosts"]:
        threading.Thread(target=run_host, args=(state, cfg, h), daemon=True).start()

    # periodic rebroadcast so "n분 전" labels and stale detection stay current
    def tick():
        while True:
            time.sleep(30)
            state.broadcast()
    threading.Thread(target=tick, daemon=True).start()
    server = ThreadingHTTPServer((cfg["bind"], cfg["port"]), make_handler(state, cfg["bind"], cfg))
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
