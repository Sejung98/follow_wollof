#!/usr/bin/env python3
"""follow_wollof launcher (macOS, Linux, Windows). Stdlib only.

  fw                      start the dashboard server if needed and open it in the browser
  fw window               same, but in its own window like a program (Chrome / Edge app mode)
  fw shortcut on|off [--no-dock]
                          a launcher icon that runs `fw window`: macOS ~/Applications + Dock,
                          Windows Desktop + Start menu, Linux applications menu
  fw init                 create config.ini from config.example.ini
  fw check                test every host in config.ini (connection, python, Claude sessions)
  fw deploy [--dry-run] [--uninstall] [host ...]
                          install the session-side tools (follow.py, Stop hook, /follow skill,
                          CLAUDE.md block) on the configured hosts
  fw start | stop | restart | status
  fw autostart on|off     start the server at login (launchd / systemd --user / Windows Startup)
  fw notify               send a test desktop notification (the server sends one when a session ends,
                          stops after a long run, waits for input, hits a blocked step or stalls; see [notify])
  fw pack                 build a shareable zip without personal files (config.ini, PLAN.md)
  fw selftest             test every part on this computer in a throw-away home folder (no real files touched)
"""
import io
import json
import os
import plistlib
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import urllib.parse
import urllib.request
import webbrowser
import zipfile

ROOT = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, os.path.join(ROOT, "server"))
import config  # noqa: E402

APP = os.path.join(ROOT, "server", "app.py")
AGENT = os.path.join(ROOT, "agent", "agent.py")
SESSION = os.path.join(ROOT, "session")
LOG = os.path.join(config.STATE_DIR, "server.log")
WIN = config.IS_WINDOWS
MAC = sys.platform == "darwin"
NO_WINDOW = {"creationflags": 0x08000000} if WIN else {}
PLIST = os.path.expanduser("~/Library/LaunchAgents/com.follow_wollof.server.plist")
UNIT = os.path.expanduser("~/.config/systemd/user/follow-wollof.service")
STARTUP_DIR = os.path.join(os.environ.get("APPDATA", ""), "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
STARTUP_VBS = os.path.join(STARTUP_DIR, "follow_wollof.vbs")
STARTUP_OLD = os.path.join(STARTUP_DIR, "follow_wollof.cmd")   # earlier versions
ICONS = os.path.join(ROOT, "app")
MAC_APP = os.path.expanduser("~/Applications/follow_wollof.app")
DESKTOP_ENTRY = os.path.expanduser("~/.local/share/applications/follow_wollof.desktop")
WINDOW_SIZE = "--window-size=1440,920"
# Only these ship in `fw pack` (allowlist: notes, config.ini, logs or anything else dropped here stay out)
PACK_FILES = ["README.md", "README.ko.md", "config.example.ini", "fw", "fw.cmd", "fw.py", ".gitignore"]
PACK_DIRS = ["agent", "server", "web", "session", "tests", "docs", "app"]
PACK_SKIP = {"__pycache__", ".DS_Store"}

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def die(msg, code=1):
    if WIN and sys.stderr is None:   # started from the shortcut by pythonw: no console to print to
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, str(msg), "follow_wollof", 0x10)
    else:
        print(msg, file=sys.stderr)
    sys.exit(code)


def cfg():
    try:
        return config.load()
    except config.ConfigError as e:
        die(str(e))


def url(c):
    return "http://localhost:%d" % c["port"]


def running(c):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/state" % c["port"], timeout=1):
            return True
    except Exception:
        return False


def pythonw():
    """Windowless interpreter on Windows so the server does not keep a console open."""
    if WIN:
        w = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
        if os.path.exists(w):
            return w
    return sys.executable


# ── server ──────────────────────────────────────────────────────────────

def start(c):
    if running(c):
        return
    config.ensure_state_dir()
    log = open(LOG, "ab")
    kw = {"stdout": log, "stderr": log, "stdin": subprocess.DEVNULL, "cwd": ROOT}
    if WIN:
        kw["creationflags"] = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED | NEW_GROUP | NO_WINDOW
    else:
        kw["start_new_session"] = True
    subprocess.Popen([pythonw(), APP], **kw)
    for _ in range(40):
        if running(c):
            return
        time.sleep(0.25)
    die("서버 시작 실패 — 로그 확인: %s" % LOG)


def stop(c):
    if MAC and os.path.exists(PLIST):
        subprocess.call(["launchctl", "unload", PLIST], stderr=subprocess.DEVNULL)
    if not WIN and not MAC and os.path.exists(UNIT):
        subprocess.call(["systemctl", "--user", "stop", "follow-wollof"], stderr=subprocess.DEVNULL)
    PID_FILE = os.path.join(config.STATE_DIR, "server-%d.pid" % c["port"])
    if not running(c):
        # never signal a stale pid: after a reboot it may belong to an unrelated process
        if os.path.exists(PID_FILE):
            os.remove(PID_FILE)
        return
    try:
        with open(PID_FILE) as fh:
            pid = int(fh.read().strip())
        os.kill(pid, signal.SIGTERM)  # on Windows this is TerminateProcess
    except (OSError, ValueError):
        pass
    for _ in range(20):
        if not running(c):
            break
        time.sleep(0.25)
    if running(c):
        die("서버가 아직 응답합니다. 포트 %d 를 다른 프로그램이 쓰는지 확인하세요." % c["port"])


def restart(c):
    stop(c)
    if MAC and os.path.exists(PLIST):
        subprocess.call(["launchctl", "load", PLIST])
    elif not WIN and not MAC and os.path.exists(UNIT):
        subprocess.call(["systemctl", "--user", "start", "follow-wollof"])
    else:
        start(c)


def autostart(c, mode):
    if mode not in ("on", "off"):
        die("fw autostart on|off")
    stop(c)
    if MAC:
        if mode == "on":
            os.makedirs(os.path.dirname(PLIST), exist_ok=True)
            with open(PLIST, "w") as fh:
                fh.write("""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.follow_wollof.server</string>
  <key>ProgramArguments</key><array><string>%s</string><string>%s</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>%s</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>%s</string>
  <key>StandardErrorPath</key><string>%s</string>
</dict></plist>
""" % (sys.executable, APP, os.environ.get("PATH", ""), LOG, LOG))
            subprocess.call(["launchctl", "load", PLIST])
            where = PLIST
        else:
            if os.path.exists(PLIST):
                os.remove(PLIST)
            where = None
    elif WIN:
        for old in (STARTUP_VBS, STARTUP_OLD):
            if os.path.exists(old):
                os.remove(old)
        if mode == "on":
            # window style 0 = hidden; UTF-16 so non-ASCII user folders survive Windows Script Host
            line = 'CreateObject("WScript.Shell").Run """%s"" ""%s"" start", 0, False\r\n' % (
                pythonw(), os.path.join(ROOT, "fw.py"))
            with open(STARTUP_VBS, "w", encoding="utf-16") as fh:
                fh.write(line)
            start(c)
            where = STARTUP_VBS
        else:
            where = None
    else:
        if mode == "on":
            os.makedirs(os.path.dirname(UNIT), exist_ok=True)
            with open(UNIT, "w") as fh:
                fh.write("[Unit]\nDescription=follow_wollof dashboard\n\n[Service]\nExecStart=%s %s\n"
                         "Restart=always\nEnvironment=PATH=%s\n\n[Install]\nWantedBy=default.target\n"
                         % (sys.executable, APP, os.environ.get("PATH", "")))
            subprocess.call(["systemctl", "--user", "daemon-reload"])
            subprocess.call(["systemctl", "--user", "enable", "--now", "follow-wollof"])
            where = UNIT
        else:
            subprocess.call(["systemctl", "--user", "disable", "--now", "follow-wollof"], stderr=subprocess.DEVNULL)
            if os.path.exists(UNIT):
                os.remove(UNIT)
            where = None
    print("로그인 시 자동 실행 켬: %s" % where if where else "자동 실행 끔")


# ── window and launcher ─────────────────────────────────────────────────

def chromium():
    """A Chromium browser that can show a page as a window of its own (--app), or None."""
    if MAC:
        for name in ("Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"):
            for base in ("/Applications", os.path.expanduser("~/Applications")):
                path = os.path.join(base, name + ".app")
                if os.path.isdir(path):
                    return path
    elif WIN:
        for rel in (r"Google\Chrome\Application\chrome.exe", r"Microsoft\Edge\Application\msedge.exe"):
            for var in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
                if os.environ.get(var) and os.path.exists(os.path.join(os.environ[var], rel)):
                    return os.path.join(os.environ[var], rel)
    else:
        for exe in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"):
            if shutil.which(exe):
                return shutil.which(exe)
    return None


def open_window(u):
    """The dashboard without tabs or address bar, like a program; a browser tab when no Chromium browser exists."""
    browser = chromium()
    if not browser:
        webbrowser.open(u)
    elif MAC:   # -n hands the arguments over even when the browser is already running
        subprocess.Popen(["open", "-na", browser, "--args", "--app=" + u, WINDOW_SIZE])
    else:
        subprocess.Popen([browser, "--app=" + u, WINDOW_SIZE], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, **({"creationflags": 0x00000008} if WIN else {"start_new_session": True}))


def shortcut(args):
    mode = args[0] if args else ""
    if mode not in ("on", "off"):
        die("fw shortcut on|off [--no-dock]")
    if MAC:
        changed = mac_app(mode == "on", "--no-dock" not in args)
    elif WIN:
        changed = win_links(mode == "on")
    else:
        changed = desktop_entry(mode == "on")
    if mode == "on":
        print("바로가기 만듦 (누르면 `fw window` 실행):" + "".join("\n  " + p for p in changed))
    else:
        print("바로가기 지움" + ("".join("\n  " + p for p in changed) if changed else ": 없었음"))


def mac_app(on, dock):
    """~/Applications/follow_wollof.app: a bundle whose only program is one shell line running `fw window`."""
    existed = os.path.isdir(MAC_APP)
    if existed:
        shutil.rmtree(MAC_APP)
    if not on:
        tile = dock and dock_tile(False)
        return ([MAC_APP] if existed else []) + ([tile] if tile else [])
    contents = os.path.join(MAC_APP, "Contents")
    os.makedirs(os.path.join(contents, "MacOS"))
    os.makedirs(os.path.join(contents, "Resources"))
    with open(os.path.join(contents, "Info.plist"), "wb") as fh:
        plistlib.dump({"CFBundleName": "follow_wollof", "CFBundleDisplayName": "follow_wollof",
                       "CFBundleIdentifier": "com.follow_wollof.launcher", "CFBundleExecutable": "follow_wollof",
                       "CFBundleIconFile": "follow_wollof", "CFBundlePackageType": "APPL",
                       "CFBundleShortVersionString": "1.0", "LSUIElement": True}, fh)   # no Dock bounce while it runs
    exe = os.path.join(contents, "MacOS", "follow_wollof")
    with open(exe, "w") as fh:   # Finder starts apps with a bare PATH; keep the one ssh and python are on now
        fh.write("#!/bin/sh\nexport PATH=%s\nexec %s %s window\n" % (
            shlex.quote(os.environ.get("PATH", "")), shlex.quote(sys.executable), shlex.quote(os.path.join(ROOT, "fw.py"))))
    os.chmod(exe, 0o755)
    shutil.copyfile(os.path.join(ICONS, "follow_wollof.icns"), os.path.join(contents, "Resources", "follow_wollof.icns"))
    tile = dock and dock_tile(True)
    return [MAC_APP] + ([tile] if tile else [])


def dock_tile(add):
    """Add or remove the launcher among the Dock's apps; returns what happened, or None if the Dock is unreadable."""
    try:
        prefs = plistlib.loads(subprocess.run(["defaults", "export", "com.apple.dock", "-"],
                                              stdout=subprocess.PIPE, check=True).stdout)
    except Exception:
        return None
    apps = prefs.get("persistent-apps", [])
    mine = [t for t in apps if "/follow_wollof.app" in t.get("tile-data", {}).get("file-data", {}).get("_CFURLString", "")]
    if add and mine:
        return "Dock: 이미 있음"
    if not add and not mine:
        return None
    if add:   # append only, the rest of the Dock is left as it is
        tile = ("<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>%s</string>"
                "<key>_CFURLStringType</key><integer>15</integer></dict><key>file-label</key><string>follow_wollof</string>"
                "</dict><key>tile-type</key><string>file-tile</string></dict>" % ("file://" + urllib.parse.quote(MAC_APP) + "/"))
        subprocess.check_call(["defaults", "write", "com.apple.dock", "persistent-apps", "-array-add", tile])
    else:
        prefs["persistent-apps"] = [t for t in apps if t not in mine]
        subprocess.run(["defaults", "import", "com.apple.dock", "-"], input=plistlib.dumps(prefs), check=True)
    subprocess.call(["killall", "Dock"])
    return "Dock: 추가" if add else "Dock: 뺌"


def powershell(script, env=None):
    return subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
                          env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **NO_WINDOW)


def win_folders():
    """Desktop and Start menu > Programs, as Windows reports them (a Desktop moved to OneDrive included)."""
    r = powershell("[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false; "
                   "[Environment]::GetFolderPath('Desktop'); [Environment]::GetFolderPath('Programs')")
    found = [l.strip() for l in r.stdout.decode("utf-8-sig", "replace").splitlines() if l.strip()]
    if r.returncode or len(found) != 2:
        found = [os.path.join(os.path.expanduser("~"), "Desktop"),
                 os.path.join(os.environ.get("APPDATA", ""), "Microsoft", "Windows", "Start Menu", "Programs")]
    return found


def win_link(path, target, arguments, icon):
    """One .lnk through the Windows Script Host; values travel as environment variables, never pasted into code."""
    r = powershell("$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:FW_LINK); $s.TargetPath = $env:FW_TARGET; "
                   "$s.Arguments = $env:FW_ARGS; $s.WorkingDirectory = $env:FW_DIR; $s.IconLocation = $env:FW_ICON; "
                   "$s.Description = 'follow_wollof dashboard'; $s.Save()",
                   dict(os.environ, FW_LINK=path, FW_TARGET=target, FW_ARGS=arguments, FW_DIR=ROOT, FW_ICON=icon + ",0"))
    if r.returncode or not os.path.exists(path):
        die("바로가기를 만들지 못함: %s\n%s" % (path, clean_err(r.stderr)))


def win_links(on):
    links = [os.path.join(d, "follow_wollof.lnk") for d in win_folders()]
    if not on:
        gone = [p for p in links if os.path.exists(p)]
        for p in gone:
            os.remove(p)
        return gone
    for p in links:   # pythonw: no console window flashes when the shortcut is clicked
        win_link(p, pythonw(), '"%s" window' % os.path.join(ROOT, "fw.py"), os.path.join(ICONS, "follow_wollof.ico"))
    return links


def desktop_entry(on):
    if not on:
        existed = os.path.exists(DESKTOP_ENTRY)
        if existed:
            os.remove(DESKTOP_ENTRY)
        return [DESKTOP_ENTRY] if existed else []
    os.makedirs(os.path.dirname(DESKTOP_ENTRY), exist_ok=True)
    with open(DESKTOP_ENTRY, "w", encoding="utf-8") as fh:
        fh.write("[Desktop Entry]\nType=Application\nName=follow_wollof\nComment=Claude Code 세션 진행 대시보드\n"
                 'Exec="%s" "%s" window\nIcon=%s\nTerminal=false\nCategories=Development;\n'
                 % (sys.executable, os.path.join(ROOT, "fw.py"), os.path.join(ICONS, "icon.png")))
    return [DESKTOP_ENTRY]


# ── hosts ───────────────────────────────────────────────────────────────

def ssh_cmd(c, host, remote):
    return ["ssh"] + c["ssh_options"] + [host["ssh"], remote]


def clean_err(text):
    return "\n".join(l for l in text.decode("utf-8", "ignore").splitlines() if l.strip() and not l.startswith("**"))


def check_local(c):
    """Problems on this computer that would stop the dashboard or the session tools."""
    claude = os.path.join(os.path.expanduser("~"), ".claude")
    sessions = os.path.join(claude, "sessions")
    rows = [
        ("python", sys.version.split()[0] + (" (3.8 이상 필요)" if sys.version_info < (3, 8) else ""), sys.version_info >= (3, 8)),
        ("설정", c["path"], True),
        ("Claude Code", claude if os.path.isdir(claude) else "~/.claude 없음 — 이 컴퓨터에서 Claude Code 를 한 번 실행", os.path.isdir(claude)),
        ("세션 기록", "%d개 (%s)" % (len([f for f in os.listdir(sessions) if f.endswith(".json")]), sessions)
         if os.path.isdir(sessions) else "~/.claude/sessions 없음 — 실행 중인 Claude Code 가 있으면 생김", os.path.isdir(sessions)),
        ("세션 도구", "설치됨" if os.path.exists(os.path.join(config.STATE_DIR, "bin", "follow.py"))
         else "미설치 — fw deploy", os.path.exists(os.path.join(config.STATE_DIR, "bin", "follow.py"))),
    ]
    if any(h["type"] == "ssh" for h in c["hosts"]):
        ssh = shutil.which("ssh")
        rows.append(("ssh", ssh or "없음 (Windows: 설정 > 시스템 > 선택적 기능 > OpenSSH 클라이언트)", bool(ssh)))
    rows.append(("대시보드", ("실행 중 " if running(c) else "꺼져 있음 ") + url(c), True))
    for k, v, ok in rows:
        print("  %s %-10s %s" % ("✓" if ok else "✗", k, v))
    return all(ok for _, _, ok in rows)


def check(c):
    print("이 컴퓨터")
    bad = 0 if check_local(c) else 1
    print("호스트")
    with open(AGENT, "rb") as fh:
        agent = fh.read()
    for h in c["hosts"]:
        label = "  %-14s" % h["name"]
        if h["type"] == "local":
            cmd = [h["python"], AGENT, "--once"]
            inp = None
        else:
            if not shutil.which("ssh"):
                print(label, "✗ ssh 명령을 찾을 수 없음 (Windows: 설정 > 앱 > 선택적 기능 > OpenSSH 클라이언트)")
                bad += 1
                continue
            cmd = ssh_cmd(c, h, "%s - --once" % h["python"])
            inp = agent
        r = None
        try:
            r = subprocess.run(cmd, input=inp, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40, **NO_WINDOW)
            d = json.loads(r.stdout.decode("utf-8"))
            live = d["sessions"]
            planned = sum(1 for s in live if s.get("plan"))
            print(label, "✓ %s · 실행 중인 Claude 세션 %d개 (계획 등록 %d)" % (d["host"], len(live), planned))
        except subprocess.TimeoutExpired:
            print(label, "✗ 시간 초과 — `ssh %s true` 가 비밀번호 없이 끝나는지 확인" % h["ssh"])
            bad += 1
        except Exception:
            err = clean_err(r.stderr) if r is not None else ""
            print(label, "✗ " + (err.splitlines()[-1] if err else "응답을 해석하지 못함"))
            bad += 1
    if bad:
        sys.exit(1)


def package_bytes():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for base, dirs, files in os.walk(SESSION):
            dirs[:] = [d for d in dirs if d != "__pycache__"]
            for f in files:
                full = os.path.join(base, f)
                tar.add(full, arcname=os.path.relpath(full, SESSION).replace(os.sep, "/"))
    return buf.getvalue()


def deploy(c, args):
    flags = [a for a in args if a in ("--dry-run", "--uninstall")]
    unknown = [a for a in args if a.startswith("--") and a not in flags]
    if unknown:
        die("알 수 없는 옵션: %s" % " ".join(unknown))
    names = [a for a in args if not a.startswith("--")]
    hosts = [h for h in c["hosts"] if (h["name"] in names if names else h["deploy"])]
    if names and len(hosts) != len(names):
        die("config.ini 에 없는 호스트: %s" % ", ".join(set(names) - {h["name"] for h in hosts}))
    pkg = package_bytes()
    for h in hosts:
        print("== %s" % h["name"], flush=True)
        if h["type"] == "local":
            r = subprocess.run([h["python"], os.path.join(SESSION, "install.py")] + flags)
            ok = r.returncode == 0
        else:
            remote = ("rm -rf ~/.follow_wollof/pkg && mkdir -p ~/.follow_wollof/pkg && "
                      "tar -xf - -C ~/.follow_wollof/pkg && %s ~/.follow_wollof/pkg/install.py %s"
                      % (h["python"], " ".join(flags)))
            r = subprocess.run(ssh_cmd(c, h, remote), input=pkg, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, timeout=120, **NO_WINDOW)
            sys.stdout.write(r.stdout.decode("utf-8", "replace"))
            err = clean_err(r.stderr)
            if err:
                print(err)
            ok = r.returncode == 0
        if not ok:
            print("  ✗ 실패 (exit %s)" % r.returncode)


# ── packaging ───────────────────────────────────────────────────────────

def pack():
    out_dir = os.path.join(ROOT, "dist")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "follow_wollof-%s.zip" % time.strftime("%Y%m%d"))
    paths = [os.path.join(ROOT, f) for f in PACK_FILES if os.path.exists(os.path.join(ROOT, f))]
    for d in PACK_DIRS:
        for base, dirs, files in os.walk(os.path.join(ROOT, d)):
            dirs[:] = sorted(x for x in dirs if x not in PACK_SKIP)
            paths += [os.path.join(base, f) for f in sorted(files) if f not in PACK_SKIP and not f.endswith(".pyc")]
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for full in paths:
            rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
            info = zipfile.ZipInfo.from_file(full, "follow_wollof/" + rel)
            if rel in ("fw", "fw.py"):
                info.external_attr = 0o100755 << 16          # executable even when packed on Windows
            with open(full, "rb") as fh:
                z.writestr(info, fh.read(), zipfile.ZIP_DEFLATED)
    print(out)
    print("%d files" % len(paths))


def init():
    path = config.config_path()
    if os.path.exists(path):
        print("이미 있음: %s" % path)
    else:
        shutil.copyfile(config.EXAMPLE, path)
        print("만듦: %s" % path)
    print("다음: 호스트를 채운 뒤  fw check  →  fw deploy  →  fw")


def main(argv):
    cmd = argv[0] if argv else "open"
    if cmd in ("-h", "--help", "help"):
        print(__doc__.strip())
        return
    if cmd == "init":
        return init()
    if cmd == "pack":
        return pack()
    if cmd == "shortcut":
        return shortcut(argv[1:])
    if cmd == "selftest":
        sys.exit(subprocess.call([config.console_python(), os.path.join(ROOT, "tests", "selftest.py")]))
    c = cfg()
    if cmd == "open":
        start(c)
        webbrowser.open(url(c))
        print(url(c))
    elif cmd == "window":
        start(c)
        open_window(url(c))
        print(url(c))
    elif cmd == "start":
        start(c)
        print(url(c))
    elif cmd == "stop":
        stop(c)
        print("중지됨")
    elif cmd == "restart":
        restart(c)
        print(url(c))
    elif cmd == "status":
        print(("실행 중: " + url(c)) if running(c) else "꺼져 있음")
        print("설정: " + c["path"])
        print("호스트: " + ", ".join("%s(%s)" % (h["name"], h["ssh"] or "local") for h in c["hosts"]))
    elif cmd == "check":
        check(c)
    elif cmd == "notify":
        import notify
        if notify.send("알림 확인", "세션이 끝나거나 멈추면 이렇게 알려 드립니다", url(c)):
            print("알림을 보냈습니다. 화면 구석에 안 보이면 시스템 설정의 알림에서 허용하세요 (macOS: 스크립트 편집기, Windows: follow_wollof).")
        else:
            die("알림을 보내지 못했습니다 — 위 오류 참고 (Linux 는 notify-send 필요)")
    elif cmd == "deploy":
        deploy(c, argv[1:])
    elif cmd == "autostart":
        autostart(c, argv[1] if len(argv) > 1 else "")
    else:
        die("알 수 없는 명령: %s\n\n%s" % (cmd, __doc__.strip()))


if __name__ == "__main__":
    main(sys.argv[1:])
