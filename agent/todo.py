#!/usr/bin/env python3
"""follow_wollof todo store: the questions and to-dos page, kept as one JSON file on one host ([todo] in config.ini).

Stdlib only, Python 3.6+. Sent over ssh like agent.py (nothing is installed on the host):
    ssh host 'python3 - <base64 JSON op>' < todo.py
op = {"path": "~/.follow_wollof/todo.json", "do": "get" | "add" | "update" | "delete", ...}
    add     {"items": [{"text", "kind": "question"|"todo", "project", "theme"}], "by": "<computer>"}
    update  {"id": "Q-0001", "set": {"done": true|null, "text", "kind", "project", "theme", "links", "dismissed"}}
    delete  {"id": "Q-0001"}
    batch   {"ops": [update, ...]}: several updates under one lock (the processed-check marks many items at once)
    import  {"source": {"key", "version", "project", "title", "date", "path", "host"}, "items": [{"text", "kind", "theme",
             "ref", "done", "links"}]}: what a meeting note asks for. Skipped when that version of the note is already in;
             an item with a ref (a tracker line) is updated in place, others are added unless the same text is there.
Every change runs under an exclusive lock, so two desktops writing at once cannot lose an item. Finished items
stay in the file with the time they were checked ("done"); nothing is removed except by delete.
Prints the whole store as one JSON line: {"next": n, "items": [...]}.
"""
import base64
import datetime
import json
import os
import re
import sys

try:
    import fcntl
except ImportError:   # a Windows host: one user, no lock
    fcntl = None

EDITABLE = ("text", "kind", "project", "theme", "done", "links", "dismissed", "evidence", "reviewed")


def now():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            db = json.load(fh)
    except (OSError, ValueError):
        db = {}
    db.setdefault("next", 1)
    db.setdefault("items", [])
    return db


def save(path, db):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(db, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def apply(db, op):
    do = op.get("do")
    if do == "add":
        for it in op.get("items") or []:
            text = str(it.get("text") or "").strip()
            if not text:
                continue
            db["items"].append({"id": "Q-%04d" % db["next"], "text": text[:600],
                                "kind": it.get("kind") if it.get("kind") in ("question", "todo") else "todo",
                                "project": it.get("project") or None, "theme": (str(it.get("theme") or "").strip()[:60] or None),
                                "created": now(), "by": op.get("by"), "done": None, "links": [], "dismissed": []})
            db["next"] += 1
    elif do == "update":
        for it in db["items"]:
            if it["id"] == op.get("id"):
                for k, v in (op.get("set") or {}).items():
                    if k in EDITABLE:
                        it[k] = now() if k == "done" and v is True else v
    elif do == "delete":
        db["items"] = [it for it in db["items"] if it["id"] != op.get("id")]
    elif do == "batch":
        for sub in op.get("ops") or []:
            if sub.get("do") == "update":
                apply(db, sub)
    elif do == "import":
        src = op.get("source") or {}
        seen = db.setdefault("sources", {})
        if not src.get("key") or seen.get(src["key"]) == src.get("version"):
            return db
        note = {k: src.get(k) for k in ("key", "title", "date", "path", "host")}
        same = lambda t: re.sub(r"[\s.,·:;!?()\[\]'\"]+", "", t or "").lower()
        for it in op.get("items") or []:
            text = str(it.get("text") or "").strip()[:600]
            if not text:
                continue
            cur = next((x for x in db["items"] if it.get("ref") and x.get("ref") == it.get("ref")
                        and (x.get("source") or {}).get("key") == src["key"]), None)
            if cur:   # a tracker line seen before: follow its status, keep what was set here
                cur["text"] = text
                if it.get("done") and not cur.get("done"):
                    cur["done"] = now()
                cur["links"] = cur.get("links", []) + [l for l in it.get("links") or [] if l not in cur.get("links", [])]
                continue
            if any(same(x["text"]) == same(text) and x.get("project") == src.get("project") for x in db["items"]):
                continue
            db["items"].append({"id": "Q-%04d" % db["next"], "text": text,
                                "kind": it.get("kind") if it.get("kind") in ("question", "todo") else "todo",
                                "project": src.get("project"), "theme": (str(it.get("theme") or "").strip()[:60] or None),
                                "created": now(), "by": op.get("by"), "done": now() if it.get("done") else None,
                                "links": list(it.get("links") or []), "dismissed": [], "source": note, "ref": it.get("ref")})
            db["next"] += 1
        seen[src["key"]] = src.get("version")
    return db


def main():
    op = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8")) if len(sys.argv) > 1 else {"do": "get"}
    path = os.path.expanduser(op.get("path") or "~/.follow_wollof/todo.json")
    if not os.path.isdir(os.path.dirname(path)):
        os.makedirs(os.path.dirname(path), mode=0o700)
    with open(path + ".lock", "a") as lock:
        if fcntl:
            fcntl.flock(lock, fcntl.LOCK_EX)
        db = load(path)
        if op.get("do") in ("add", "update", "delete", "import", "batch"):
            save(path, apply(db, op))
    sys.stdout.buffer.write((json.dumps(db, ensure_ascii=False) + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
