// Plan graph: replay events (same rules as replay() in session/follow.py), layout, and an
// incrementally updated SVG view so state changes animate instead of re-rendering.

export function replayPlan(events) {
  if (!events || !events.length) return null;
  const g = { title: null, v: 0, nodes: {}, order: [], log: [] };
  const put = (id, title, deps, extra = {}) => {
    const n = g.nodes[id];
    if (n) {
      if (title) n.title = title;
      for (const d of deps) if (!n.deps.includes(d)) n.deps.push(d);
      if (n.state === "dropped") n.state = "left";
      for (const [k, v] of Object.entries(extra)) if (v) n[k] = v;
      return;
    }
    g.nodes[id] = { id, title: title || id, deps: [...deps], state: "left", from: null, by: null, v: g.v, ...extra };
    g.order.push(id);
  };
  for (const e of events) {
    const op = e.op;
    if (op === "plan" || op === "replan") {
      g.v += 1;
      g.title = e.title || g.title;
      const listed = new Set();
      for (const s of e.nodes || []) { put(s.id, s.title, s.after || []); listed.add(s.id); }
      if (op === "replan") {
        for (const n of Object.values(g.nodes))
          if (!listed.has(n.id) && n.state !== "done" && n.state !== "dropped") n.state = "dropped";
        g.log.push({ t: e.t, kind: "replan", text: `계획 v${g.v}${e.reason ? " · " + e.reason : ""}` });
      }
    } else if (op === "add" || op === "derive") {
      put(e.id, e.title, e.after || [], { from: e.from || null });
      for (const t of e.into || []) if (g.nodes[t] && !g.nodes[t].deps.includes(e.id)) g.nodes[t].deps.push(e.id);
      const src = e.from ? `${g.nodes[e.from]?.title || e.from} → ` : "";
      g.log.push({ t: e.t, kind: e.from ? "derive" : "add", text: `${src}${e.title}${e.reason ? " · " + e.reason : ""}` });
    } else if (op === "state" && g.nodes[e.id]) {
      g.nodes[e.id].state = e.state;
      if (e.state === "blocked") g.log.push({ t: e.t, kind: "blocked", text: `${g.nodes[e.id].title}${e.note ? " · " + e.note : ""}` });
    } else if (op === "next") {
      for (const n of Object.values(g.nodes)) if (n.state === "now") n.state = "done";
      if (g.nodes[e.id]) g.nodes[e.id].state = "now";
    } else if (op === "drop" && g.nodes[e.id]) {
      g.nodes[e.id].state = "dropped";
      g.nodes[e.id].by = e.by || null;
      g.log.push({ t: e.t, kind: "drop", text: `${g.nodes[e.id].title}${e.reason ? " · " + e.reason : ""}` });
    }
  }
  if (!g.order.length) return null;
  const live = g.order.map(id => g.nodes[id]).filter(n => n.state !== "dropped");
  g.total = live.length;
  g.done = live.filter(n => n.state === "done").length;
  g.current = live.filter(n => n.state === "blocked").concat(live.filter(n => n.state === "now"));
  return g;
}

// Columns from dependency depth; rows keep a branch below the step it came from.
function layout(g) {
  const layer = {}, visiting = new Set();
  const depth = id => {
    if (layer[id] != null) return layer[id];
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const n = g.nodes[id];
    let l = 0;
    for (const d of n.deps) if (g.nodes[d]) l = Math.max(l, depth(d) + 1);
    if (n.from && g.nodes[n.from]) l = Math.max(l, depth(n.from) + 1);
    visiting.delete(id);
    return (layer[id] = l);
  };
  g.order.forEach(depth);
  const occ = {}, row = {};
  for (const id of g.order) {
    const n = g.nodes[id];
    let pref = 0;
    if (n.from && row[n.from] != null) pref = row[n.from] + 1;
    else {
      const rs = n.deps.filter(d => row[d] != null).map(d => row[d]);
      if (rs.length) pref = Math.min(...rs);
    }
    const l = layer[id];
    occ[l] = occ[l] || new Set();
    let r = pref;
    while (occ[l].has(r)) r++;
    occ[l].add(r);
    row[id] = r;
  }
  return { layer, row };
}

const NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
const SIZES = { small: { W: 140, H: 36, gx: 38, gy: 16 }, big: { W: 160, H: 40, gx: 46, gy: 22 } };
const JUST_DONE_MS = 1800;
const STATE_KO = { done: "완료", now: "진행 중", side: "병행 중", blocked: "막힘", left: "대기", dropped: "제외" };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let uidSeq = 0;

export class GraphView {
  constructor(container, big = false) {
    this.uid = "fw" + (++uidSeq);
    this.s = big ? SIZES.big : SIZES.small;
    this.maxChars = big ? 12 : 9;
    this.svg = svgEl("svg", { class: "graph" + (big ? " big" : "") }, container);
    const defs = svgEl("defs", {}, this.svg);
    const lg = svgEl("linearGradient", { id: this.uid + "-shine", x1: 0, x2: 1, y1: 0, y2: 0 }, defs);
    [[0, 0], [0.5, 1], [1, 0]].forEach(([o, a]) => svgEl("stop", { offset: o, class: "shine-stop", "stop-opacity": a }, lg));
    this.gE = svgEl("g", { class: "edges" }, this.svg);
    this.gP = svgEl("g", { class: "pulses" }, this.svg);
    this.gN = svgEl("g", { class: "nodes" }, this.svg);
    this.nodes = new Map();
    this.edges = new Map();
    this.pulses = new Map();
    this.prev = new Map();
    this.justDone = new Map();
    this.first = true;
    this.seq = 0;

    // hover card (lives in the panel so the graph's horizontal scroll cannot clip it)
    const host = container.parentElement || container;
    this.tip = document.createElement("div");
    this.tip.className = "tip";
    host.appendChild(this.tip);
    this.svg.addEventListener("pointerover", e => this.showTip(e.target.closest(".n"), host));
    this.svg.addEventListener("pointerleave", () => this.tip.classList.remove("on"));
  }

  showTip(nodeEl, host) {
    if (!nodeEl || !this.lastG) return this.tip.classList.remove("on");
    const n = this.lastG.nodes[nodeEl.dataset.id];
    if (!n) return;
    const g = this.lastG;
    const extra = [];
    if (n.from) extra.push(`<span class="k">갈라져 나온 단계</span>${esc(g.nodes[n.from]?.title || n.from)}`);
    if (n.by) extra.push(`<span class="k">대체</span>${esc(g.nodes[n.by]?.title || n.by)}`);
    const deps = n.deps.filter(d => d !== n.from).map(d => g.nodes[d]?.title || d);
    if (deps.length) extra.push(`<span class="k">선행</span>${esc(deps.join(", "))}`);
    this.tip.innerHTML = `<div class="tt">${esc(n.title)}</div>
      <div class="ts ${n.state}"><i></i>${STATE_KO[n.state] || n.state}</div>
      ${extra.map(x => `<div class="tx">${x}</div>`).join("")}`;
    const r = nodeEl.querySelector(".box").getBoundingClientRect(), h = host.getBoundingClientRect();
    this.tip.style.left = Math.min(r.left - h.left, h.width - 250) + "px";
    this.tip.style.top = (r.bottom - h.top + 8) + "px";
    this.tip.classList.add("on");
  }

  makeNode(id, layerIndex) {
    const { W, H } = this.s;
    const clipId = `${this.uid}-c${++this.seq}`;
    const g = svgEl("g", { class: "n" }, this.gN);
    g.dataset.id = id;
    const cp = svgEl("clipPath", { id: clipId }, g);
    svgEl("rect", { width: W, height: H, rx: H / 2 }, cp);
    svgEl("rect", { class: "ripple", width: W, height: H, rx: H / 2 }, g);
    svgEl("rect", { class: "halo", x: -4, y: -4, width: W + 8, height: H + 8, rx: H / 2 + 4 }, g);
    svgEl("rect", { class: "box", width: W, height: H, rx: H / 2 }, g);
    const sg = svgEl("g", { "clip-path": `url(#${clipId})` }, g);   // static clip, moving band inside
    svgEl("rect", { class: "shine", x: -60, width: 60, height: H, fill: `url(#${this.uid}-shine)` }, sg);
    const ic = svgEl("g", { class: "ic", transform: `translate(${H / 2},${H / 2})` }, g);
    svgEl("circle", { class: "i-dot", r: 2.6 }, ic);
    svgEl("circle", { class: "i-track", r: 7 }, ic);
    svgEl("circle", { class: "i-spin", r: 7, pathLength: 100 }, ic);
    svgEl("circle", { class: "i-core", r: 2.6 }, ic);
    svgEl("circle", { class: "i-done", r: 8 }, ic);
    svgEl("path", { class: "i-check", d: "M-3.6,0.2 L-1.1,2.7 L3.8,-2.6", pathLength: 1 }, ic);
    svgEl("path", { class: "i-bang", d: "M0,-4 V0.6 M0,3.4 V3.6" }, ic);
    svgEl("path", { class: "i-drop", d: "M-3.5,0 H3.5" }, ic);
    const lb = svgEl("text", { class: "lb", x: H - 2, y: H / 2 }, g);
    g.style.animationDelay = this.first ? layerIndex * 80 + "ms" : "0ms";
    g.classList.add(this.first ? "intro" : "enter");
    return { g, lb };
  }

  update(g) {
    const { W, H, gx, gy } = this.s, P = 12, CW = W + gx, RH = H + gy;
    const { layer, row } = layout(g);
    const cols = Math.max(...g.order.map(i => layer[i])) + 1;
    const rows = Math.max(...g.order.map(i => row[i])) + 1;
    this.width = P * 2 + cols * CW - gx;
    this.height = P * 2 + rows * RH - gy;
    this.svg.setAttribute("viewBox", `0 0 ${this.width} ${this.height}`);
    this.svg.setAttribute("width", this.width);
    this.svg.setAttribute("height", this.height);
    const X = id => P + layer[id] * CW, Y = id => P + row[id] * RH;
    const now = Date.now();

    // nodes
    const seen = new Set();
    for (const id of g.order) {
      const n = g.nodes[id];
      seen.add(id);
      let v = this.nodes.get(id);
      if (!v) { v = this.makeNode(id, layer[id]); this.nodes.set(id, v); }
      const prev = this.prev.get(id);
      if (!this.first && prev && prev !== "done" && n.state === "done") this.justDone.set(id, now + JUST_DONE_MS);
      this.prev.set(id, n.state);
      const jd = (this.justDone.get(id) || 0) > now;
      const keep = ["intro", "enter"].filter(c => v.g.classList.contains(c));
      v.g.setAttribute("class", ["n", n.state, n.from ? "derived" : "", jd ? "jd" : "", ...keep].join(" ").trim());
      v.g.style.transform = `translate(${X(id)}px, ${Y(id)}px)`;
      const t = n.title.length > this.maxChars ? n.title.slice(0, this.maxChars - 1) + "…" : n.title;
      if (v.lb.textContent !== t) v.lb.textContent = t;
      if (jd && !this.jdTimer) this.jdTimer = setTimeout(() => { this.jdTimer = null; this.update(this.lastG); }, JUST_DONE_MS + 50);
    }
    for (const [id, v] of this.nodes) if (!seen.has(id)) {
      v.g.classList.add("leave");
      setTimeout(() => v.g.remove(), 450);
      this.nodes.delete(id);
    }

    // edges, plus a travelling light on every edge that leads into the step being worked on
    const want = [];
    for (const id of g.order) {
      const n = g.nodes[id];
      if (n.from) want.push([n.from, id, "derive"]);
      for (const d of n.deps) if (d !== n.from) want.push([d, id, g.nodes[d]?.from ? "merge" : "dep"]);
      if (n.state === "dropped" && n.by) want.push([id, n.by, "replace"]);
    }
    const eseen = new Set();
    for (const [a, b, kind] of want) {
      if (!g.nodes[a] || !g.nodes[b]) continue;
      const key = `${a}>${b}`;
      eseen.add(key);
      let p = this.edges.get(key);
      if (!p) {
        p = svgEl("path", {}, this.gE);
        p.style.animationDelay = this.first ? layer[a] * 80 + 120 + "ms" : "0ms";
        p.classList.add(this.first ? "intro" : "enter");
        this.edges.set(key, p);
      }
      const sa = g.nodes[a].state, sb = g.nodes[b].state;
      const x1 = X(a) + W, y1 = Y(a) + H / 2, x2 = X(b), y2 = Y(b) + H / 2, mx = (x1 + x2) / 2;
      const d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
      p.setAttribute("d", d);
      p.style.d = `path("${d}")`;
      const walked = sa === "done" && ["done", "now", "blocked", "side"].includes(sb);
      const flow = sa === "done" && (sb === "now" || sb === "side");
      const faded = sa === "dropped" || sb === "dropped";
      const keep = ["intro", "enter"].filter(c => p.classList.contains(c));
      p.setAttribute("class", ["e", kind, walked ? "walked" : "", flow ? "flow" : "", faded ? "faded" : "", ...keep].join(" ").trim());

      let pulse = this.pulses.get(key);
      if (flow && !pulse) {
        pulse = svgEl("path", { class: "pulse", pathLength: 1 }, this.gP);
        this.pulses.set(key, pulse);
      } else if (!flow && pulse) {
        pulse.remove();
        this.pulses.delete(key);
        pulse = null;
      }
      if (pulse) pulse.setAttribute("d", d);
    }
    for (const [key, p] of this.edges) if (!eseen.has(key)) {
      p.classList.add("leave");
      setTimeout(() => p.remove(), 450);
      this.edges.delete(key);
      if (this.pulses.has(key)) { this.pulses.get(key).remove(); this.pulses.delete(key); }
    }

    const wasFirst = this.first;
    setTimeout(() => {
      this.nodes.forEach(v => v.g.classList.remove(wasFirst ? "intro" : "enter"));
      this.edges.forEach(p => p.classList.remove(wasFirst ? "intro" : "enter"));
    }, wasFirst ? 1600 : 900);
    this.first = false;
    this.lastG = g;
  }

  // right edge of the current step, so a wide graph can bring it into view
  focusRight(g) {
    const cur = g.current[0];
    if (!cur) return 0;
    const { W, gx } = this.s;
    return 12 + layout(g).layer[cur.id] * (W + gx) + W;
  }
}
