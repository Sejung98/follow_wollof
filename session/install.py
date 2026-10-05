#!/usr/bin/env python3
"""Install (or remove) follow_wollof on this host. Idempotent; runs from the unpacked package dir.

  python3 install.py [--dry-run] [--uninstall]      (normally run by `fw deploy`)
Linux, macOS, Windows. The python running this script is the one the hook and CLAUDE.md block use.
Touches:
  ~/.follow_wollof/bin/{follow.py,stop_hook.py}
  ~/.claude/skills/follow/SKILL.md
  ~/.claude/CLAUDE.md          (one marked block)
  ~/.claude/settings.json      (one Stop hook entry; backup written once to settings.json.bak-follow_wollof)
"""
import json
import os
import shutil
import sys

PKG = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser("~")
BIN = os.path.join(HOME, ".follow_wollof", "bin")
CLAUDE = os.path.join(HOME, ".claude")
SKILL_DIR = os.path.join(CLAUDE, "skills", "follow")
CLAUDE_MD = os.path.join(CLAUDE, "CLAUDE.md")
SETTINGS = os.path.join(CLAUDE, "settings.json")
START, END = "<!-- follow_wollof:start -->", "<!-- follow_wollof:end -->"
IS_WINDOWS = os.name == "nt"


def shell_path(path):
    """A path usable from Git Bash, PowerShell and cmd alike: forward slashes, quoted only if needed."""
    path = path.replace("\\", "/")
    return '"%s"' % path if " " in path else path


def python_cmd():
    if not IS_WINDOWS:
        return "python3" if shutil.which("python3") else shell_path(sys.executable)
    # Unquoted absolute path works in Git Bash, PowerShell and cmd alike. A quoted path would not run in
    # PowerShell (it needs `&`), so with spaces prefer the py launcher, which every shell can call by name.
    if " " not in sys.executable:
        return shell_path(sys.executable)
    if shutil.which("py"):
        return "py -%d.%d" % sys.version_info[:2]
    return shell_path(sys.executable)


def script_cmd(name):
    """Command that runs ~/.follow_wollof/bin/<name> with this host's python."""
    if IS_WINDOWS:  # the Bash tool may be Git Bash or PowerShell; spell the path out
        return "%s %s" % (python_cmd(), shell_path(os.path.join(BIN, name)))
    return "%s ~/.follow_wollof/bin/%s" % (python_cmd(), name)


FOLLOW_CMD = script_cmd("follow.py")
HOOK_CMD = script_cmd("stop_hook.py")
DRY = "--dry-run" in sys.argv
UNINSTALL = "--uninstall" in sys.argv


def say(msg):
    print(("[dry-run] " if DRY else "") + msg)


def private(path, mode):
    if not IS_WINDOWS and not DRY and os.path.exists(path):
        os.chmod(path, mode)


def backup_once(path):
    bak = path + ".bak-follow_wollof"
    if os.path.exists(path) and not os.path.exists(bak) and not DRY:
        shutil.copy2(path, bak)
    private(bak, 0o600)   # a copy of the user's settings: owner-only even if the original is not


def write(path, text):
    if DRY:
        return
    d = os.path.dirname(path)
    if not os.path.isdir(d):
        os.makedirs(d)
    with open(path, "w", encoding="utf-8", newline="") as fh:   # write exactly what was built
        fh.write(text)


def strip_block(text):
    if START in text and END in text:
        a, b = text.index(START), text.index(END) + len(END)
        text = text[:a].rstrip("\n") + ("\n" if text[:a].strip() else "") + text[b:].lstrip("\n")
    return text


def claude_md():
    old = ""
    if os.path.exists(CLAUDE_MD):
        with open(CLAUDE_MD, encoding="utf-8", newline="") as fh:
            old = fh.read()
    nl = "\r\n" if "\r\n" in old else "\n"
    new = strip_block(old.replace("\r\n", "\n")).replace("\n", nl)
    if not UNINSTALL:
        with open(os.path.join(PKG, "claude_md.md"), encoding="utf-8") as fh:
            block = fh.read().strip().replace("{FOLLOW}", FOLLOW_CMD)
        body = START + "\n" + block + "\n" + END + "\n"
        new = (new.rstrip("\r\n") + nl + nl if new.strip() else "") + body.replace("\n", nl)
    if new != old:
        backup_once(CLAUDE_MD)
        write(CLAUDE_MD, new)
        say("CLAUDE.md: follow_wollof 블록 " + ("제거" if UNINSTALL else "갱신"))
    else:
        say("CLAUDE.md: 변경 없음")


def settings():
    if os.path.exists(SETTINGS):
        try:
            with open(SETTINGS, encoding="utf-8") as fh:
                cfg = json.load(fh)
        except ValueError as e:
            sys.exit("settings.json 을 JSON 으로 읽지 못해 중단함: %s" % e)
    else:
        cfg = {}
    hooks = cfg.setdefault("hooks", {})
    stop = hooks.setdefault("Stop", [])
    ours = lambda m: any("follow_wollof" in h.get("command", "") for h in m.get("hooks", []))
    mine = [m for m in stop if ours(m)]
    if not UNINSTALL and len(mine) == 1 and [h.get("command") for h in mine[0].get("hooks", [])] == [HOOK_CMD]:
        say("settings.json: 변경 없음")   # already there; other tools may have added hooks after it — leave the order
        return
    kept = [m for m in stop if not ours(m)]
    if not UNINSTALL:
        kept.append({"hooks": [{"type": "command", "command": HOOK_CMD, "timeout": 10}]})
    if kept == stop:
        say("settings.json: 변경 없음")
        return
    hooks["Stop"] = kept
    if not kept:
        del hooks["Stop"]
    if not hooks:
        del cfg["hooks"]
    backup_once(SETTINGS)
    write(SETTINGS, json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
    say("settings.json: Stop 훅 " + ("제거" if UNINSTALL else "등록"))


def files():
    if UNINSTALL:
        if os.path.isdir(SKILL_DIR) and not DRY:
            shutil.rmtree(SKILL_DIR)
        say("skill 제거 (기록 데이터 ~/.follow_wollof/sessions 는 유지)")
        return
    if not DRY:
        for d in (BIN, SKILL_DIR):
            if not os.path.isdir(d):
                os.makedirs(d)
        for f in ("follow.py", "stop_hook.py"):
            shutil.copy2(os.path.join(PKG, f), os.path.join(BIN, f))
        with open(os.path.join(PKG, "skills", "follow", "SKILL.md"), encoding="utf-8") as fh:
            skill = fh.read().replace("{FOLLOW}", FOLLOW_CMD)
        write(os.path.join(SKILL_DIR, "SKILL.md"), skill)
    say("bin/follow.py, bin/stop_hook.py, skills/follow 설치  (명령: %s)" % FOLLOW_CMD)


if __name__ == "__main__":
    if not DRY and not os.path.isdir(os.path.dirname(BIN)):
        os.makedirs(os.path.dirname(BIN))
    private(os.path.dirname(BIN), 0o700)   # ~/.follow_wollof: plans and logs, owner-only on shared servers
    for path in (CLAUDE_MD, SETTINGS):        # backups from earlier installs, too
        private(path + ".bak-follow_wollof", 0o600)
    files()
    claude_md()
    settings()
