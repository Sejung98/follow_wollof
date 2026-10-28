"""Desktop notifications when a Claude session ends, stops after a long run, waits for input, hits a blocked step
or stalls. Works on the host snapshots the server already receives; nothing new runs on the hosts.

macOS: osascript · Windows: a toast through PowerShell (clicking it opens the session page) · Linux: notify-send.
The first snapshot of each host only sets the baseline, so restarting the server never replays old events.
"""
import datetime
import os
import shutil
import subprocess
import sys
import threading
import time

import config

sys.path.insert(0, os.path.join(config.ROOT, "session"))
import follow  # noqa: E402  (same plan replay rules as the web page)

LIVE = ("busy", "idle", "waiting")
STALE_AFTER = 2 * 3600       # same as STALE_MS in web/graph.js
REPEAT_AFTER = 300           # the same session and kind is not announced twice within this many seconds
BUNDLE = 3                   # more changes than this in one snapshot become one summary notification
# Our own sender (registered per user before each toast) so it can be picked in Windows priority notifications.
WIN_APP_ID = "follow_wollof"
WIN_APP_ICON = os.path.join(config.ROOT, "app", "icon.png")
NO_WINDOW = {"creationflags": 0x08000000} if config.IS_WINDOWS else {}


def _ts(iso):
    try:
        return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except (AttributeError, TypeError, ValueError):
        return 0


def summarize(s):
    """What the notifier compares between two snapshots of one session."""
    plan = s.get("plan") or []
    g = follow.replay(plan) if plan else None
    nodes = list(g["nodes"].values()) if g and g["nodes"] else []
    label = (g and g["title"]) or s.get("title") or s.get("lastPrompt") or s.get("name") or s["sessionId"][:8]
    blocked = {}
    for e in plan:   # the note given with `follow.py block` says why
        if e.get("op") == "state" and e.get("state") == "blocked":
            blocked[e.get("id")] = e.get("note") or ""
    return {"status": s.get("status"), "since": (s.get("statusUpdatedAt") or 0) / 1000.0, "label": label,
            "waitingFor": s.get("waitingFor"),
            "blocked": {n["title"]: blocked.get(n["id"], "") for n in nodes if n["state"] == "blocked"},
            "now": [n["title"] for n in nodes if n["state"] == "now"],
            "lastT": max([_ts(e.get("t")) for e in plan] or [0])}


class Watcher:
    def __init__(self, cfg, send=None):
        n = cfg.get("notify") or {}
        self.enabled = n.get("enabled", True)
        self.events = set(n.get("events") or config.NOTIFY_EVENTS)
        self.min_busy = n.get("min_busy", 60)
        self.port = cfg.get("port", 7777)
        self.send = send or send_async
        self.prev = {}      # host -> {sessionId: summary}
        self.sent = {}      # (host, sessionId, kind) -> time
        self.lock = threading.Lock()

    def update(self, host, sessions, now=None):
        """Compare this host's new snapshot with the last one and announce what changed."""
        now = now or time.time()
        cur = {s["sessionId"]: summarize(s) for s in sessions}
        with self.lock:
            prev, self.prev[host] = self.prev.get(host), cur
        if prev is None:
            return []
        found = []
        for sid, p in prev.items():
            c = cur.get(sid)
            if p["status"] in LIVE and (c is None or c["status"] == "ended"):
                found.append(("ended", sid, p, "세션 종료", "Claude 세션이 닫혔습니다"))
        for sid, c in cur.items():
            p = prev.get(sid)
            if not p:
                continue
            if c["status"] == "waiting" and p["status"] != "waiting":
                why = c["waitingFor"] if isinstance(c["waitingFor"], str) and c["waitingFor"] else "권한 확인이나 답을 기다립니다"
                found.append(("waiting", sid, c, "입력 대기", why))
            elif p["status"] == "busy" and c["status"] == "idle" and p["since"] and (c["since"] or now) - p["since"] >= self.min_busy:
                mins = max(1, int(((c["since"] or now) - p["since"]) // 60))
                found.append(("stopped", sid, c, "작업 멈춤", "%d분 작업한 뒤 다음 지시를 기다립니다" % mins))
            for step in set(c["blocked"]) - set(p["blocked"]):
                note = c["blocked"][step]
                found.append(("blocked", sid, c, "막힘", step + (" · " + note if note else "")))
        found += self._stale(host, cur, now)
        return self._announce(host, found, now)

    def tick(self, now=None):
        """Stalls show up without any new snapshot, so the server calls this every half minute."""
        now = now or time.time()
        with self.lock:
            hosts = list(self.prev.items())
        out = []
        for host, cur in hosts:
            out += self._announce(host, self._stale(host, cur, now), now)
        return out

    def _stale(self, host, cur, now):
        found = []
        for sid, c in cur.items():
            if c["status"] in LIVE and c["now"] and c["lastT"] and now - c["lastT"] > STALE_AFTER \
                    and (host, sid, "stale", c["lastT"]) not in self.sent:
                self.sent[(host, sid, "stale", c["lastT"])] = now   # once per quiet stretch
                found.append(("stale", sid, c, "정체", "'%s' 단계가 %d시간째 기록 없음" % (c["now"][0], (now - c["lastT"]) // 3600)))
        return found

    def _announce(self, host, found, now):
        if not self.enabled:
            return []
        fresh = []
        for kind, sid, c, title, body in found:
            if kind not in self.events or now - self.sent.get((host, sid, kind), 0) < REPEAT_AFTER:
                continue
            self.sent[(host, sid, kind)] = now
            fresh.append({"kind": kind, "title": "%s · %s" % (title, host), "body": "%s\n%s" % (c["label"][:80], body),
                          "url": "http://localhost:%d/?s=%s/%s" % (self.port, host, sid)})
        if len(fresh) > BUNDLE:
            fresh = [{"kind": "many", "title": "세션 %d개 상태 변화 · %s" % (len(fresh), host),
                      "body": "\n".join(f["title"].split(" · ")[0] + ": " + f["body"].split("\n")[0] for f in fresh[:4]),
                      "url": "http://localhost:%d/" % self.port}]
        for f in fresh:
            self.send(f["title"], f["body"], f["url"])
        return fresh


def send_async(title, body, url):
    threading.Thread(target=send, args=(title, body, url), daemon=True).start()


def send(title, body, url):
    """One desktop notification; values are passed as arguments or environment, never pasted into script text."""
    try:
        if sys.platform == "darwin":
            subprocess.run(["osascript", "-e", "on run argv", "-e",
                            'display notification (item 2 of argv) with title "follow_wollof" subtitle (item 1 of argv) sound name "Glass"',
                            "-e", "end run", title, body.replace("\n", " — ")], timeout=20,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
        elif config.IS_WINDOWS:
            script = (
                "$k = 'HKCU:\\Software\\Classes\\AppUserModelId\\' + $env:FW_APP; "
                "New-Item $k -Force > $null; "
                "Set-ItemProperty $k DisplayName 'follow_wollof'; Set-ItemProperty $k IconUri $env:FW_ICON; "
                "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; "
                "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null; "
                "$x = New-Object Windows.Data.Xml.Dom.XmlDocument; "
                "$x.LoadXml('<toast activationType=\"protocol\"><visual><binding template=\"ToastGeneric\"><text/><text/></binding></visual></toast>'); "
                "$x.DocumentElement.SetAttribute('launch', $env:FW_URL); "
                "$t = $x.GetElementsByTagName('text'); "
                "$t.Item(0).AppendChild($x.CreateTextNode($env:FW_TITLE)) > $null; "
                "$t.Item(1).AppendChild($x.CreateTextNode($env:FW_BODY)) > $null; "
                "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:FW_APP).Show("
                "[Windows.UI.Notifications.ToastNotification]::new($x))")
            subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
                           env=dict(os.environ, FW_TITLE=title, FW_BODY=body, FW_URL=url, FW_APP=WIN_APP_ID, FW_ICON=WIN_APP_ICON),
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30,
                           check=True, **NO_WINDOW)
        elif shutil.which("notify-send"):
            subprocess.run(["notify-send", "-a", "follow_wollof", title, body], timeout=20, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        else:
            return False
        return True
    except subprocess.CalledProcessError as e:
        sys.stderr.write("notify: %s\n" % (e.stderr or b"").decode("utf-8", "ignore").strip())
    except Exception as e:
        sys.stderr.write("notify: %r\n" % e)
    return False
