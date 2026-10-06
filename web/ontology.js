// Ontology view: hosts, sessions and topics as one force-laid graph, with an explorer on the left and an
// inspector on the right. Sessions that share a topic slug (`follow.py topic`) are linked through it; sessions
// whose plan titles overlap get a dashed "similar" link. Node colour = host.
import { GraphView, dur } from "./graph.js";
import { outputsHtml } from "./viewer.js";

export const HOST_COLORS = ["#3FA6DA", "#D1980B", "#BD6BBD", "#00A396", "#7961DB", "#DB2C6F", "#29A634", "#946638"];
const STATE_KO = { busy: "작업 중", waiting: "입력 대기", idle: "유휴", ended: "종료됨" };
const STEP_KO = { done: "완료", now: "진행 중", side: "병행 중", blocked: "막힘", left: "대기", dropped: "제외" };
const STOP = new Set(["분석", "정리", "작업", "확인", "검토", "the", "and", "for", "analysis", "of"]);
const NS = "http://www.w3.org/2000/svg";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const el = (tag, attrs, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};
const tokens = s => new Set(String(s || "").toLowerCase().split(/[\s,·:/()\[\]_|]+/).filter(w => w.length >= 2 && !STOP.has(w)));

// Project = the first numbered folder in the session's cwd ("…/R_env/01_ncc/figs" → ncc), else the cwd's last folder.
export function projectOf(cwd) {
  const parts = String(cwd || "").split(/[\\/]+/).filter(Boolean);
  const i = parts.findIndex(p => /^\d+[_-]./.test(p));
  const upto = i >= 0 ? parts.slice(0, i + 1) : parts;
  const folder = upto[upto.length - 1] || "";
  const path = (String(cwd || "").startsWith("/") ? "/" : "") + upto.join("/");
  return { name: (i >= 0 ? folder.replace(/^\d+[_-]/, "") : folder) || "경로 없음", folder, path,
           key: /^[a-z]:$/i.test(parts[0] || "") ? path.toLowerCase() : path };   // Windows paths differ only in case
}

// one tile of stars, drawn once; tiles repeat behind the graph at three depths
function starTile(size, count, rmax, seed) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const x = c.getContext("2d");
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < count; i++) {
    const px = rnd() * size, py = rnd() * size, r = 0.35 + Math.pow(rnd(), 4) * rmax, a = 0.35 + rnd() * 0.65, tint = rnd();
    const rgb = tint < 0.12 ? "255,214,170" : tint < 0.32 ? "176,204,255" : "255,255,255";
    if (r > 1.2) {   // bright stars get a soft halo
      const g = x.createRadialGradient(px, py, 0, px, py, r * 5);
      g.addColorStop(0, `rgba(${rgb},${a * 0.35})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      x.fillStyle = g;
      x.fillRect(px - r * 5, py - r * 5, r * 10, r * 10);
    }
    x.fillStyle = `rgba(${rgb},${a})`;
    x.beginPath();
    x.arc(px, py, r, 0, 7);
    x.fill();
  }
  return c.toDataURL();
}

function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "방금";
  if (s < 3600) return Math.floor(s / 60) + "분 전";
  if (s < 86400) return Math.floor(s / 3600) + "시간 전";
  return Math.floor(s / 86400) + "일 전";
}

export class Ontology {
  constructor(root, { onOpen, lastActive }) {
    this.root = root;
    this.onOpen = onOpen;
    this.lastActive = lastActive;
    this.nodes = new Map();          // id -> sim node {id, type, x, y, vx, vy, data, el}
    this.links = [];
    this.linkEls = new Map();
    this.sel = null;
    this.hover = null;
    this.query = "";
    this.layers = { hosts: true, projects: true, ended: false, similar: true };   // closed sessions: opt-in
    try { Object.assign(this.layers, JSON.parse(localStorage.getItem("fw-onto-layers") || "{}")); } catch (e) {}
    this.view = { x: 0, y: 0, k: 1 };
    this.alpha = 0;
    this.fitted = false;
    root.innerHTML = `
      <div class="space" aria-hidden="true"><i class="st s1"></i><i class="st s2"></i><i class="st s3"></i><i class="meteor"></i></div>
      <nav class="ox">
        <label class="search"><svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>
          <input type="search" placeholder="세션·주제·호스트 찾기" aria-label="그래프에서 찾기"></label>
        <div class="ox-sec"><h3>객체</h3><div class="ox-types"></div></div>
        <div class="ox-sec"><h3>호스트</h3><div class="ox-hosts"></div></div>
        <div class="ox-sec"><h3>주제</h3><div class="ox-topics"></div></div>
        <div class="ox-sec"><h3>표시</h3>
          <label class="tg"><input type="checkbox" data-layer="hosts"><span></span>호스트 노드</label>
          <label class="tg"><input type="checkbox" data-layer="projects"><span></span>프로젝트 노드</label>
          <label class="tg"><input type="checkbox" data-layer="ended"><span></span>닫은 세션도 보기 (최근 7일)</label>
          <label class="tg"><input type="checkbox" data-layer="similar"><span></span>제목이 비슷한 세션 연결</label>
        </div>
      </nav>
      <div class="canvas">
        <svg class="onto" tabindex="0" aria-label="세션 온톨로지 그래프"><defs>
          <radialGradient id="sheen" cx="34%" cy="28%" r="70%"><stop offset="0" stop-color="#fff" stop-opacity=".55"/>
            <stop offset=".45" stop-color="#fff" stop-opacity=".08"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
          <rect class="bg" width="100%" height="100%" fill="transparent"/><g class="vp"><g class="lk"></g><g class="nd"></g></g></svg>
        <div class="legend">
          <span><i class="lg-host"></i>호스트</span><span><i class="lg-proj"></i>프로젝트</span><span><i class="lg-sess"></i>세션 · 테두리 = 진행률</span>
          <span><i class="lg-topic"></i>주제</span><span><i class="lg-sim"></i>비슷한 제목</span>
        </div>
        <div class="zoom"><button data-z="in" title="확대">+</button><button data-z="out" title="축소">−</button><button data-z="fit" title="전체 보기">
          <svg viewBox="0 0 16 16"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg></button></div>
        <div class="empty-onto" hidden>계획을 등록한 세션이 아직 없습니다.<br>세션끼리 연결하려면 각 세션에서 <code>follow.py topic 주제 "이 세션의 방향"</code></div>
      </div>
      <div class="insp" hidden></div>`;
    this.svg = root.querySelector("svg.onto");
    this.vp = root.querySelector(".vp");
    this.gL = root.querySelector(".lk");
    this.gN = root.querySelector(".nd");
    this.insp = root.querySelector(".insp");
    this.bind();
    [[".s1", 512, 260, 0.9, 7], [".s2", 768, 120, 1.8, 13], [".s3", 1024, 34, 2.6, 29]].forEach(([sel, size, n, r, seed]) => {
      const e = root.querySelector(sel);
      e.style.backgroundImage = `url(${starTile(size, n, r, seed)})`;
      e.style.backgroundSize = `${size}px ${size}px`;
    });
    new ResizeObserver(() => { if (!this.touched) this.fit(); }).observe(this.svg);   // inspector opening narrows the canvas
  }

  // ── data → graph ─────────────────────────────────────────────────────
  update(sessions, hosts) {
    this.hosts = hosts;
    this.colors = new Map(hosts.map((h, i) => [h.name, HOST_COLORS[i % HOST_COLORS.length]]));
    const L = this.layers;
    const sess = sessions.filter(s => (s.g || s.status === "busy" || s.status === "waiting") && (L.ended || s.status !== "ended"));
    const want = new Map(), links = [];
    if (L.hosts) for (const h of hosts) if (sess.some(s => s.host === h.name)) want.set("h:" + h.name, { type: "host", data: h });
    const topics = new Map(), projects = new Map();
    for (const s of sess) {
      want.set("s:" + s.key, { type: "session", data: s });
      s.project = projectOf(s.cwd);
      s.projectId = "p:" + s.host + "/" + s.project.key;
      if (!projects.has(s.projectId)) projects.set(s.projectId, { ...s.project, id: s.projectId, host: s.host, sessions: [] });
      projects.get(s.projectId).sessions.push(s);
      if (L.projects) links.push({ a: s.projectId, b: "s:" + s.key, kind: "runs" });
      else if (L.hosts) links.push({ a: "h:" + s.host, b: "s:" + s.key, kind: "runs" });
      for (const t of s.g?.topics || []) {
        if (!topics.has(t)) topics.set(t, []);
        topics.get(t).push(s);
        links.push({ a: "s:" + s.key, b: "t:" + t, kind: "topic", label: s.g.angle });
      }
    }
    for (const [t, list] of topics) want.set("t:" + t, { type: "topic", data: { name: t, sessions: list } });
    this.projects = projects;
    if (L.projects) for (const [id, p] of projects) {
      want.set(id, { type: "project", data: p });
      if (L.hosts) links.push({ a: "h:" + p.host, b: id, kind: "owns" });
    }
    if (L.similar) {
      const tok = sess.filter(s => s.g).map(s => [s, tokens(s.g.title || s.label)]);
      for (let i = 0; i < tok.length; i++) for (let j = i + 1; j < tok.length; j++) {
        const [a, ta] = tok[i], [b, tb] = tok[j];
        if ((a.g.topics || []).some(t => (b.g.topics || []).includes(t))) continue;   // already linked by topic
        const shared = [...ta].filter(w => tb.has(w));
        const jac = shared.length / (ta.size + tb.size - shared.length || 1);
        if (shared.some(w => w.length >= 3) && jac >= 0.25) links.push({ a: "s:" + a.key, b: "s:" + b.key, kind: "similar", label: shared.join(", ") });
      }
    }

    let changed = false;
    for (const [id, v] of this.nodes) if (!want.has(id)) { v.el.remove(); this.nodes.delete(id); changed = true; }
    for (const [id, w] of want) {
      let n = this.nodes.get(id);
      if (!n) {
        const near = links.filter(l => l.a === id || l.b === id).map(l => this.nodes.get(l.a === id ? l.b : l.a)).find(Boolean);
        const r = () => (Math.random() - 0.5) * (near ? 80 : 400);
        n = { id, type: w.type, x: (near?.x || 0) + r(), y: (near?.y || 0) + r(), vx: 0, vy: 0 };
        n.el = this.makeNode(n);
        this.nodes.set(id, n);
        changed = true;
      }
      n.data = w.data;
      this.paintNode(n);
    }
    const lkey = l => `${l.a}|${l.b}|${l.kind}`;
    const lseen = new Set();
    this.links = links.filter(l => this.nodes.has(l.a) && this.nodes.has(l.b));
    for (const l of this.links) {
      const k = lkey(l);
      lseen.add(k);
      let e = this.linkEls.get(k);
      if (!e) {
        e = { g: el("g", { class: "lnk " + l.kind }, this.gL) };
        e.line = el("line", {}, e.g);
        e.text = el("text", { class: "el" }, e.g);
        this.linkEls.set(k, e);
        changed = true;
      }
      e.text.textContent = l.label ? cut(l.label, 22) : "";
      const tgt = this.nodes.get(l.b);
      e.g.classList.toggle("live", l.kind !== "similar" && (tgt.type === "session" && tgt.data.status === "busy"
        || tgt.type === "project" && tgt.data.sessions.some(x => x.status === "busy")));
      l.e = e;
    }
    for (const [k, e] of this.linkEls) if (!lseen.has(k)) { e.g.remove(); this.linkEls.delete(k); changed = true; }

    if (this.sel && !this.nodes.has(this.sel)) this.sel = null;
    if (changed) this.heat(this.fitted ? 0.5 : 1);
    this.root.querySelector(".empty-onto").hidden = this.nodes.size > 0;
    this.renderExplorer(sess, topics);
    this.renderInspector();
    this.highlight();
    this.draw();
  }

  makeNode(n) {
    const g = el("g", { class: "on " + n.type }, this.gN);
    g.dataset.id = n.id;
    el("circle", { class: "hit", r: 30 }, g);
    el("circle", { class: "sel-ring", r: n.type === "project" ? 22 : n.type === "host" ? 27 : 26 }, g);
    if (n.type === "session") {
      el("circle", { class: "pulse", r: 15 }, g);
      el("circle", { class: "trail", r: 24, pathLength: 100 }, g);
      el("circle", { class: "comet", r: 24, pathLength: 100 }, g);
      el("circle", { class: "track", r: 19 }, g);
      el("circle", { class: "prog", r: 19, pathLength: 100, transform: "rotate(-90)" }, g);
      el("circle", { class: "core", r: 14 }, g);
      el("circle", { class: "sheen", r: 14, fill: "url(#sheen)" }, g);
      el("path", { class: "glyph", d: "M-5 0.5 L-1.5 4 L5 -3.5" }, g);
      el("circle", { class: "badge", cx: 13, cy: -13, r: 4.5 }, g);
    } else if (n.type === "topic") {
      el("rect", { class: "core", x: -11, y: -11, width: 22, height: 22, rx: 2, transform: "rotate(45)" }, g);
      el("text", { class: "hash", y: 1 }, g).textContent = "#";
    } else if (n.type === "project") {
      el("rect", { class: "core", x: -14, y: -11, width: 28, height: 22, rx: 3 }, g);
      el("path", { class: "glyph", d: "M-7 -4H-2L0 -2H7V5H-7Z" }, g);
      el("circle", { class: "live-dot", cx: 14, cy: -11, r: 3.5 }, g);
    } else {
      el("rect", { class: "core", x: -17, y: -17, width: 34, height: 34, rx: 4 }, g);
      el("path", { class: "glyph", d: "M-8 -6H8M-8 0H8M-8 6H8" }, g);
      el("circle", { class: "badge", cx: 15, cy: -15, r: 4.5 }, g);
    }
    const ly = { host: 33, project: 27 }[n.type] || 36;
    const lg = el("g", { class: "lbl", transform: `scale(${this.ks || 1})` }, g);   // counter-scaled when zoomed out
    el("text", { class: "nl", y: ly }, lg);
    el("text", { class: "ns", y: ly + 13 }, lg);
    return g;
  }

  paintNode(n) {
    const g = n.el, d = n.data;
    const set = (sel, text) => { const t = g.querySelector(sel); if (t.textContent !== text) t.textContent = text; };
    if (n.type === "session") {
      const color = this.colors.get(d.host) || HOST_COLORS[0];
      const p = d.g && d.g.total ? d.g.done / d.g.total : 0;
      const blocked = d.g?.current.some(c => c.state === "blocked");
      g.style.setProperty("--hc", color);
      const active = d.status === "busy" || d.status === "waiting" || blocked;
      g.setAttribute("class", ["on session", d.status, active ? "active" : "", blocked ? "blocked" : "", d.g?.stale ? "stale" : "", p === 1 ? "finished" : "", d.g ? "" : "noplan"].join(" ").trim());
      g.querySelector(".prog").setAttribute("stroke-dashoffset", 100 - 100 * p);
      set(".nl", cut(d.label, 18));
      const cur = d.g?.current[0];
      const running = cur && (d.status === "busy" || d.status === "waiting" || cur.state === "blocked");
      g.querySelector(".ns").classList.toggle("cur", !!running);
      g.querySelector(".ns").classList.toggle("bad", !!running && cur.state === "blocked");
      g.querySelector(".ns").classList.toggle("slow", !!d.g?.stale);
      set(".ns", d.g?.stale ? `정체 ${dur(d.g.stale)} · ${cut(cur.title, 10)}` : running ? `${cut(cur.title, 14)} · ${d.g.done}/${d.g.total}` : d.g ? `${d.g.done}/${d.g.total} · ${d.host}` : d.host);
    } else if (n.type === "project") {
      const done = d.sessions.reduce((a, s) => a + (s.g?.done || 0), 0), total = d.sessions.reduce((a, s) => a + (s.g?.total || 0), 0);
      g.style.setProperty("--hc", this.colors.get(d.host));
      g.setAttribute("class", "on project" + (d.sessions.some(s => s.status === "busy" || s.status === "waiting") ? " active" : ""));
      set(".nl", cut(d.name, 20));
      set(".ns", `세션 ${d.sessions.length}${total ? ` · ${done}/${total}` : ""}`);
    } else if (n.type === "topic") {
      g.setAttribute("class", "on topic");
      set(".nl", "#" + cut(d.name, 20));
      set(".ns", `세션 ${d.sessions.length}`);
    } else {
      g.style.setProperty("--hc", this.colors.get(d.name));
      g.setAttribute("class", "on host" + (d.connected ? "" : " off"));
      set(".nl", d.name);
      set(".ns", d.connected ? (d.hostname || "연결됨") : "연결 끊김");
    }
    g.classList.toggle("sel", this.sel === n.id);
  }

  // ── simulation ───────────────────────────────────────────────────────
  heat(a) {
    this.alpha = Math.max(this.alpha, a);
    if (!this.raf) this.raf = requestAnimationFrame(() => this.tick());
  }

  tick() {
    this.raf = null;
    const ns = [...this.nodes.values()], a = this.alpha;
    const charge = { host: 700, project: 480, session: 320, topic: 420 };   // repulsion strength, d3-manyBody style
    // ponytail: O(n²) repulsion, fine for the tens of sessions a person runs; Barnes–Hut if it ever reaches hundreds
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
      const p = ns[i], q = ns[j];
      let dx = q.x - p.x, dy = q.y - p.y, d2 = dx * dx + dy * dy;
      if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
      const d = Math.sqrt(d2);
      const f = Math.sqrt(charge[p.type] * charge[q.type]) * a / d2;
      p.vx -= dx * f; p.vy -= dy * f;
      q.vx += dx * f; q.vy += dy * f;
      if (d < 78) { const o = (78 - d) / d * 0.25; p.x -= dx * o; p.y -= dy * o; q.x += dx * o; q.y += dy * o; }
    }
    const len = { owns: 95, runs: 85, topic: 95, similar: 150 }, str = { owns: 0.5, runs: 0.4, topic: 0.6, similar: 0.15 };
    for (const l of this.links) {
      const p = this.nodes.get(l.a), q = this.nodes.get(l.b);
      const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1;
      const k = (d - len[l.kind]) / d * a * str[l.kind] * 0.5;
      q.vx -= dx * k; q.vy -= dy * k; p.vx += dx * k; p.vy += dy * k;
    }
    for (const n of ns) {
      n.vx -= n.x * 0.03 * a; n.vy -= n.y * 0.03 * a;
      if (n === this.dragged) { n.vx = n.vy = 0; continue; }
      n.vx *= 0.6; n.vy *= 0.6;
      n.x += n.vx; n.y += n.vy;
    }
    this.alpha *= 0.975;
    this.draw();
    if (!this.touched && this.alpha < 0.12) this.fitted = this.fit();   // keep the whole graph in view until the user pans or zooms
    if (this.alpha > 0.004 || this.dragged) this.raf = requestAnimationFrame(() => this.tick());
    else this.alpha = 0;
  }

  draw() {
    for (const n of this.nodes.values()) n.el.setAttribute("transform", `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
    for (const l of this.links) {
      const p = this.nodes.get(l.a), q = this.nodes.get(l.b);
      const ln = l.e.line;
      ln.setAttribute("x1", p.x); ln.setAttribute("y1", p.y); ln.setAttribute("x2", q.x); ln.setAttribute("y2", q.y);
      // label nearer the session end, so a topic with many sessions doesn't stack them on its own name
      l.e.text.setAttribute("x", p.x + (q.x - p.x) * 0.42); l.e.text.setAttribute("y", p.y + (q.y - p.y) * 0.42 - 5);
    }
    this.vp.setAttribute("transform", `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`);
    this.root.style.setProperty("--px", this.view.x.toFixed(1));   // star layers drift a little when the graph pans
    this.root.style.setProperty("--py", this.view.y.toFixed(1));
    const ks = Math.round(Math.min(1.3, Math.max(1, 1 / this.view.k)) * 20) / 20;   // labels stay readable when zoomed out
    if (ks !== this.ks) {
      this.ks = ks;
      for (const n of this.nodes.values()) n.el.querySelector(".lbl").setAttribute("transform", `scale(${ks})`);
    }
  }

  fit() {
    const ns = [...this.nodes.values()];
    if (!ns.length) return false;
    const r = this.svg.getBoundingClientRect();
    if (!r.width) return false;   // view hidden; setView fits once it shows
    const xs = ns.map(n => n.x), ys = ns.map(n => n.y), pad = 90;
    const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
    const k = Math.min(1.4, r.width / (x1 - x0), r.height / (y1 - y0));
    this.view = { k, x: r.width / 2 - k * (x0 + x1) / 2, y: r.height / 2 - k * (y0 + y1) / 2 };
    this.draw();
    return true;
  }

  zoomAt(f, cx, cy) {
    const v = this.view, k = Math.min(3, Math.max(0.25, v.k * f));
    v.x = cx - (cx - v.x) * k / v.k; v.y = cy - (cy - v.y) * k / v.k; v.k = k;
    this.draw();
  }

  // ── interaction ──────────────────────────────────────────────────────
  bind() {
    const svg = this.svg;
    let down = null;
    const pt = e => { const r = svg.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    svg.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      const g = e.target.closest(".on");
      down = { x: e.clientX, y: e.clientY, moved: false, node: g ? this.nodes.get(g.dataset.id) : null, vx: this.view.x, vy: this.view.y };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener("pointermove", e => {
      if (!down) {
        const g = e.target.closest(".on");
        const id = g ? g.dataset.id : null;
        if (id !== this.hover) { this.hover = id; this.highlight(); }
        return;
      }
      if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) return;
      down.moved = true;
      svg.classList.add("grabbing");
      if (down.node) {
        const [x, y] = pt(e);
        Object.assign(down.node, { x: (x - this.view.x) / this.view.k, y: (y - this.view.y) / this.view.k });
        this.dragged = down.node;
        this.touched = true;
        this.heat(0.25);
      } else {
        this.view.x = down.vx + e.clientX - down.x; this.view.y = down.vy + e.clientY - down.y;
        this.touched = true;
        this.draw();
      }
    });
    const up = () => {
      if (!down) return;
      if (!down.moved) this.select(down.node ? down.node.id : null);
      down = null;
      this.dragged = null;
      svg.classList.remove("grabbing");
    };
    svg.addEventListener("pointerup", up);
    svg.addEventListener("pointercancel", up);
    svg.addEventListener("pointerleave", () => { if (this.hover) { this.hover = null; this.highlight(); } });
    svg.addEventListener("dblclick", e => {
      const g = e.target.closest(".on.session");
      if (g) this.onOpen(this.nodes.get(g.dataset.id).data.key);
    });
    svg.addEventListener("wheel", e => {
      e.preventDefault();
      this.touched = true;
      const [x, y] = pt(e);
      this.zoomAt(Math.exp(-e.deltaY * 0.0015), x, y);
    }, { passive: false });
    svg.addEventListener("keydown", e => { if (e.key === "Escape") this.select(null); });
    this.root.querySelector(".zoom").addEventListener("click", e => {
      const z = e.target.closest("button")?.dataset.z;
      const r = svg.getBoundingClientRect();
      if (z) this.touched = z !== "fit";
      if (z === "fit") this.fit();
      else if (z) this.zoomAt(z === "in" ? 1.25 : 0.8, r.width / 2, r.height / 2);
    });
    this.root.querySelector(".search input").addEventListener("input", e => { this.query = e.target.value.trim().toLowerCase(); this.highlight(); });
    this.root.querySelectorAll("[data-layer]").forEach(cb => {
      cb.checked = this.layers[cb.dataset.layer];
      cb.addEventListener("change", () => {
        this.layers[cb.dataset.layer] = cb.checked;
        try { localStorage.setItem("fw-onto-layers", JSON.stringify(this.layers)); } catch (e) {}
        this.onLayers?.();
      });
    });
    // explorer + inspector rows select objects; the open button leaves for the session page
    this.root.addEventListener("click", e => {
      const open = e.target.closest("[data-open]");
      if (open) return this.onOpen(open.dataset.open);
      const pick = e.target.closest("[data-pick]");
      if (pick) { this.select(pick.dataset.pick); this.center(pick.dataset.pick); }
    });
  }

  select(id) {
    this.sel = id;
    for (const n of this.nodes.values()) n.el.classList.toggle("sel", n.id === id);
    this.renderInspector();
    this.highlight();
  }

  center(id) {
    const n = this.nodes.get(id);
    if (!n) return;
    const r = this.svg.getBoundingClientRect(), v = this.view;
    const tx = r.width / 2 - n.x * v.k, ty = r.height / 2 - n.y * v.k, x0 = v.x, y0 = v.y, t0 = performance.now();
    const step = t => {
      const p = Math.min(1, (t - t0) / 420), e = 1 - Math.pow(1 - p, 3);
      v.x = x0 + (tx - x0) * e; v.y = y0 + (ty - y0) * e;
      this.draw();
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // focus = hovered or selected node plus its neighbours; search matches light up on their own
  highlight() {
    const focus = this.hover || this.sel;
    const near = new Set(focus ? [focus] : []);
    if (focus) for (const l of this.links) { if (l.a === focus) near.add(l.b); if (l.b === focus) near.add(l.a); }
    const q = this.query, mark = this.mark;
    const match = n => {
      if (mark) return mark(n);
      if (!q) return false;
      const d = n.data;
      return [d.label, d.name, d.folder, d.host, d.project?.name, d.g?.title, ...(d.g?.topics || [])].some(x => x && String(x).toLowerCase().includes(q));
    };
    const dim = !!focus || !!q || !!mark;
    this.svg.classList.toggle("dim", dim);
    for (const n of this.nodes.values()) n.el.classList.toggle("hl", near.has(n.id) || match(n));
    for (const l of this.links) l.e.g.classList.toggle("hl", !!focus && (l.a === focus || l.b === focus));
  }

  // ── side panels ──────────────────────────────────────────────────────
  renderExplorer(sess, topics) {
    const count = t => [...this.nodes.values()].filter(n => n.type === t).length;
    const html = (sel, h) => { const e = this.root.querySelector(sel); if (e.dataset.h !== h) { e.innerHTML = h; e.dataset.h = h; } };
    html(".ox-types", [["host", "호스트", this.hosts.filter(h => sess.some(s => s.host === h.name)).length],
      ["proj", "프로젝트", this.projects.size], ["sess", "세션", count("session")], ["topic", "주제", count("topic")]]
      .map(([t, k, v]) => `<div class="ty"><i class="lg-${t}"></i>${k}<b class="num">${v}</b></div>`).join(""));
    html(".ox-hosts", this.hosts.map(h => {
      const n = sess.filter(s => s.host === h.name).length;
      return `<button class="row" data-pick="h:${esc(h.name)}"><i class="sw" style="--hc:${this.colors.get(h.name)}"></i>
        <span class="t">${esc(h.name)}</span><span class="dot ${h.connected ? "on" : h.lastSeen ? "off" : ""}"></span><b class="num">${n}</b></button>` +
        [...this.projects.values()].filter(p => p.host === h.name).sort((a, b) => b.sessions.length - a.sessions.length).map(p =>
          `<button class="row sub" data-pick="${this.layers.projects ? esc(p.id) : ""}" title="${esc(p.path)}"><i class="fd" style="--hc:${this.colors.get(h.name)}"></i>
            <span class="t">${esc(p.name)}</span><b class="num">${p.sessions.length}</b></button>`).join("");
    }).join(""));
    html(".ox-topics", topics.size ? [...topics].sort((a, b) => b[1].length - a[1].length).map(([t, list]) =>
      `<button class="row" data-pick="t:${esc(t)}"><i class="dia"></i><span class="t">#${esc(t)}</span>
        <span class="hs">${[...new Set(list.map(s => s.host))].map(h => `<i class="sw" style="--hc:${this.colors.get(h)}"></i>`).join("")}</span><b class="num">${list.length}</b></button>`).join("")
      : `<p class="hint">세션에서 <code>follow.py topic 주제</code> 를 쓰면 같은 주제의 세션끼리 연결됩니다.</p>`);
  }

  segbar(g) {
    const live = g.order.map(id => g.nodes[id]).filter(n => n.state !== "dropped");
    return `<div class="segbar">${live.map(n => `<i class="${n.state}" title="${esc(n.title)} · ${STEP_KO[n.state]}"></i>`).join("")}</div>`;
  }

  sessRow(s) {
    const g = s.g;
    return `<button class="srow" data-pick="s:${esc(s.key)}"><i class="sw" style="--hc:${this.colors.get(s.host)}"></i>
      <span class="sb"><span class="t">${esc(s.label)}</span>${g?.angle ? `<span class="an">${esc(g.angle)}</span>` : ""}
      ${g ? this.segbar(g) : ""}</span><span class="st ${s.status}">${STATE_KO[s.status] || ""}</span></button>`;
  }

  renderInspector() {
    const n = this.sel && this.nodes.get(this.sel);
    this.insp.hidden = !n;
    this.root.classList.toggle("has-insp", !!n);
    if (!n) { this.inspKey = null; this.mini = null; return; }
    const d = n.data;
    let html;
    if (n.type === "session") {
      const g = d.g, color = this.colors.get(d.host);
      const peers = new Map();
      for (const t of g?.topics || []) for (const s of this.nodes.get("t:" + t)?.data.sessions || []) if (s.key !== d.key) peers.set(s.key, s);
      for (const l of this.links) if (l.kind === "similar" && (l.a === n.id || l.b === n.id)) {
        const o = this.nodes.get(l.a === n.id ? l.b : l.a);
        if (o && !peers.has(o.data.key)) peers.set(o.data.key, o.data);
      }
      const props = [
        ["호스트", `<i class="sw" style="--hc:${color}"></i>${esc(d.host)}`],
        ["프로젝트", this.nodes.has(d.projectId) ? `<button class="tag" data-pick="${esc(d.projectId)}">${esc(d.project.name)}</button>` : esc(d.project.name)],
        ["상태", `<span class="st ${d.status}">${STATE_KO[d.status] || esc(d.status)}</span>`],
        g?.topics.length && ["주제", g.topics.map(t => `<button class="tag" data-pick="t:${esc(t)}">#${esc(t)}</button>`).join("")],
        g?.angle && ["방향", esc(g.angle)],
        ["최근 활동", ago(this.lastActive(d))],
        d.cwd && ["경로", `<code title="${esc(d.cwd)}">${esc(d.cwd)}</code>`],
        ["세션 ID", `<code>${esc(d.sessionId.slice(0, 8))}</code>`],
        g && ["계획 버전", "v" + g.v],
      ].filter(Boolean);
      html = `<div class="ih"><span class="ik" style="--hc:${color}">세션</span><button class="x" data-pick="" title="닫기">×</button></div>
        <h2>${esc(d.label)}</h2>
        ${g ? `<div class="prog-row"><span class="num">${g.done}/${g.total} 단계</span><span class="num">${g.total ? Math.round(100 * g.done / g.total) : 0}%</span></div>${this.segbar(g)}
          <div class="cur">${g.stale ? `<span class="chip stale"><i></i>정체 · ${dur(g.stale)}째 기록 없음</span>` : ""}${g.current.length ? g.current.map(c => `<span class="chip ${c.state}"><i></i>${esc(c.title)}</span>`).join("")
            : g.done === g.total ? `<span class="chip finished"><i></i>모든 단계 완료</span>` : `<span class="chip idle">진행 중인 단계 없음</span>`}</div>` : `<p class="hint">아직 계획이 등록되지 않은 세션입니다.</p>`}
        <dl class="props">${props.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
        ${g ? `<h3>계획</h3><div class="mini"></div>` : ""}
        ${g?.outs.length ? `<h3>산출물 <b class="num">${g.outs.length}</b></h3><div class="outs compact">${outputsHtml(d)}</div>` : ""}
        ${g?.log.length ? `<h3>변경 기록</h3><ol class="ilog">${g.log.slice(-6).reverse().map(l =>
          `<li class="${l.kind}"><time class="num">${esc((l.t || "").slice(5, 16).replace("T", " "))}</time><span>${esc(l.text)}</span></li>`).join("")}</ol>` : ""}
        ${peers.size ? `<h3>연결된 세션 <b class="num">${peers.size}</b></h3><div class="list">${[...peers.values()].map(s => this.sessRow(s)).join("")}</div>` : ""}
        <button class="primary" data-open="${esc(d.key)}">진행 페이지 열기</button>`;
    } else if (n.type === "project") {
      const list = d.sessions;
      const done = list.reduce((a, s) => a + (s.g?.done || 0), 0), total = list.reduce((a, s) => a + (s.g?.total || 0), 0);
      const topics = [...new Set(list.flatMap(s => s.g?.topics || []))];
      html = `<div class="ih"><span class="ik" style="--hc:${this.colors.get(d.host)}">프로젝트</span><button class="x" data-pick="" title="닫기">×</button></div>
        <h2>${esc(d.name)}</h2>
        <dl class="props"><dt>호스트</dt><dd><button class="tag" data-pick="h:${esc(d.host)}">${esc(d.host)}</button></dd>
          <dt>폴더</dt><dd><code title="${esc(d.path)}">${esc(d.path || "-")}</code></dd>
          <dt>세션</dt><dd class="num">${list.length} (작업 중 ${list.filter(s => s.status === "busy" || s.status === "waiting").length})</dd>
          ${total ? `<dt>전체 진행</dt><dd class="num">${done}/${total} 단계</dd>` : ""}
          ${topics.length ? `<dt>주제</dt><dd>${topics.map(t => `<button class="tag" data-pick="t:${esc(t)}">#${esc(t)}</button>`).join("")}</dd>` : ""}</dl>
        <h3>세션</h3><div class="list">${list.map(s => this.sessRow(s)).join("")}</div>`;
    } else if (n.type === "topic") {
      const list = d.sessions, hosts = [...new Set(list.map(s => s.host))];
      const done = list.reduce((a, s) => a + (s.g?.done || 0), 0), total = list.reduce((a, s) => a + (s.g?.total || 0), 0);
      html = `<div class="ih"><span class="ik topic">주제</span><button class="x" data-pick="" title="닫기">×</button></div>
        <h2>#${esc(d.name)}</h2>
        <dl class="props"><dt>세션</dt><dd class="num">${list.length}</dd>
          <dt>호스트</dt><dd>${hosts.map(h => `<span class="hchip"><i class="sw" style="--hc:${this.colors.get(h)}"></i>${esc(h)}</span>`).join("")}</dd>
          <dt>전체 진행</dt><dd class="num">${done}/${total} 단계</dd></dl>
        <h3>이 주제를 다루는 세션</h3><div class="list">${list.map(s => this.sessRow(s)).join("")}</div>`;
    } else {
      const list = [...this.nodes.values()].filter(x => x.type === "session" && x.data.host === d.name).map(x => x.data);
      const projs = [...this.projects.values()].filter(p => p.host === d.name).sort((a, b) => b.sessions.length - a.sessions.length);
      html = `<div class="ih"><span class="ik" style="--hc:${this.colors.get(d.name)}">호스트</span><button class="x" data-pick="" title="닫기">×</button></div>
        <h2>${esc(d.name)}</h2>
        <dl class="props"><dt>연결</dt><dd><span class="dot ${d.connected ? "on" : "off"}"></span>${d.connected ? "실시간" : "끊김"}</dd>
          ${d.hostname ? `<dt>hostname</dt><dd><code>${esc(d.hostname)}</code></dd>` : ""}
          ${d.error && !d.connected ? `<dt>오류</dt><dd class="err">${esc(d.error)}</dd>` : ""}
          <dt>세션</dt><dd class="num">${list.length}</dd></dl>
        ${projs.length ? `<h3>프로젝트 <b class="num">${projs.length}</b></h3><div class="list">${projs.map(p =>
          `<button class="srow" data-pick="${this.layers.projects ? esc(p.id) : ""}"><i class="fd" style="--hc:${this.colors.get(d.name)}"></i>
            <span class="sb"><span class="t">${esc(p.name)}</span><span class="an">${esc(p.folder)} · 세션 ${p.sessions.length}</span></span></button>`).join("")}</div>` : ""}
        <h3>세션</h3><div class="list">${list.map(s => this.sessRow(s)).join("")}</div>`;
    }
    if (this.insp.dataset.h !== html) {
      const fresh = this.inspKey !== n.id;
      this.insp.innerHTML = html;
      this.insp.dataset.h = html;
      if (fresh) this.insp.scrollTop = 0;
      this.mini = null;
      const box = this.insp.querySelector(".mini");
      if (box) { this.mini = new GraphView(box, false); this.mini.ctx = { key: d.key }; }
    }
    this.inspKey = n.id;
    if (this.mini && d.g) this.mini.update(d.g);
  }
}
