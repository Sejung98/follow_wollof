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
SSH_BASE = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
            "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"]
if not IS_WINDOWS:
    # one dedicated connection per host; shared ControlMaster sockets can hang long-lived streams.
    # Windows OpenSSH has no multiplexing, so there is nothing to turn off.
    SSH_BASE += ["-o", "ControlMaster=no", "-o", "ControlPath=none"]


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
    return cfg
