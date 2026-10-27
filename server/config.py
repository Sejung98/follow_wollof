"""Load follow_wollof settings from config.ini (override the path with FW_CONFIG). Stdlib only."""
import configparser
import os
import shlex
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXAMPLE = os.path.join(ROOT, "config.example.ini")
STATE_DIR = os.path.join(os.path.expanduser("~"), ".follow_wollof")
IS_WINDOWS = os.name == "nt"

# BatchMode: never prompt (a hung password prompt would stall the stream).
# ClearAllForwardings: never take over LocalForward ports a Host entry sets up for the user's own tunnels
SSH_BASE = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ClearAllForwardings=yes",
            "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"]
if not IS_WINDOWS:
    # one dedicated connection per host; shared ControlMaster sockets can hang long-lived streams.
    # Windows OpenSSH has no multiplexing, so there is nothing to turn off.
    SSH_BASE += ["-o", "ControlMaster=no", "-o", "ControlPath=none"]


NOTIFY_EVENTS = ("ended", "stopped", "waiting", "blocked", "stale")


class ConfigError(Exception):
    pass


def split_options(text):
    """Split extra ssh options; on Windows keep backslashes in paths such as C:\\keys\\id."""
    if not IS_WINDOWS:
        return shlex.split(text)
    return [t[1:-1] if len(t) > 1 and t[0] == t[-1] and t[0] in "\"'" else t
            for t in shlex.split(text, posix=False)]


def console_python():
    """The agent writes to stdout, so never hand it the windowless pythonw.exe."""
    exe = sys.executable
    if IS_WINDOWS and os.path.basename(exe).lower() == "pythonw.exe":
        alt = os.path.join(os.path.dirname(exe), "python.exe")
        if os.path.exists(alt):
            return alt
    return exe


def ensure_state_dir():
    """~/.follow_wollof holds plans, logs and pid files; keep it owner-only (no-op on Windows)."""
    if not os.path.isdir(STATE_DIR):
        os.makedirs(STATE_DIR, mode=0o700)
    if not IS_WINDOWS and os.stat(STATE_DIR).st_mode & 0o077:
        os.chmod(STATE_DIR, 0o700)


def config_path():
    return os.environ.get("FW_CONFIG") or os.path.join(ROOT, "config.ini")


def load(path=None):
    path = path or config_path()
    if not os.path.exists(path):
        raise ConfigError("설정 파일이 없습니다: %s\n  `fw init` 으로 만든 뒤 호스트를 채우세요." % path)
    cp = configparser.ConfigParser(inline_comment_prefixes=(";", "#"), interpolation=None)
    text = None
    # utf-8-sig: Notepad may add a BOM; fall back to the system code page for files saved as "ANSI"
    for enc in ("utf-8-sig", None):
        try:
            with open(path, encoding=enc) as fh:
                text = fh.read()
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise ConfigError("설정 파일 인코딩을 읽지 못했습니다 (UTF-8 로 저장하세요): %s" % path)
    try:
        cp.read_string(text, source=path)
    except configparser.Error as e:
        raise ConfigError("설정 파일 형식 오류 (%s): %s" % (path, e))

    def get(section, key, default):
        return cp.get(section, key, fallback=default) if cp.has_section(section) else default

    try:
        cfg = {
            "path": path,
            "port": int(get("dashboard", "port", 7777)),
            "bind": get("dashboard", "bind", "127.0.0.1"),
            "interval": float(get("agent", "interval", 2)),
            "ssh_options": SSH_BASE + split_options(get("ssh", "options", "") or ""),
            "hosts": [],
            "projects": [],
            "inventory_minutes": float(get("projects", "inventory_minutes", 15)),
        }
    except ValueError as e:
        raise ConfigError("설정 값 오류 (%s): %s" % (path, e))

    for sec in cp.sections():
        if not sec.lower().startswith("host:"):
            continue
        name = sec.split(":", 1)[1].strip()
        s = cp[sec]
        if not s.getboolean("enabled", True):
            continue
        typ = s.get("type", "ssh" if s.get("ssh") else "local").strip().lower()
        if typ not in ("local", "ssh"):
            raise ConfigError("[%s] type 은 local 또는 ssh 여야 합니다: %r" % (sec, typ))
        if typ == "ssh" and not s.get("ssh"):
            raise ConfigError("[%s] type = ssh 에는 ssh = <Host 별칭 또는 user@host> 가 필요합니다" % sec)
        cfg["hosts"].append({
            "name": name,
            "type": typ,
            "ssh": s.get("ssh"),
            "python": s.get("python") or ("python3" if typ == "ssh" else console_python()),
            "deploy": s.getboolean("deploy", True),
        })
    if not cfg["hosts"]:
        raise ConfigError("활성화된 [host:<이름>] 섹션이 없습니다 (%s)" % path)
    names = [h["name"] for h in cfg["hosts"]]
    if len(set(names)) != len(names):
        raise ConfigError("호스트 이름이 중복됩니다: %s" % ", ".join(names))

    # [project:<name>]  <host> = folder[, folder ...]   data = glob[, glob ...]   (section order = screen order)
    by_lower = {n.lower(): n for n in names}   # configparser lowercases keys
    for sec in cp.sections():
        if not sec.lower().startswith("project:"):
            continue
        p = {"name": sec.split(":", 1)[1].strip(), "folders": {}, "data": []}
        for key, value in cp[sec].items():
            items = [v.strip() for v in value.split(",") if v.strip()]
            if key == "data":
                p["data"] = items
            elif key in by_lower:
                p["folders"][by_lower[key]] = items
            else:
                raise ConfigError("[%s] 에 없는 호스트 이름: %s (호스트: %s)" % (sec, key, ", ".join(names)))
        cfg["projects"].append(p)

    # [todo] host = <host name>: where the questions and to-dos page keeps its list (one file, shared by every desktop)
    t = cp["todo"] if cp.has_section("todo") else {}
    host = (t.get("host") or "").strip()
    if host and host.lower() not in by_lower:
        raise ConfigError("[todo] host 가 [host:<이름>] 에 없습니다: %s (호스트: %s)" % (host, ", ".join(names)))
    cfg["todo"] = {"host": by_lower.get(host.lower()) if host else None,
                   "path": (t.get("path") or "~/.follow_wollof/todo.json").strip(),
                   "classify": (t.get("classify") or "claude").strip().lower(),
                   "model": (t.get("model") or "haiku").strip(),
                   "judge_model": (t.get("judge_model") or "sonnet").strip(),
                   "claude": (t.get("claude") or "").strip(),
                   "import": (t.get("import") or "on").strip().lower() not in ("off", "false", "no", "0")}

    n = cp["notify"] if cp.has_section("notify") else {}
    try:
        cfg["notify"] = {
            "enabled": cp.getboolean("notify", "enabled", fallback=True),
            "events": [e.strip() for e in (n.get("events") or ",".join(NOTIFY_EVENTS)).split(",") if e.strip()],
            "min_busy": float(n.get("min_busy") or 60),
        }
    except ValueError as e:
        raise ConfigError("[notify] 값 오류 (%s): %s" % (path, e))
    bad = set(cfg["notify"]["events"]) - set(NOTIFY_EVENTS)
    if bad:
        raise ConfigError("[notify] events 는 %s 중에서 고릅니다: %s" % (", ".join(NOTIFY_EVENTS), ", ".join(sorted(bad))))
    return cfg
