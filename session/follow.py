#!/usr/bin/env python3
"""follow_wollof: record this Claude Code session's plan graph as append-only events.

Steps are written as  id:제목  or  id:제목<dep1,dep2  (empty after '<' means no dependency).
Without '<' a step depends on the step listed before it, so a linear plan needs no deps.

  follow.py plan "작업 제목" qc:QC deg:DEG gsea:GSEA        register (or extend) the plan
  follow.py next deg                                      finish the current step(s), start deg
  follow.py now|done|side|left ID [메모]                   set one step's state
  follow.py block ID "이유"                                 failed / waiting on the user
  follow.py derive ID "제목" --from X [--into Y,Z] --reason "이유"   new step branched off X, feeding Y
  follow.py add ID "제목" [--after A,B] [--into Y] [--reason "이유"]   new step without an origin
  follow.py drop ID --reason "이유" [--by Y]                 abandon a step (optionally replaced by Y)
  follow.py replan "이유" id:제목 ...                        new plan version; unfinished steps not listed are dropped
  follow.py show                                          print the current graph
Stdlib only, Python 3.6+; Linux, macOS, Windows (Git Bash / PowerShell).
"""
import datetime
import json
import os
import subprocess
import sys

HOME = os.path.expanduser("~")
ROOT = os.path.join(HOME, ".follow_wollof", "sessions")
STATES = ("left", "now", "side", "done", "blocked", "dropped")


def die(msg):
    sys.stderr.write("follow: " + msg + "\n")
    sys.exit(1)


def _ppid(pid):
    try:
        with open("/proc/%d/stat" % pid) as fh:
            return int(fh.read().rsplit(")", 1)[1].split()[1])
    except Exception:
        try:
            return int(subprocess.check_output(["ps", "-o", "ppid=", "-p", str(pid)]).strip())
        except Exception:
            return 0


def session_id():
    sid = os.environ.get("FOLLOW_SESSION_ID") or os.environ.get("CLAUDE_CODE_SESSION_ID")
    if sid:
        return sid
    # older Claude Code: find the ancestor process registered in ~/.claude/sessions/<pid>.json
    pids = [int(os.environ["CLAUDE_PID"])] if os.environ.get("CLAUDE_PID", "").isdigit() else []
    pid = os.getpid()
    for _ in range(12):
        pid = _ppid(pid)
        if pid <= 1:
            break
        pids.append(pid)
    for pid in pids:
        try:
            with open(os.path.join(HOME, ".claude", "sessions", "%d.json" % pid)) as fh:
                return json.load(fh)["sessionId"]
        except Exception:
            continue
    die("Claude Code 세션 밖에서 실행됨 (FOLLOW_SESSION_ID 로 지정 가능)")


def paths():
    d = os.path.join(ROOT, session_id())
    return d, os.path.join(d, "events.jsonl")


def load():
    _, ev = paths()
    out = []
    if os.path.exists(ev):
        with open(ev, encoding="utf-8") as fh:
            for line in fh:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
    return out


def replay(events):
    """Same rules as replayPlan() in web/graph.js."""
    g = {"title": None, "v": 0, "nodes": {}, "order": []}

    def put(nid, title, deps, **extra):
        if nid in g["nodes"]:
            n = g["nodes"][nid]
            if title:
                n["title"] = title
            for d in deps:
                if d not in n["deps"]:
                    n["deps"].append(d)
            if n["state"] == "dropped":
                n["state"] = "left"
            n.update({k: v for k, v in extra.items() if v})
            return
        n = {"id": nid, "title": title or nid, "deps": list(deps), "state": "left",
             "from": None, "by": None, "v": g["v"]}
        n.update(extra)
        g["nodes"][nid] = n
        g["order"].append(nid)

    for e in events:
        op = e.get("op")
        if op in ("plan", "replan"):
            g["v"] += 1
            g["title"] = e.get("title") or g["title"]
            listed = set()
            for s in e.get("nodes", []):
                put(s["id"], s.get("title"), s.get("after", []))
                listed.add(s["id"])
            if op == "replan":
                for n in g["nodes"].values():
                    if n["id"] not in listed and n["state"] not in ("done", "dropped"):
                        n["state"] = "dropped"
        elif op in ("add", "derive"):
            put(e["id"], e.get("title"), e.get("after", []), **{"from": e.get("from")})
            for t in e.get("into", []):
                if t in g["nodes"] and e["id"] not in g["nodes"][t]["deps"]:
                    g["nodes"][t]["deps"].append(e["id"])
        elif op == "state" and e.get("id") in g["nodes"]:
            g["nodes"][e["id"]]["state"] = e["state"]
        elif op == "next":
            for n in g["nodes"].values():
                if n["state"] == "now":
                    n["state"] = "done"
            if e.get("id") in g["nodes"]:
                g["nodes"][e["id"]]["state"] = "now"
        elif op == "drop" and e.get("id") in g["nodes"]:
            g["nodes"][e["id"]]["state"] = "dropped"
            g["nodes"][e["id"]]["by"] = e.get("by")
    return g


def private(path):
    """Plans can name projects and samples; on shared servers keep ~/.follow_wollof owner-only."""
    try:
        if os.name != "nt" and os.stat(path).st_mode & 0o077:
            os.chmod(path, 0o700)
    except OSError:
        pass


def append(event):
    d, ev = paths()
    if not os.path.isdir(d):
        os.makedirs(d, mode=0o700)
    private(os.path.dirname(ROOT))
    event = dict(event, t=datetime.datetime.now().astimezone().isoformat(timespec="seconds"))
    with open(ev, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(event, ensure_ascii=False) + "\n")


def parse_steps(specs, prev=None):
    steps = []
    for spec in specs:
        if ":" not in spec:
            die("단계 형식은 id:제목 또는 id:제목<dep1,dep2 : %r" % spec)
        sid, rest = spec.split(":", 1)
        sid = sid.strip()
        if "<" in rest:
            title, deps = rest.rsplit("<", 1)
            after = [x.strip() for x in deps.split(",") if x.strip()]
        else:
            title, after = rest, ([prev] if prev else [])
        steps.append({"id": sid, "title": title.strip(), "after": after})
        prev = sid
    return steps


def opts(args, names):
    """Split --name value pairs out of args."""
    found, rest, i = {}, [], 0
    while i < len(args):
        if args[i].startswith("--") and args[i][2:] in names and i + 1 < len(args):
            found[args[i][2:]] = args[i + 1]
            i += 2
        else:
            rest.append(args[i])
            i += 1
    return found, rest


def csv(v):
    return [x.strip() for x in (v or "").split(",") if x.strip()]


def need(g, *ids):
    for i in ids:
        if i and i not in g["nodes"]:
            die("없는 단계 id: %s (현재: %s)" % (i, ", ".join(g["order"]) or "없음"))


def show(g):
    if not g["order"]:
        print("(계획 없음)")
        return
    mark = {"done": "✓", "now": "▶", "side": "∥", "blocked": "✗", "left": "·", "dropped": "—"}
    print("%s  (v%d)" % (g["title"] or "", g["v"]))
    for nid in g["order"]:
        n = g["nodes"][nid]
        extra = []
        if n["deps"]:
            extra.append("after " + ",".join(n["deps"]))
        if n["from"]:
            extra.append("from " + n["from"])
        if n["by"]:
            extra.append("→ " + n["by"])
        print(" %s %-12s %s%s" % (mark.get(n["state"], "?"), nid, n["title"],
                                 ("  [" + "; ".join(extra) + "]") if extra else ""))


def main(argv):
    for stream in (sys.stdout, sys.stderr):  # Korean + ✓▶ on any console/code page
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__)
        return
    cmd, args = argv[0], argv[1:]
    g = replay(load())

    if cmd == "plan":
        if len(args) < 2:
            die('plan "작업 제목" id:제목 ...')
        last = g["order"][-1] if g["order"] else None
        steps = parse_steps(args[1:], prev=last if g["order"] else None)
        known = set(g["nodes"]) | {s["id"] for s in steps}
        for s in steps:
            need({"nodes": known, "order": sorted(known)}, *s["after"])
        append({"op": "plan", "title": args[0], "nodes": steps,
                "cwd": os.getcwd()})
    elif cmd == "replan":
        if len(args) < 2:
            die('replan "이유" id:제목 ...')
        steps = parse_steps(args[1:])
        known = set(g["nodes"]) | {s["id"] for s in steps}
        for s in steps:
            need({"nodes": known, "order": sorted(known)}, *s["after"])
        append({"op": "replan", "reason": args[0], "nodes": steps})
    elif cmd == "next":
        if len(args) < 1:
            die("next ID")
        need(g, args[0])
        append({"op": "next", "id": args[0], "note": " ".join(args[1:]) or None})
    elif cmd in ("now", "done", "side", "left", "block", "blocked"):
        if not args:
            die("%s ID" % cmd)
        need(g, args[0])
        state = "blocked" if cmd.startswith("block") else cmd
        append({"op": "state", "id": args[0], "state": state, "note": " ".join(args[1:]) or None})
    elif cmd in ("derive", "add"):
        o, rest = opts(args, ("from", "into", "after", "reason"))
        if len(rest) < 2:
            die('%s ID "제목" ...' % cmd)
        if cmd == "derive" and not o.get("from"):
            die("derive 에는 --from 이 필요함")
        if rest[0] in g["nodes"] and g["nodes"][rest[0]]["state"] != "dropped":
            die("이미 있는 id: " + rest[0])
        after = csv(o.get("after"))
        need(g, o.get("from"), *(after + csv(o.get("into"))))
        append({"op": cmd, "id": rest[0], "title": rest[1], "from": o.get("from"),
                "after": after, "into": csv(o.get("into")), "reason": o.get("reason")})
    elif cmd == "drop":
        o, rest = opts(args, ("reason", "by"))
        if not rest:
            die('drop ID --reason "이유" [--by Y]')
        need(g, rest[0], o.get("by"))
        append({"op": "drop", "id": rest[0], "reason": o.get("reason"), "by": o.get("by")})
    elif cmd == "show":
        show(g)
        return
    else:
        die("알 수 없는 명령: %s (help 참고)" % cmd)
    show(replay(load()))


if __name__ == "__main__":
    main(sys.argv[1:])
