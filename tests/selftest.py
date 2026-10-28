#!/usr/bin/env python3
"""follow_wollof self-test: runs every piece on this computer without touching your real setup.

All work happens in a throw-away home folder (HOME and USERPROFILE are redirected for every child
process), so your ~/.claude and ~/.follow_wollof are never read or changed. Remote hosts are not used.

    fw selftest
"""
import base64
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
import urllib.parse
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
INVENTORY = os.path.join(ROOT, "agent", "inventory.py")
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
    pj = os.path.join(tmp, "projects.ini")
    write(pj, "[host:local]\ntype = local\n\n[host:Lab]\ntype = ssh\nssh = lab\n\n[project:유방암]\nlab = /data/a, /data/b c\n"
              "local = C:\\work\\x\ndata = 00_raw_data\n\n[notify]\nevents = ended, waiting\n")
    c = config.load(pj)
    ok("프로젝트 섹션 읽기", c["projects"] == [{"name": "유방암", "folders": {"Lab": ["/data/a", "/data/b c"], "local": ["C:\\work\\x"]},
                                           "data": ["00_raw_data"]}], c["projects"])
    ok("알림 설정 읽기", c["notify"]["enabled"] and c["notify"]["events"] == ["ended", "waiting"], c["notify"])
    write(pj, "[host:local]\ntype = local\n\n[project:x]\nnope = /a\n")
    try:
        config.load(pj)
        ok("프로젝트에 없는 호스트 이름은 오류", False)
    except config.ConfigError:
        ok("프로젝트에 없는 호스트 이름은 오류", True)


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
        ["topic", "NCC RNAseq", "벌크", "방향"],
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
    if not WIN:
        mode = os.stat(os.path.join(home, ".follow_wollof")).st_mode & 0o777
        ok("기록 폴더는 본인만 접근 (700)", mode == 0o700, oct(mode))
    ev = read_events(home, "selftest")
    ok("기록 시각에 숫자 시간대", all(re.search(r"[+-]\d\d:\d\d$", x["t"]) for x in ev), ev[0]["t"])
    g = follow.replay(ev)
    n = g["nodes"]
    ok("재생 결과: 완료·진행·제외·파생·재계획",
       n["a"]["state"] == "done" and n["x"]["state"] == "now" and n["b"]["state"] == "dropped"
       and n["b"]["by"] == "c" and n["x"]["from"] == "a" and "x" in n["c"]["deps"] and n["d"]["state"] == "left"
       and g["v"] == 2, {k: (v["state"], v["deps"]) for k, v in n.items()})
    ok("주제 기록: slug 로 통일 + 방향", g["topics"] == ["ncc-rnaseq"] and g["angle"] == "벌크 방향", (g["topics"], g["angle"]))
    rep = os.path.join(home, "report.pdf")
    write(rep, "%PDF-1.4 selftest")
    r = run([FOLLOW, "out", "x", rep], e)
    g = follow.replay(read_events(home, "selftest"))
    ok("out: 단계에 산출물 연결 (절대 경로)", r.returncode == 0 and [f["path"] for f in g["nodes"]["x"]["outs"]] == [rep],
       r.stderr.decode("utf-8", "replace"))
    r = run([FOLLOW, "out", "x", os.path.join(home, "없는.pdf")], e)
    ok("out: 없는 파일은 거부", r.returncode == 1)
    r = run([FOLLOW, "topics"], env)   # no session id: listing must still work
    ok("topics 는 세션 밖에서도 목록 출력", r.returncode == 0 and "ncc-rnaseq" in r.stdout.decode("utf-8", "replace"),
       r.stderr.decode("utf-8", "replace"))
    pe = dict(env, FOLLOW_SESSION_ID="selftest-par")
    for args in (["plan", "병렬 계획", "a:A", "b:B<a", "c:C<a", "d:D<b"], ["next", "a"], ["next", "b"], ["now", "c"], ["next", "d"]):
        run([FOLLOW] + args, pe)
    n = follow.replay(read_events(home, "selftest-par"))["nodes"]
    ok("병렬 갈래: next 는 그 단계가 기다리는 갈래만 끝냄", (n["b"]["state"], n["c"]["state"], n["d"]["state"]) == ("done", "now", "now"),
       {k: v["state"] for k, v in n.items()})
    r = run([FOLLOW, "plan", "주제 포함 계획", "p:첫", "--topic", "wgs-somatic"], dict(env, FOLLOW_SESSION_ID="selftest-topic"))
    ok("plan --topic", r.returncode == 0 and follow.replay(read_events(home, "selftest-topic"))["topics"] == ["wgs-somatic"],
       r.stderr.decode("utf-8", "replace"))


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
    if not WIN:
        modes = [os.stat(os.path.join(claude, f)).st_mode & 0o777 for f in ("settings.json.bak-follow_wollof", "CLAUDE.md.bak-follow_wollof")]
        ok("백업 파일은 본인만 읽기 (600)", modes == [0o600, 0o600], [oct(m) for m in modes])
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
    write(os.path.join(sess, "rc.json"), json.dumps({"sessionId": "s-rc-idle", "pid": os.getpid(), "cwd": home, "status": "idle",
                                                     "entrypoint": "sdk-cli", "statusUpdatedAt": now - 7 * 3600 * 1000}))
    work = os.path.join(home, "proj", "daily_analysis", "2026-10-27", "deg_check")
    write(os.path.join(work, "01_scripts", "01_deg.R"), "x")
    write(os.path.join(work, "output", "deg.tsv"), "gene\n")
    write(os.path.join(home, ".claude", "projects", "-selftest", "s-live.jsonl"),
          json.dumps({"type": "ai-title", "aiTitle": "자가 점검 세션"}, ensure_ascii=False) + "\n" +
          json.dumps({"type": "user", "timestamp": "2026-10-27T10:00:00Z", "message": {"role": "user", "content": "반응군 DEG 다시 돌려줘"}}, ensure_ascii=False) + "\n" +
          json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Write",
                      "input": {"file_path": work.replace(os.sep, "/") + "/output/deg.tsv"}}]}}, ensure_ascii=False) + "\n" +
          json.dumps({"type": "assistant", "message": {"content": [
              {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "head 00_raw_data/02_RNA/counts.tsv"}},
              {"type": "tool_use", "id": "t2", "name": "TodoWrite", "input": {"todos": [{"content": "정규화", "status": "completed"},
                                                                                   {"content": "DEG", "status": "in_progress"}]}},
              {"type": "tool_use", "id": "t3", "name": "Agent", "input": {"description": "문헌 찾기", "prompt": "x"}}]}}, ensure_ascii=False) + "\n" +
          json.dumps({"type": "assistant", "message": {"content": [
              {"type": "tool_use", "id": "t4", "name": "Bash", "input": {"command": "sort big.tsv", "description": "긴 정렬", "run_in_background": True}},
              {"type": "tool_use", "id": "t5", "name": "Agent", "input": {"description": "배경 검토", "prompt": "x", "run_in_background": True}},
              {"type": "tool_use", "id": "t6", "name": "Workflow", "input": {"script": "export const meta = { name: 'review-x', description: 'd' }"}}]}}) + "\n" +
          json.dumps({"type": "user", "message": {"role": "user", "content": [
              {"type": "tool_result", "tool_use_id": "t4", "content": "Command running in background with ID: b1"},
              {"type": "tool_result", "tool_use_id": "t5", "content": "Async agent launched successfully."},
              {"type": "tool_result", "tool_use_id": "t6", "content": "Workflow started"}]}}) + "\n" +
          json.dumps({"type": "user", "message": {"role": "user", "content":
              "<task-notification>\n<tool-use-id>t4</tool-use-id>\n<status>completed</status>\n</task-notification>"
              "<task-notification>\n<tool-use-id>t5</tool-use-id>\n<status>failed</status>\n</task-notification>"}}) + "\n" +
          json.dumps({"type": "last-prompt", "lastPrompt": "점검해줘"}, ensure_ascii=False) + "\n")
    out_file = os.path.join(home, "out", "결과.csv")
    write(out_file, "gene,padj\nTP53,0.01\n")
    write(os.path.join(home, ".follow_wollof", "sessions", "s-live", "events.jsonl"),
          json.dumps({"op": "plan", "title": "점검", "nodes": [{"id": "a", "title": "A"}]}, ensure_ascii=False) + "\n" +
          json.dumps({"op": "out", "id": "a", "files": [{"path": out_file, "name": "결과.csv"}]}, ensure_ascii=False) + "\n")
    for sid, age in (("s-ended", 3600), ("s-old", 30 * 86400)):
        ev = os.path.join(home, ".follow_wollof", "sessions", sid, "events.jsonl")
        write(ev, json.dumps({"op": "plan", "title": "끝난 계획", "cwd": "/w", "nodes": [{"id": "a", "title": "A"}]}, ensure_ascii=False) + "\n")
        os.utime(ev, (time.time() - age, time.time() - age))
    r = run([AGENT, "--once"], env)
    try:
        d = json.loads(r.stdout.decode("utf-8"))
    except Exception:
        ok("agent.py --once 실행", False, r.stderr.decode("utf-8", "replace"))
        return
    ids = [s["sessionId"] for s in d["sessions"]]
    ok("실행 중인 프로세스만 표시 (종료된 pid 제외)", "s-dead" not in ids and "s-live" in ids, ids)
    ok("오래 쉬는 Remote Control 세션은 제외", "s-rc-idle" not in ids, ids)
    live = [s for s in d["sessions"] if s["sessionId"] == "s-live"]
    ok("같은 세션 ID 는 하나로 (활동 중인 쪽)", len(live) == 1 and live[0]["name"] == "second", live)
    ok("제목·마지막 요청·계획 읽기", live and live[0]["title"] == "자가 점검 세션" and live[0]["lastPrompt"] == "점검해줘"
       and len(live[0]["plan"]) == 2)
    ok("세션이 하는 일: 받은 요청 · 할 일 · 에이전트·백그라운드 명령·워크플로와 완료 알림", live and [a["t"] for a in live[0].get("asks", [])] == ["반응군 DEG 다시 돌려줘"]
       and [(t["t"], t["s"]) for t in live[0].get("todos", [])] == [("정규화", "done"), ("DEG", "now")]
       and [(a["t"], a["s"], a["k"]) for a in live[0].get("agents", [])] == [("문헌 찾기", "now", "agent"), ("긴 정렬", "done", "bg"),
                                                                             ("배경 검토", "blocked", "agent"), ("review-x", "now", "wf")], live and {k: live[0].get(k) for k in ("asks", "todos", "agents")})
    ok("대화에서 건드린 데이터 경로", live and ["00_raw_data/02_RNA", 1] in [list(x) for x in live[0].get("dataRefs", [])], live and live[0].get("dataRefs"))
    ok("분석 폴더와 그 안의 파일 (실행 중 세션)", live and os.path.normpath(live[0].get("workDir") or "") == os.path.normpath(work)
       and sorted(f[0] for f in live[0].get("work") or []) == ["01_scripts/01_deg.R", "output/deg.tsv"], live and live[0].get("work"))
    by = {s["sessionId"]: s for s in d["sessions"]}
    ok("최근 종료된 세션은 ended 로, 7일 지난 것은 제외", by.get("s-ended", {}).get("status") == "ended"
       and by["s-ended"]["cwd"] == "/w" and "s-old" not in by, sorted(by))


def t_projects(home, env):
    print("프로젝트 · 데이터 현황 · 알림")
    import app
    P = [{"name": "A", "folders": {"lab": ["/r/01_ncc"], "pc": ["C:\\Work\\NCC"]}, "data": []},
         {"name": "B", "folders": {"lab": ["/r/01_ncc/sub"]}, "data": []}]
    ok("작업 폴더 아래 세션은 그 프로젝트", app.project_of(P, "lab", {"cwd": "/r/01_ncc/figs"}) == "A")
    ok("폴더 이름 경계 (01_ncc_old 는 아님)", app.project_of(P, "lab", {"cwd": "/r/01_ncc_old"}) is None)
    ok("더 깊은 폴더의 프로젝트가 이김", app.project_of(P, "lab", {"cwd": "/r/01_ncc/sub/x"}) == "B")
    ok("계획을 세운 폴더 먼저", app.project_of(P, "lab", {"cwd": "/r", "plan": [{"op": "plan", "cwd": "/r/01_ncc/x"}]}) == "A")
    ok("Windows 경로는 대소문자·슬래시 무시", app.project_of(P, "pc", {"cwd": "c:/work/ncc/figs"}) == "A")
    ok("다른 호스트의 같은 경로는 아님", app.project_of(P, "pc", {"cwd": "/r/01_ncc"}) is None)
    probe = os.path.join(home, "argv_probe.py")
    write(probe, "import sys\nprint(len(sys.argv[1]))\n")
    r = subprocess.run([PY, "-"], input=app.script_with_arg(probe, "A" * 20000), stdout=subprocess.PIPE)
    ok("긴 인자도 stdin 으로 그대로 (ssh 명령줄 8KB 제한)", r.stdout.strip() == b"20000", r.stdout)

    proj = os.path.join(home, "inv-proj")
    for name in ("P1_tumor.sorted.bam", "P2_tumor.sorted.bam"):
        write(os.path.join(proj, "00_raw_data", "01_DNA", name), "x" * 100)
    write(os.path.join(proj, "00_raw_data", "01_DNA", "README.md"), "# DNA\n\nWGS 종양 BAM\n")
    for name in ("P1_R1.fastq.gz", "P1_R2.fastq.gz", "P2_R1.fastq.gz", "P2_R2.fastq.gz"):
        write(os.path.join(proj, "00_raw_data", "02_RNA", name), "y" * 50)
    for sample in ("S1", "S2"):
        write(os.path.join(proj, "03_sub", "00_rawdata", sample, "Aligned.out.bam"), "z")
    rd = os.path.join(proj, "daily_analysis", "2026-10-20", "cnv_scan")
    write(os.path.join(rd, "REPORT.md"), "# CNV 지형\n\n## 논지 흐름\n\n- 확인 1, 부담. 높은 군이 큼 → 지지\n- 확인 2, 시점. 차이 없음 → 미결\n\n"
                                         "## 사용한 데이터\n\n`00_raw_data/01_DNA/P1_tumor.sorted.bam` 과 `output/x.tsv`\n")
    write(os.path.join(rd, "00_WHY.md"), "# 왜\n\nCNV 부담이 군마다 다른가\n")
    write(os.path.join(rd, "01_scripts", "01_load.R"), "x")
    write(os.path.join(rd, "01_scripts", "02_compare.R"), "x")
    write(os.path.join(rd, "output", "burden.tsv"), "a\tb\n")
    write(os.path.join(rd, "plot", "burden.svg"), "<svg/>")
    write(os.path.join(proj, "RESULTS_DIGEST.md"), "<!--\n- [2026-01-01] 예시라 무시 [가설]\n-->\n## 배치\n- [2026-07-23] 보정 후 신호 유지 [추론]\n")
    write(os.path.join(proj, "analysis_backlog", "backlog.md"), "# 백로그\n- [ ] 공간 비교\n- [x] 끝난 일\n")
    linked = False
    try:
        os.symlink(os.path.join(proj, "00_raw_data"), os.path.join(proj, "data"))
        linked = True
    except (OSError, NotImplementedError):   # Windows without the symlink privilege
        pass
    arg = base64.b64encode(json.dumps([{"folder": proj}, {"folder": "/없는/폴더"}]).encode()).decode()
    with open(INVENTORY, "rb") as fh:
        r = run(["-", arg], env, stdin=fh.read())
    try:
        d = json.loads(r.stdout.decode("utf-8"))
        f = d["folders"][proj]
        cats = {c["name"]: c for c in f["data"]}
    except Exception as e:
        return ok("데이터 현황 읽기 (inventory.py)", False, repr(e) + r.stderr.decode("utf-8", "replace"))
    dna = cats.get("DNA", {})
    ok("데이터 폴더별 개수·크기·형식", dna.get("files") == 2 and dna.get("bytes") == 200 and dna.get("kinds", {}).get("reads", [0])[0] == 2, dna)
    ok("README 첫 줄은 설명, 개수에서는 빠짐", dna.get("note") == "WGS 종양 BAM", dna)
    ok("샘플 수 추정 (R1/R2 · 샘플별 폴더)", cats.get("RNA", {}).get("samples") == 2 and cats.get("sub", {}).get("samples") == 2, cats)
    if linked:
        ok("링크로 겹친 data 폴더는 한 번만", [c["name"] for c in f["data"]].count("DNA") == 1, [c["name"] for c in f["data"]])
    ok("보고서 · 발견 · 백로그", f["reports"] and f["reports"][0]["title"] == "CNV 지형"
       and [x["text"] for x in f["findings"]] == ["보정 후 신호 유지"] and f["backlog"] == ["공간 비교"], f)
    ok("없는 폴더", d["folders"]["/없는/폴더"] == {"exists": False})
    rf = f["reports"][0] if f["reports"] else {}
    ok("분석 흐름: 질문 · 스크립트 · 표 · 그림", rf.get("why") == "CNV 부담이 군마다 다른가" and rf.get("scripts") == ["01_scripts/01_load.R", "01_scripts/02_compare.R"]
       and rf.get("tables") == 1 and rf.get("figures") == 1, rf)
    ok("분석 흐름: 보고서에 적힌 데이터 경로와 판정", rf.get("inputs") == [os.path.join(proj, "00_raw_data", "01_DNA", "P1_tumor.sorted.bam")]
       and [(c["text"], c["verdict"]) for c in rf.get("checks", [])] == [("확인 1, 부담", "지지"), ("확인 2, 시점", "미결")], rf)

    import notify
    sent = []
    w = notify.Watcher({"notify": {"enabled": True, "events": list(config.NOTIFY_EVENTS), "min_busy": 60}, "port": 7777},
                       send=lambda *a: sent.append(a))
    ses = lambda sid, st, since, plan=None: {"sessionId": sid, "status": st, "statusUpdatedAt": since * 1000,
                                             "title": "분석 " + sid, "plan": plan or []}
    blocked = [{"op": "plan", "title": "T", "nodes": [{"id": "x", "title": "정렬"}]}, {"op": "next", "id": "x"},
               {"op": "state", "id": "x", "state": "blocked", "note": "경로 확인"}]
    w.update("lab", [ses("a", "busy", 1000), ses("b", "busy", 1000), ses("c", "idle", 900)], now=1000)
    ok("첫 스냅샷은 알리지 않음", not sent)
    got = w.update("lab", [ses("a", "idle", 1200), ses("b", "waiting", 1010, blocked), ses("c", "idle", 900)], now=1200)
    ok("작업 멈춤 · 입력 대기 · 막힘 알림", sorted(x["kind"] for x in got) == ["blocked", "stopped", "waiting"], got)
    ok("알림을 누르면 그 세션 페이지", any(x["url"].endswith("/?s=lab/a") for x in got), got)
    got = w.update("lab", [ses("a", "idle", 1200), ses("b", "waiting", 1010, blocked)], now=1250)
    ok("세션 종료 알림", [x["kind"] for x in got] == ["ended"], got)
    w.update("lab", [ses("d", "busy", 1300)], now=1300)
    ok("짧게 일하고 멈추면 알리지 않음", not w.update("lab", [ses("d", "idle", 1310)], now=1310))
    # epoch + offset: fromtimestamp() rejects negative times on Windows
    old = (datetime.datetime.fromtimestamp(0, datetime.timezone.utc) + datetime.timedelta(seconds=1000 - 3 * 3600)).isoformat()
    w.update("h2", [ses("z", "busy", 900, [{"op": "plan", "title": "T", "nodes": [{"id": "x", "title": "정렬"}], "t": old},
                                           {"op": "next", "id": "x", "t": old}])], now=1000)
    ok("2시간 기록 없는 단계는 정체 알림", [x["kind"] for x in w.tick(now=1000)] == ["stale"])
    ok("정체 알림은 한 번만", not w.tick(now=1100))


def t_server(home, env):
    print("대시보드 서버")
    port = free_port()
    cfg = os.path.join(home, "fw-test.ini")
    write(cfg, "[dashboard]\nport = %d\n\n[agent]\ninterval = 0.5\n\n[host:local]\ntype = local\n\n[notify]\nenabled = false\n\n"
               "[project:테스트]\nlocal = %s, %s\n\n[todo]\nhost = local\nclassify = off\n" % (port, home, os.path.join(home, "inv-proj")))
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
        ok("그래프 스크립트 제공", get(base + "/graph.js")[0] == 200 and get(base + "/ontology.js")[0] == 200)
        q = lambda path: base + "/api/file?" + urllib.parse.urlencode({"host": "local", "path": path})
        code, body = get(q(os.path.join(home, "out", "결과.csv")))
        ok("산출물 파일 전달", code == 200 and body.startswith(b"gene,padj"), (code, body[:80]))
        ok("기록되지 않은 경로는 거부", get(q(os.path.join(home, "fw-test.ini")))[0] == 403)
        ok("외부 도메인 이름 차단 (DNS rebinding)", get(base + "/api/state", host="evil.example:%d" % port)[0] == 403)
        with urllib.request.urlopen(base + "/events", timeout=5) as r:
            first = r.readline().decode("utf-8", "replace")
        ok("실시간 스트림 (SSE)", first.startswith("data:") and "hosts" in first, first[:80])
        pid_file = os.path.join(home, ".follow_wollof", "server-%d.pid" % port)
        ok("pid 파일 기록", os.path.exists(pid_file))
        st = json.loads(get(base + "/api/state")[1])
        ok("세션이 설정한 프로젝트에 묶임", st["projects"][0]["name"] == "테스트"
           and st["hosts"][0]["sessions"][0].get("mainProject") == "테스트", st["hosts"][0]["sessions"][:1])

        def scanned():
            inv = json.loads(get(base + "/api/state")[1]).get("inventory", {}).get("local", {})
            return inv.get("folders", {}).get(os.path.join(home, "inv-proj")) if inv.get("t") else None
        ok("프로젝트 폴더의 데이터 현황", wait(scanned, 30) and any(c["name"] == "DNA" for c in scanned()["data"]))

        def post(origin, path="/api/refresh", body=None):
            req = urllib.request.Request(base + path, data=json.dumps(body or {}).encode("utf-8"), method="POST",
                                         headers={"Content-Type": "application/json", **({"Origin": origin} if origin else {})})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return r.status
            except urllib.error.HTTPError as e:
                return e.code
        ok("다시 읽기는 이 대시보드 페이지만", post("http://localhost:%d" % port) == 200 and post("http://evil.example") == 403
           and post(None) == 403)
        me = "http://localhost:%d" % port
        todo = lambda: json.loads(get(base + "/api/state")[1])["todo"].get("items", [])
        ok("질문·할 일: 메모를 항목으로 (분류 끔: 줄마다 하나)", post(me, "/api/todo", {"do": "capture", "text": "- 표 다시 만들기\n- 3군이 왜 갈리지?"}) == 200
           and [(i["text"], i["kind"]) for i in todo()] == [("표 다시 만들기", "todo"), ("3군이 왜 갈리지?", "question")], todo())
        first = (todo() or [{}])[0].get("id")
        post(me, "/api/todo", {"do": "update", "id": first, "set": {"done": True, "project": "테스트", "theme": "표", "links": ["s:local/s-live"]}})
        it = next((i for i in todo() if i["id"] == first), {})
        ok("체크하면 완료 시각과 함께 남고, 프로젝트·테마·연결이 바뀜", it.get("done") and it.get("project") == "테스트" and it.get("theme") == "표"
           and it.get("links") == ["s:local/s-live"], it)
        post(me, "/api/todo", {"do": "delete", "id": first})
        ok("지우기", [i["id"] for i in todo()] == ["Q-0002"], todo())
        ok("다른 사이트는 목록을 못 바꿈", post("http://evil.example", "/api/todo", {"do": "delete", "id": "Q-0002"}) == 403 and len(todo()) == 1)
        hidden = lambda: json.loads(get(base + "/api/state")[1])["todo"].get("hidden", {})
        post(me, "/api/todo", {"do": "hide", "ids": ["s:local/s-live"], "label": "점검"})
        ok("숨기기: 목록 파일에 남아 모든 데스크탑이 같이 봄", hidden().get("s:local/s-live", {}).get("label") == "점검", hidden())
        post(me, "/api/todo", {"do": "unhide", "ids": ["s:local/s-live"]})
        ok("다시 보이기", "s:local/s-live" not in hidden(), hidden())
        post(me, "/api/todo", {"do": "add", "items": [{"text": "노드에서 보낸 질문", "kind": "question", "links": ["s:local/s-live"]}]})
        ok("노드에서 보낸 항목은 그 노드와 연결됨", any(i["text"] == "노드에서 보낸 질문" and i["links"] == ["s:local/s-live"] for i in todo()), todo())
        themes = lambda: json.loads(get(base + "/api/state")[1])["todo"].get("sessionThemes", {})
        post(me, "/api/todo", {"do": "themes", "by": "auto", "project": "테스트", "set": {"s:local/s-live": "DEG 재현"}})
        ok("테마 옮기기: 페이지에서 고른 것은 사용자 분류로 남음", themes().get("s:local/s-live", {}).get("by") == "user"
           and themes()["s:local/s-live"]["theme"] == "DEG 재현", themes())
        store = os.path.join(home, ".follow_wollof", "todo.json")
        auto = lambda t: base64.b64encode(json.dumps({"do": "themes", "by": "auto", "path": store, "set": {"s:local/s-live": t, "s:local/s-new": t}}).encode()).decode()
        run([os.path.join(ROOT, "agent", "todo.py"), auto("자동 테마")], env)
        ok("자동 분류는 사용자가 고른 테마를 덮지 않음", themes().get("s:local/s-live", {}).get("theme") == "DEG 재현"
           or json.load(open(store, encoding="utf-8"))["sessionThemes"]["s:local/s-live"]["theme"] == "DEG 재현", themes())
        ok("자동 분류는 새 세션에 테마를 붙임", json.load(open(store, encoding="utf-8"))["sessionThemes"].get("s:local/s-new", {}).get("by") == "auto")
        ok("단계 바꾸기: 형식이 틀린 요청은 거부", post(me, "/api/step", {"host": "local", "session": "../x", "step": "a", "state": "done"}) == 400
           and post(me, "/api/step", {"host": "local", "session": "s-live-0001", "step": "a", "state": "rm"}) == 400
           and post("http://evil.example", "/api/step", {"host": "local", "session": "s-live-0001", "step": "a", "state": "done"}) == 403)
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


def t_shortcut(home, env):
    print("바로가기 fw shortcut")
    if WIN:   # the real Desktop and Start menu ignore the redirected home, so build one link in the scratch folder
        sys.path.insert(0, ROOT)
        import fw
        link = os.path.join(home, "follow_wollof.lnk")
        try:
            fw.win_link(link, fw.pythonw(), '"%s" window' % FW, os.path.join(fw.ICONS, "follow_wollof.ico"))
        except SystemExit:
            pass
        ok("Windows 바로가기 (.lnk) 생성", os.path.exists(link) and os.path.getsize(link) > 0)
        ok("아이콘 파일", os.path.exists(os.path.join(fw.ICONS, "follow_wollof.ico")))
        return
    r = run([FW, "shortcut", "on", "--no-dock"], env)
    out = r.stdout.decode("utf-8", "replace") + r.stderr.decode("utf-8", "replace")
    if sys.platform == "darwin":
        app = os.path.join(home, "Applications", "follow_wollof.app", "Contents")
        try:
            import plistlib
            with open(os.path.join(app, "Info.plist"), "rb") as fh:
                info = plistlib.load(fh)
        except Exception as e:
            info = {}
            out += repr(e)
        exe = os.path.join(app, "MacOS", info.get("CFBundleExecutable", "?"))
        ok("macOS 앱 묶음 (~/Applications/follow_wollof.app)", r.returncode == 0 and os.access(exe, os.X_OK), out)
        script = ""
        if os.path.exists(exe):
            with open(exe) as fh:
                script = fh.read()
        ok("앱이 fw window 를 실행", FW in script and script.rstrip().endswith("window")
           and subprocess.call(["sh", "-n", exe]) == 0, script)
        ok("앱 아이콘", os.path.exists(os.path.join(app, "Resources", info.get("CFBundleIconFile", "?") + ".icns")))
        made = os.path.dirname(app)
    else:
        made = os.path.join(home, ".local", "share", "applications", "follow_wollof.desktop")
        ok("Linux 메뉴 항목 (.desktop)", r.returncode == 0 and os.path.exists(made), out)
    r = run([FW, "shortcut", "off", "--no-dock"], env)
    ok("fw shortcut off", r.returncode == 0 and not os.path.exists(made), r.stderr.decode("utf-8", "replace"))


def main():
    print("follow_wollof selftest — %s, Python %s" % (sys.platform, sys.version.split()[0]))
    tmp = tempfile.mkdtemp(prefix="fw-selftest-")
    home = os.path.join(tmp, "home")
    os.makedirs(os.path.join(home, ".claude"))
    env = dict(os.environ, HOME=home, USERPROFILE=home, PYTHONIOENCODING="utf-8")
    for k in ("CLAUDE_CODE_SESSION_ID", "FOLLOW_SESSION_ID", "CLAUDE_PID", "FW_CONFIG"):
        env.pop(k, None)
    try:
        for t in (t_config, t_follow, t_hook, t_install, t_agent, t_projects, t_server, t_fw, t_shortcut):
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
