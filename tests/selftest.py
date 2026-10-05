#!/usr/bin/env python3
"""follow_wollof self-test: runs every piece on this computer without touching your real setup.

All work happens in a throw-away home folder (HOME and USERPROFILE are redirected for every child
process), so your ~/.claude and ~/.follow_wollof are never read or changed. Remote hosts are not used.

    fw selftest
"""
import datetime
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))
sys.path.insert(0, os.path.join(ROOT, "session"))
import config  # noqa: E402
import follow  # noqa: E402

WIN = os.name == "nt"
PY = config.console_python()
FOLLOW = os.path.join(ROOT, "session", "follow.py")
HOOK = os.path.join(ROOT, "session", "stop_hook.py")
INSTALL = os.path.join(ROOT, "session", "install.py")
AGENT = os.path.join(ROOT, "agent", "agent.py")
APP = os.path.join(ROOT, "server", "app.py")
FW = os.path.join(ROOT, "fw.py")
results = []

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("  ✓ " if cond else "  ✗ ") + name + ("" if cond or not detail else "  — " + str(detail)[:300]))
    return bool(cond)


def run(args, env, stdin=None, timeout=60):
    return subprocess.run([PY] + args, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          env=env, timeout=timeout)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def get(url, host=None, timeout=3):
    req = urllib.request.Request(url, headers={"Host": host} if host else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""
    except Exception as e:
        return None, repr(e).encode()


def wait(cond, seconds):
    end = time.time() + seconds
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.25)
    return cond()


def read_events(home, sid):
    with open(os.path.join(home, ".follow_wollof", "sessions", sid, "events.jsonl"), encoding="utf-8") as fh:
        return [json.loads(l) for l in fh if l.strip()]


def write(path, text, newline=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline=newline) as fh:
        fh.write(text)


# ── tests ───────────────────────────────────────────────────────────────

def t_config(tmp):
    print("설정 파일")
    cfg = config.load(os.path.join(ROOT, "config.example.ini"))
    ok("config.example.ini 읽기", cfg["hosts"] and cfg["hosts"][0]["type"] == "local")
    bom = os.path.join(tmp, "bom.ini")
    with open(os.path.join(ROOT, "config.example.ini"), encoding="utf-8") as fh:
        write(bom, "\ufeff" + fh.read())
    ok("BOM 이 붙은 설정 파일 (메모장)", config.load(bom)["port"] == 7777)
    if WIN:
        got = config.split_options(r'-i C:\keys\id -o "ProxyJump=a b"')
        ok("ssh 옵션의 Windows 경로 유지", got == ["-i", r"C:\keys\id", "-o", "ProxyJump=a b"], got)
    else:
        got = config.split_options('-i ~/keys/id -o "ProxyJump=a b"')
        ok("ssh 옵션 나누기", got == ["-i", "~/keys/id", "-o", "ProxyJump=a b"], got)
    ok("로컬 감시용 파이썬은 콘솔 파이썬", not os.path.basename(config.console_python()).lower().startswith("pythonw"))


def t_follow(home, env):
    print("기록 명령 follow.py")
    e = dict(env, FOLLOW_SESSION_ID="selftest")
    steps = [
        ["plan", "자가 점검 계획", "a:첫 단계", "b:둘째", "c:셋째<a"],
        ["next", "a"],
        ["derive", "x", "갈라진 단계", "--from", "a", "--into", "c", "--reason", "점검"],
        ["drop", "b", "--reason", "필요 없음", "--by", "c"],
        ["next", "x"],
        ["replan", "재계획 점검", "a:첫 단계", "x:갈라진 단계<a", "c:셋째<a,x", "d:넷째<c"],
    ]
    for args in steps:
        r = run([FOLLOW] + args, e)
        if not ok("follow.py " + args[0], r.returncode == 0, r.stderr.decode("utf-8", "replace")):
            return
    r = run([FOLLOW, "next", "nope"], e)
    ok("없는 단계는 거부", r.returncode == 1 and "없는 단계" in r.stderr.decode("utf-8", "replace"))
    r = run([FOLLOW, "show"], e)
    out = r.stdout.decode("utf-8", "replace")
    ok("show 출력 (UTF-8)", r.returncode == 0 and "▶" in out and "갈라진 단계" in out, out)
    ev = read_events(home, "selftest")
    ok("기록 시각에 숫자 시간대", all(re.search(r"[+-]\d\d:\d\d$", x["t"]) for x in ev), ev[0]["t"])
    g = follow.replay(ev)
    n = g["nodes"]
    ok("재생 결과: 완료·진행·제외·파생·재계획",
       n["a"]["state"] == "done" and n["x"]["state"] == "now" and n["b"]["state"] == "dropped"
       and n["b"]["by"] == "c" and n["x"]["from"] == "a" and "x" in n["c"]["deps"] and n["d"]["state"] == "left"
       and g["v"] == 2, {k: (v["state"], v["deps"]) for k, v in n.items()})


def t_hook(home, env):
    print("Stop 훅")
    tdir = os.path.join(home, "transcripts")

    def transcript(name, tools, follow_call=False):
        lines = [{"type": "user", "message": {"role": "user", "content": "작업해줘"}}]
        for i in range(tools):
            cmd = "python3 follow.py next a" if follow_call and i == 0 else "ls"
            lines.append({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "name": "Bash", "input": {"command": cmd}}]}})
        path = os.path.join(tdir, name + ".jsonl")
        write(path, "\n".join(json.dumps(l, ensure_ascii=False) for l in lines) + "\n")
        return path

    def hook(sid, path, active=False):
        data = json.dumps({"session_id": sid, "transcript_path": path, "stop_hook_active": active}).encode()
        r = run([HOOK], env, stdin=data)
        out = r.stdout.decode("utf-8", "replace").strip()
        return json.loads(out) if out else None

    busy = transcript("busy", 6)
    first = hook("selftest", busy)
    ok("계획 있음 + 기록 누락 → 1회 알림", first and first.get("decision") == "block" and "갈라진 단계" in first["reason"], first)
    ok("20분 안에는 다시 알리지 않음", hook("selftest", busy) is None)
    ok("stop_hook_active 이면 통과", hook("selftest", busy, active=True) is None)
    os.remove(os.path.join(home, ".follow_wollof", "sessions", "selftest", ".nudged"))
    ok("이번 턴에 follow.py 를 썼으면 통과", hook("selftest", transcript("touched", 6, follow_call=True)) is None)
    many = transcript("many", 12)
    first = hook("noplan", many)
    ok("계획 없음 + 도구 10회 이상 → 1회 알림", first and first.get("decision") == "block")
    ok("계획 없음 알림은 세션당 한 번", hook("noplan", many) is None)
    ok("짧은 턴은 통과", hook("selftest-short", transcript("short", 2)) is None)


def t_install(home, env):
    print("설치·제거 install.py")
    claude = os.path.join(home, ".claude")
    md_orig = "# 내 설정\r\n기존 줄\r\n"
    write(os.path.join(claude, "CLAUDE.md"), md_orig, newline="")
    settings = {"model": "keep-me", "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo keep"}]}]}}
    write(os.path.join(claude, "settings.json"), json.dumps(settings))
    r = run([INSTALL], env)
    ok("설치 실행", r.returncode == 0, r.stderr.decode("utf-8", "replace") or r.stdout.decode("utf-8", "replace"))
    st = os.path.join(home, ".follow_wollof")
    ok("bin/follow.py · stop_hook.py 설치", all(os.path.exists(os.path.join(st, "bin", f)) for f in ("follow.py", "stop_hook.py")))
    with open(os.path.join(claude, "skills", "follow", "SKILL.md"), encoding="utf-8") as fh:
        skill = fh.read()
    ok("/follow 스킬에 명령 경로 채움", "{FOLLOW}" not in skill and "follow.py" in skill)
    with open(os.path.join(claude, "CLAUDE.md"), encoding="utf-8", newline="") as fh:
        md = fh.read()
    ok("CLAUDE.md 블록 추가 + 기존 내용 유지", md.startswith(md_orig.rstrip("\r\n")) and md.count("follow_wollof:start") == 1)
    ok("CLAUDE.md 줄바꿈(CRLF) 유지", "\n" not in md.replace("\r\n", ""))
    with open(os.path.join(claude, "settings.json"), encoding="utf-8") as fh:
        s = json.load(fh)
    cmds = [h["command"] for m in s["hooks"]["Stop"] for h in m["hooks"]]
    ok("settings.json: 기존 훅·설정 유지 + Stop 훅 추가", "echo keep" in cmds and s["model"] == "keep-me"
       and sum("stop_hook.py" in c for c in cmds) == 1, cmds)
    ok("처음 설치 시 백업", os.path.exists(os.path.join(claude, "settings.json.bak-follow_wollof"))
       and os.path.exists(os.path.join(claude, "CLAUDE.md.bak-follow_wollof")))
    hook_cmd = [c for c in cmds if "stop_hook.py" in c][0]
    data = json.dumps({"session_id": "x", "transcript_path": "/none", "stop_hook_active": True})
    r = subprocess.run(hook_cmd, shell=True, input=data.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       env=env, timeout=30)
    ok("등록된 훅 명령이 실제로 실행됨", r.returncode == 0, hook_cmd + " → " + r.stderr.decode("utf-8", "replace"))
    # another tool appends its own Stop hook after ours: reinstalling must not rewrite the file
    with open(os.path.join(claude, "settings.json"), encoding="utf-8") as fh:
        s = json.load(fh)
    s["hooks"]["Stop"].append({"hooks": [{"type": "command", "command": "echo other-tool"}]})
    write(os.path.join(claude, "settings.json"), json.dumps(s, indent=2))
    with open(os.path.join(claude, "settings.json"), "rb") as fh:
        before = fh.read()
    run([INSTALL], env)
    with open(os.path.join(claude, "settings.json"), "rb") as fh:
        ok("다른 도구 훅이 뒤에 붙어 있어도 다시 쓰지 않음", fh.read() == before)
    with open(os.path.join(claude, "settings.json"), encoding="utf-8") as fh:
        again = sum("stop_hook.py" in h["command"] for m in json.load(fh)["hooks"]["Stop"] for h in m["hooks"])
    with open(os.path.join(claude, "CLAUDE.md"), encoding="utf-8") as fh:
        blocks = fh.read().count("follow_wollof:start")
    ok("다시 설치해도 중복 없음", again == 1 and blocks == 1)
    r = run([INSTALL, "--uninstall"], env)
    with open(os.path.join(claude, "CLAUDE.md"), encoding="utf-8", newline="") as fh:
        md = fh.read()
    with open(os.path.join(claude, "settings.json"), encoding="utf-8") as fh:
        s = json.load(fh)
    ok("제거: CLAUDE.md 원래대로", md == md_orig, repr(md[:120]))
    ok("제거: 우리 훅만 빠짐", [h["command"] for m in s["hooks"]["Stop"] for h in m["hooks"]] == ["echo keep", "echo other-tool"]
       and s["model"] == "keep-me")
    ok("제거: 스킬 삭제", not os.path.exists(os.path.join(claude, "skills", "follow")))


def t_agent(home, env):
    print("세션 감지 agent.py")
    sess = os.path.join(home, ".claude", "sessions")
    dead = subprocess.Popen([PY, "-c", "pass"])
    dead.wait()
    now = int(time.time() * 1000)
    entries = [
        (os.getpid(), {"sessionId": "s-live", "name": "first", "status": "idle", "statusUpdatedAt": now - 5000}),
        (os.getppid(), {"sessionId": "s-live", "name": "second", "status": "busy", "statusUpdatedAt": now}),
        (dead.pid, {"sessionId": "s-dead", "name": "gone", "status": "busy", "statusUpdatedAt": now}),
    ]
    for pid, reg in entries:
        write(os.path.join(sess, "%d.json" % pid), json.dumps(dict(reg, pid=pid, cwd=home)))
    write(os.path.join(home, ".claude", "projects", "-selftest", "s-live.jsonl"),
          json.dumps({"type": "ai-title", "aiTitle": "자가 점검 세션"}, ensure_ascii=False) + "\n" +
          json.dumps({"type": "last-prompt", "lastPrompt": "점검해줘"}, ensure_ascii=False) + "\n")
    write(os.path.join(home, ".follow_wollof", "sessions", "s-live", "events.jsonl"),
          json.dumps({"op": "plan", "title": "점검", "nodes": [{"id": "a", "title": "A"}]}, ensure_ascii=False) + "\n")
    r = run([AGENT, "--once"], env)
    try:
        d = json.loads(r.stdout.decode("utf-8"))
    except Exception:
        ok("agent.py --once 실행", False, r.stderr.decode("utf-8", "replace"))
        return
    ids = [s["sessionId"] for s in d["sessions"]]
    ok("실행 중인 프로세스만 표시 (종료된 pid 제외)", "s-dead" not in ids and "s-live" in ids, ids)
    live = [s for s in d["sessions"] if s["sessionId"] == "s-live"]
    ok("같은 세션 ID 는 하나로 (활동 중인 쪽)", len(live) == 1 and live[0]["name"] == "second", live)
    ok("제목·마지막 요청·계획 읽기", live and live[0]["title"] == "자가 점검 세션" and live[0]["lastPrompt"] == "점검해줘"
       and len(live[0]["plan"]) == 1)


def t_server(home, env):
    print("대시보드 서버")
    port = free_port()
    cfg = os.path.join(home, "fw-test.ini")
    write(cfg, "[dashboard]\nport = %d\n\n[agent]\ninterval = 0.5\n\n[host:local]\ntype = local\n" % port)
    e = dict(env, FW_CONFIG=cfg)
    base = "http://127.0.0.1:%d" % port
    proc = subprocess.Popen([PY, APP], env=e, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        up = wait(lambda: get(base + "/api/state")[0] == 200, 15)
        if not ok("서버 시작", up, proc.stderr.read().decode("utf-8", "replace") if proc.poll() is not None else ""):
            return

        def live():
            code, body = get(base + "/api/state")
            if code != 200:
                return None
            h = json.loads(body)["hosts"][0]
            return h if h["connected"] and h["sessions"] else None
        h = wait(live, 15) and live()
        ok("로컬 세션이 화면 데이터에 나옴", h and h["sessions"][0]["sessionId"] == "s-live", h)
        code, body = get(base + "/")
        ok("페이지 제공", code == 200 and b"follow_wollof" in body)
        ok("그래프 스크립트 제공", get(base + "/graph.js")[0] == 200)
        ok("외부 도메인 이름 차단 (DNS rebinding)", get(base + "/api/state", host="evil.example:%d" % port)[0] == 403)
        with urllib.request.urlopen(base + "/events", timeout=5) as r:
            first = r.readline().decode("utf-8", "replace")
        ok("실시간 스트림 (SSE)", first.startswith("data:") and "hosts" in first, first[:80])
        pid_file = os.path.join(home, ".follow_wollof", "server-%d.pid" % port)
        ok("pid 파일 기록", os.path.exists(pid_file))
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()


def t_fw(home, env):
    print("실행 도구 fw")
    port = free_port()
    cfg = os.path.join(home, "fw-cmd.ini")
    write(cfg, "[dashboard]\nport = %d\n\n[host:local]\ntype = local\n" % port)
    e = dict(env, FW_CONFIG=cfg)
    r = run([FW, "help"], e)
    ok("fw help", r.returncode == 0 and "fw deploy" in r.stdout.decode("utf-8", "replace"))
    r = run([FW, "check"], e, timeout=90)
    out = r.stdout.decode("utf-8", "replace")
    ok("fw check (이 컴퓨터 + local)", r.returncode == 0 and "✓" in out, out + r.stderr.decode("utf-8", "replace"))
    r = run([FW, "start"], e, timeout=60)
    ok("fw start (백그라운드 실행)", r.returncode == 0 and get("http://127.0.0.1:%d/api/state" % port)[0] == 200,
       r.stderr.decode("utf-8", "replace"))
    r = run([FW, "status"], e)
    ok("fw status", "실행 중" in r.stdout.decode("utf-8", "replace"))
    r = run([FW, "stop"], e, timeout=60)
    ok("fw stop", r.returncode == 0 and get("http://127.0.0.1:%d/api/state" % port, timeout=1)[0] is None,
       r.stderr.decode("utf-8", "replace"))
    if not WIN:   # Windows TerminateProcess cannot run cleanup; the next `fw stop` clears a stale file instead
        ok("종료 시 pid 파일 정리", not os.path.exists(os.path.join(home, ".follow_wollof", "server-%d.pid" % port)))


def main():
    print("follow_wollof selftest — %s, Python %s" % (sys.platform, sys.version.split()[0]))
    tmp = tempfile.mkdtemp(prefix="fw-selftest-")
    home = os.path.join(tmp, "home")
    os.makedirs(os.path.join(home, ".claude"))
    env = dict(os.environ, HOME=home, USERPROFILE=home, PYTHONIOENCODING="utf-8")
    for k in ("CLAUDE_CODE_SESSION_ID", "FOLLOW_SESSION_ID", "CLAUDE_PID", "FW_CONFIG"):
        env.pop(k, None)
    try:
        for t in (t_config, t_follow, t_hook, t_install, t_agent, t_server, t_fw):
            try:
                t(tmp) if t is t_config else t(home, env)
            except Exception as e:
                ok(t.__name__ + " 실행 중 오류", False, repr(e))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    failed = results.count(False)
    print("\n%d개 중 %d개 통과%s" % (len(results), len(results) - failed, "" if not failed else " — 실패 %d개" % failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
