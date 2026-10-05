#!/usr/bin/env python3
"""Claude Code Stop hook: nudge the session once when its follow_wollof graph looks stale.

Blocks the stop (one extra short turn) only when
  - a plan exists, is unfinished, this turn ran >= MIN_TOOLS tool calls without touching follow.py,
    and no nudge was sent in the last COOLDOWN seconds; or
  - no plan exists, this turn ran >= NOPLAN_TOOLS tool calls, and this session was never nudged.
Never blocks twice in a row (stop_hook_active). Any error -> allow the stop silently.
"""
import json
import os
import sys
import time

MIN_TOOLS = 4
NOPLAN_TOOLS = 10
COOLDOWN = 20 * 60
TAIL_BYTES = 512 * 1024
ROOT = os.path.join(os.path.expanduser("~"), ".follow_wollof", "sessions")


def turn_tools(transcript):
    """Tool calls since the last real user prompt, and whether any of them ran follow.py."""
    size = os.path.getsize(transcript)
    with open(transcript, "rb") as fh:
        if size > TAIL_BYTES:
            fh.seek(size - TAIL_BYTES)
            fh.readline()
        lines = fh.read().decode("utf-8", "ignore").splitlines()
    count, touched = 0, False
    for line in lines:
        try:
            d = json.loads(line)
        except ValueError:
            continue
        msg = d.get("message") or {}
        content = msg.get("content")
        if d.get("type") == "user" and not d.get("isMeta"):
            is_prompt = isinstance(content, str) or (
                isinstance(content, list) and any(
                    isinstance(b, dict) and b.get("type") == "text" for b in content))
            if is_prompt:
                count, touched = 0, False
        elif d.get("type") == "assistant" and isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    count += 1
                    if "follow.py" in json.dumps(b.get("input", {})):
                        touched = True
    return count, touched


def plan_state(events_path):
    """(unfinished, current step title) via the same replay the CLI uses."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import follow  # noqa: E402
    events = []
    with open(events_path, encoding="utf-8") as fh:
        for line in fh:
            try:
                events.append(json.loads(line))
            except ValueError:
                pass
    g = follow.replay(events)
    live = [g["nodes"][i] for i in g["order"] if g["nodes"][i]["state"] != "dropped"]
    unfinished = any(n["state"] != "done" for n in live)
    cur = [n["title"] for n in live if n["state"] in ("now", "blocked")]
    return unfinished, ", ".join(cur) or "없음"


def block(reason):
    out = json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False) + "\n"
    sys.stdout.buffer.write(out.encode("utf-8"))  # UTF-8 regardless of the Windows code page
    sys.stdout.flush()


def main():
    data = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    if data.get("stop_hook_active"):
        return
    sid, transcript = data.get("session_id"), data.get("transcript_path")
    if not sid or not transcript or not os.path.exists(transcript):
        return
    sdir = os.path.join(ROOT, sid)
    events = os.path.join(sdir, "events.jsonl")
    flag = os.path.join(sdir, ".nudged")
    tools, touched = turn_tools(transcript)
    if touched:
        return
    if os.path.exists(events):
        if tools < MIN_TOOLS:
            return
        if os.path.exists(flag) and time.time() - os.path.getmtime(flag) < COOLDOWN:
            return
        unfinished, cur = plan_state(events)
        if not unfinished:
            return
        reason = ("[follow_wollof] 진행 그래프의 현재 단계는 '%s' 이다. 이번 턴의 작업으로 단계가 끝났거나 "
                  "바뀌었거나 새 단계가 갈라져 나왔으면 follow.py next/done/derive/drop 으로 갱신하고, "
                  "변화가 없으면 아무 말 없이 종료한다." % cur)
    else:
        if tools < NOPLAN_TOOLS or os.path.exists(flag):
            return
        reason = ("[follow_wollof] 이 작업이 여러 단계로 이루어진 분석이면 follow.py plan 으로 계획을 등록하고 "
                  "현재 단계를 next 로 표시한다. 단순 작업이면 아무 말 없이 종료한다.")
    if not os.path.isdir(sdir):
        os.makedirs(sdir)
    with open(flag, "w") as fh:
        fh.write(str(time.time()))
    block(reason)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
