// Project view, drawn as an ontology the way Palantir draws one: the project on the left, its sessions as a tree to the
// right of it, and each session's tasks side by side to the right of that. Which computer a session runs on is only a
// label. A line that is running right now marches; one waiting for input is amber; the rest stays still.
// The second tab is the project's data catalog, grouped by kind of data. Selecting a session shows on the right which
// data it reads (the paths in its conversation or its report) and what it has made so far.
import { outputsHtml } from "./viewer.js";
import { dur } from "./graph.js";

// the order the user dragged the projects into (this browser only); projects not in it keep their config.ini order
const ORDER_KEY = "fw-proj-order";
const savedOrder = () => { try { return JSON.parse(localStorage.getItem(ORDER_KEY) || "[]"); } catch (e) { return []; } };
export function orderProjects(list) {
  const o = savedOrder(), rank = p => { const i = o.indexOf(p.name); return i < 0 ? o.length : i; };
  return [...list].sort((a, b) => rank(a) - rank(b));
}
function saveOrder(names) { try { localStorage.setItem(ORDER_KEY, JSON.stringify(names)); } catch (e) {} }

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rad = d => d * Math.PI / 180;
const pol = (cx, cy, r, d) => [cx + r * Math.cos(rad(d)), cy + r * Math.sin(rad(d))];
const f1 = n => n.toFixed(1);
function arc(cx, cy, r, a0, a1) {
  const [x0, y0] = pol(cx, cy, r, a0), [x1, y1] = pol(cx, cy, r, a1);
  return `M${f1(x0)} ${f1(y0)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${f1(x1)} ${f1(y1)}`;
}
const textW = (s, px = 13) => [...String(s)].reduce((w, ch) => w + (/[\u3131-\uD79D]/.test(ch) ? px : px * 0.58), 0);
const fit = (s, px, size = 13) => {   // the longest start of s that fits in px at this font size
  s = String(s || "");
  if (textW(s, size) <= px) return s;
  const ch = [...s];
  while (ch.length > 1 && textW(ch.join("") + "…", size) > px) ch.pop();
  return ch.join("") + "…";
};
const cut = (s, n) => [...String(s || "")].length > n ? [...String(s)].slice(0, n - 1).join("") + "…" : String(s || "");
const reduced = () => document.documentElement.classList.contains("calm");   // the motion switch in the header

export function bytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i >= 3 && n / 1024 ** i < 10 ? 1 : 0) + " " + u[i];
}
const count = n => Number(n || 0).toLocaleString("ko-KR");
function ago(sec) {
  if (!sec) return "";
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 90) return "방금";
  if (s < 3600) return Math.floor(s / 60) + "분 전";
  if (s < 86400) return Math.floor(s / 3600) + "시간 전";
  return Math.floor(s / 86400) + "일 전";
}

const KIND_KO = { reads: "시퀀싱 읽기", variants: "변이", tables: "표·행렬", reference: "참조 서열", images: "이미지", docs: "문서", other: "기타" };
const KIND_ORDER = ["reads", "variants", "tables", "reference", "images", "docs", "other"];

// Which analysis uses which data: words of the category name, widened by a few domain synonyms, against the
// analysis title, plan steps and folder. A guess; the inspector says so.
const SYN = {
  dna: ["dna", "wgs", "wes", "exome", "genome", "genomic", "cnv", "snv", "indel", "mutation", "variant", "somatic", "germline",
        "hrd", "mutect", "strelka", "purple", "wgd", "vcf", "bam", "변이", "돌연변이", "유전체"],
  rna: ["rna", "rnaseq", "transcriptome", "expression", "deg", "deseq", "gsea", "gsva", "deconv", "deconvolution", "cibersort",
        "immune", "fusion", "발현", "전사체"],
  protein: ["protein", "proteome", "proteomics", "단백질"],
  spatial: ["spatial", "visium", "xenium", "공간"],
  meta: ["meta", "metadata", "clinical", "survival", "임상", "생존", "메타"],
  validation: ["validation", "external", "검증"],
  longread: ["longread", "pacbio", "hifi", "nanopore", "롱리드"],
  methyl: ["methyl", "methylation", "메틸화"],
  single: ["single", "scrna", "scrnaseq", "단일세포"],
};
const STOP = new Set(["data", "raw", "derived", "files", "file", "the", "and", "all", "낱개", "파일", "기타", "cohort", "cohorts", "set"]);
const words = s => String(s || "").toLowerCase().replace(/(^|[\s/\\])\d+[_-]/g, "$1").split(/[^a-z0-9가-힣]+/).filter(w => w.length >= 2 && !STOP.has(w));
function catTokens(name) {
  const own = words(name), out = new Set(own);
  for (const [k, list] of Object.entries(SYN))
    if (own.some(w => w === k || list.includes(w) || (w.length >= 3 && w.startsWith(k)))) { out.add(k); list.forEach(x => out.add(x)); }
  return out;
}
const normp = x => String(x || "").replace(/\\/g, "/").replace(/\/+$/, "");
const uses = (text, tok) => words(text).some(w => tok.has(w) || [...tok].some(t => t.length >= 3 && w.startsWith(t)));


// the catalog's groups, first match wins (a validation cohort's RNA belongs to the cohort, reference RNA to reference)
const MODALITY = [
  ["cohort", "외부·공개 코호트", /(tcga|pcawg|hmf|hartwig|metabric|validation|external|(^|[^a-z])ega|cubrics|icgc|cptac|(^|[^a-z])geo([^a-z]|$)|검증|외부)/],
  ["ref", "참조·주석", /(reference|(^|[^a-z])ref([^a-z]|$)|genome_?ref|gtf|fasta|grch|hg38|hg19|annotation|database|alphamissense|clinvar|gnomad)/],
  ["clinical", "임상·메타데이터", /(clinic|metadata|(^|[^a-z])meta([^a-z]|$)|sample.?info|sample.?order|survival|임상|patient)/],
  ["single", "단일세포", /(single.?cell|scrna|10x|scref|(^|[^a-z])sc_)/],
  ["spatial", "공간·이미지", /(spatial|visium|cosmx|xenium|(^|[^a-z])tma|image|공간)/],
  ["protein", "단백질", /(protein|proteom|olink|단백)/],
  ["rna", "전사체 (RNA)", /(rna|transcript|express|(^|[^a-z])counts?([^a-z]|$)|trimmed|(^|[^a-z])deg([^a-z]|$)|salmon|발현)/],
  ["dna", "유전체 (DNA)", /(dna|wgs|wes|exome|genom|(^|[^a-z])bam|vcf|cnv|copy.?number|(^|[^a-z])sv|somatic|germline|driver|signature|telomere|wgd|timing|purple|linx|gridss|hrd|mutation|snv|indel|epistasis|methyl|evolution|variant|rawdata)/],
];
const ETC = ["etc", "기타", null];
function modalityOf(c) {
  const text = (c.parts.map(p => normp(p.path).split("/").slice(-4).join("/")).join(" ") + " " + c.name).toLowerCase();
  return MODALITY.find(([, , re]) => re.test(text)) || ETC;
}
function stageOf(c) {
  const top = Object.entries(c.kinds).sort((a, b) => b[1][1] - a[1][1])[0]?.[0];
  const path = c.parts.map(p => normp(p.path).toLowerCase()).join(" ");
  if (top === "reads" || /(raw.?data|\/raw\/|fastq|00_raw)/.test(path)) return ["raw", "원본"];
  if (top === "reference") return ["ref", "참조"];
  if (top === "images" || top === "docs") return ["out", "결과물"];
  return top ? ["proc", "가공"] : ["none", "비어 있음"];
}
const OTHER = "그 밖의 세션";   // sessions whose folder is in no [project:*]
const STATUS_KO = { busy: "실행 중", waiting: "입력 대기", idle: "대기", ended: "종료" };
const lastAct = a => a.kind === "session" ? Math.max(a.s.statusUpdatedAt || 0, a.s.updatedAt || 0, (a.s.mtime || 0) * 1000) : Date.parse(a.r.date) || 0;
const ICON = {
  project: "M2.5 4.5h4l1.4 1.5h5.6v6.5h-11z",
  session: "M3.5 5.5l2.6 2.5-2.6 2.5M8 11h4.5",
  report: "M4.5 2.5h5l2.5 2.5v8.5h-7.5zM9.5 2.5V5H12",
  data: "M3.5 4.2c0-1 2-1.7 4.5-1.7s4.5.7 4.5 1.7v7.6c0 1-2 1.7-4.5 1.7s-4.5-.7-4.5-1.7zM3.5 4.2c0 1 2 1.7 4.5 1.7s4.5-.7 4.5-1.7",
  group: "M3.5 5h9M3.5 8h9M3.5 11h9",
  theme: "M2.5 5.5l5.5-3 5.5 3-5.5 3zM2.5 8.5l5.5 3 5.5-3M2.5 11l5.5 3 5.5-3",
};
function route(pts, r = 7) {   // through right-angle corners, each rounded
  let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [x, y] = pts[i], [nx, ny] = pts[i + 1];
    const rr = Math.min(r, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
    d += ` L${f1(x - Math.sign(x - px) * rr)} ${f1(y - Math.sign(y - py) * rr)} Q${f1(x)} ${f1(y)} ${f1(x + Math.sign(nx - x) * rr)} ${f1(y + Math.sign(ny - y) * rr)}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  return d + ` L${f1(lx)} ${f1(ly)}`;
}

function elbow(x1, y1, xt, x2, y2, r = 7) {   // across from (x1,y1) to a trunk at xt, along it, across into (x2,y2); either direction
  if (Math.abs(y2 - y1) < 1) return `M${f1(x1)} ${f1(y1)} H${f1(x2)}`;
  const d = y2 > y1 ? 1 : -1, s = x2 >= x1 ? 1 : -1, rr = Math.min(r, Math.abs(y2 - y1) / 2, Math.abs(xt - x1) || r);
  return `M${f1(x1)} ${f1(y1)} H${f1(xt - s * rr)} Q${f1(xt)} ${f1(y1)} ${f1(xt)} ${f1(y1 + d * rr)} V${f1(y2 - d * rr)} Q${f1(xt)} ${f1(y2)} ${f1(xt + s * rr)} ${f1(y2)} H${f1(x2)}`;
}
export class Projects {
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;               // { hostColor(name), onOpen(sessionKey), onProject, onCat, demo }
    this.cur = null;
    this.sel = null;                // selected session or report id
    this.tab = "tree";              // "tree" (session ontology) | "data" (catalog)
    this.toggled = new Map();       // id -> expanded, where the user changed the default
    this.dsOpen = null;             // dataset row opened in the catalog
    this.openAn = null;             // analysis id while its flow window is open
    this.openCat = null;
    this.seenFiles = new Map();
    this.hiding = new Map();        // id -> hidden, sent and not yet back from the list host
    this.rethemed = new Map();      // session id -> theme, moved here and not yet back from the list host
    this.showHidden = false;
    this.showEnded = false;         // closed sessions stay off the map unless asked for (or found by the search)
    this.findQ = "";
    this.prevDone = new Map();      // session id -> steps done at the last paint (the one that just finished gets a tick)
    this.drawn = new Set();         // projects drawn once (their entrance plays once)
    this.views = {};                // project -> {x, y, z} of the canvas
    this.pos = {};                  // project -> {node key: [dx, dy]} where the user moved a node
    try {
      this.cur = localStorage.getItem("fw-proj"); this.tab = localStorage.getItem("fw-proj-tab") || "tree";
      this.views = JSON.parse(localStorage.getItem("fw-proj-view") || "{}");
      this.pos = JSON.parse(localStorage.getItem("fw-proj-pos") || "{}");
      this.showEnded = localStorage.getItem("fw-proj-ended") === "1";
    } catch (e) {}
    root.innerHTML = `<nav class="pj-rail" aria-label="프로젝트"><div class="pj-list"></div>
        <div class="pj-add"><button class="pj-add-btn" type="button" aria-expanded="false"><svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>프로젝트 추가</button>
          <form class="pj-add-form" hidden><b class="pj-add-title">프로젝트 추가</b><label class="pj-add-name">이름<input name="name" maxlength="60" autocomplete="off" placeholder="예: Variant agent"></label>
            <div class="pj-add-hosts"></div>
            <p class="pj-add-hint">프로젝트 폴더가 있는 서버만 채우면 됩니다. 이 폴더 안에서 돈 세션이 이 프로젝트로 묶입니다. 폴더가 여럿이면 쉼표로 잇습니다.</p>
            <p class="pj-add-err" role="alert" hidden></p>
            <div class="pj-add-act"><button type="submit">추가</button><button type="button" data-add-cancel>취소</button></div></form></div></nav>
      <section class="pj-stage"><div class="pj-head"></div>
        <div class="pj-tree"><svg class="pj-svg" role="img"></svg>
          <div class="pj-find"><label><svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
            <input type="search" placeholder="세션 찾기 (꺼진 것도)" aria-label="세션 찾기"></label>
            <button class="pj-ended" aria-pressed="false" title="꺼진 세션도 지도에 보이기"></button></div></div><div class="pj-cat" hidden></div>
        <div class="pj-zoom" role="group" aria-label="확대·축소"><button data-zoom="in" title="확대 (+)" aria-label="확대">+</button>
          <button data-zoom="out" title="축소 (−)" aria-label="축소">−</button><button data-zoom="fit" title="한 화면에 맞추기 (0)">맞춤</button>
          <button data-zoom="one" class="pj-zl" title="원래 크기">100%</button><button data-zoom="reset" title="옮긴 상자를 제자리로">정렬</button></div>
        <div class="pj-scrim"></div><div class="pj-win" role="dialog" aria-modal="true" hidden></div></section>
      <aside class="pj-insp"></aside>`;
    this.rail = root.querySelector(".pj-list");
    this.head = root.querySelector(".pj-head");
    this.treeBox = root.querySelector(".pj-tree");
    this.svg = root.querySelector(".pj-svg");
    this.cat = root.querySelector(".pj-cat");
    this.insp = root.querySelector(".pj-insp");
    this.win = root.querySelector(".pj-win");
    this.scrim = root.querySelector(".pj-scrim");
    root.addEventListener("click", e => this.click(e));
    this.bindRailDrag();
    this.bindAdd();
    this.bindPeek();
    this.svg.addEventListener("dblclick", e => { const n = e.target.closest("[data-sel]"); if (n) this.openFlowAt(n.dataset.sel, n); });
    this.bindCanvas();
    this.scrim.addEventListener("click", () => this.closeCat());
    this.bindMenu();
    root.querySelector(".pj-find input").addEventListener("input", e => { this.findQ = e.target.value.trim().toLowerCase(); this.paint(true); });
    root.querySelector(".pj-ended").addEventListener("click", () => {
      this.showEnded = !this.showEnded;
      try { localStorage.setItem("fw-proj-ended", this.showEnded ? "1" : "0"); } catch (e) {}
      this.paint(true);
    });
    document.addEventListener("keydown", e => {
      if (!this.root.offsetParent || e.target.closest("input, textarea")) return;
      if (e.key === "Escape") { if (this.openAn) this.closeCat(); else if (this.sel) { this.sel = null; this.paint(true); } }
      if (this.tab === "tree" && !this.openAn && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === "+" || e.key === "=") this.setZoom(this.view.z * 1.2);
        else if (e.key === "-" || e.key === "_") this.setZoom(this.view.z / 1.2);
        else if (e.key === "0") this.fitZoom();
      }
    });
  }

  update(sessions, st) {
    this.st = st;
    this.sessions = sessions;
    this.projects = orderProjects(st.projects || []);
    if (sessions.some(s => !s.mainProject && (s.g || s.status !== "ended")))
      this.projects = [...this.projects, { name: OTHER, folders: {}, data: [], other: true }];
    if (!this.projects.some(p => p.name === this.cur)) this.cur = this.projects[0]?.name || null;
    this.paint();
  }

  model(p) {
    const inv = this.st.inventory || {}, cats = new Map(), reports = [], findings = [], backlog = [], scans = [];
    for (const [host, folders] of Object.entries(p.folders)) {
      const h = inv[host] || {}, hs = this.st.hosts.find(x => x.name === host);
      scans.push({ host, t: h.t, error: h.error, running: h.running, connected: hs?.connected,
                   missing: folders.filter(f => h.folders?.[f] && !h.folders[f].exists) });
      for (const f of folders) {
        const r = h.folders?.[f];
        if (!r || !r.exists) continue;
        for (const c of r.data || []) {
          const key = c.name.toLowerCase();
          if (!cats.has(key)) cats.set(key, { key, name: c.name, root: c.root, files: 0, bytes: 0, newest: 0, samples: 0,
                                              kinds: {}, exts: {}, parts: [], partial: false, note: null });
          const m = cats.get(key);
          m.files += c.files; m.bytes += c.bytes; m.newest = Math.max(m.newest, c.newest || 0);
          m.samples = Math.max(m.samples, c.samples || 0); m.partial ||= c.partial; m.note ||= c.note || null;
          for (const [k, [n, b]] of Object.entries(c.kinds || {})) { const x = m.kinds[k] ||= [0, 0]; x[0] += n; x[1] += b; }
          for (const [e, n] of c.exts || []) m.exts[e] = (m.exts[e] || 0) + n;
          m.parts.push({ host, path: c.path, files: c.files, bytes: c.bytes, newest: c.newest });
        }
        for (const x of r.reports || []) reports.push({ ...x, host, id: "r:" + host + ":" + x.path });
        for (const x of r.findings || []) findings.push({ ...x, host });
        for (const x of r.backlog || []) {
          const b = typeof x === "string" ? { text: x } : x;
          if (!backlog.some(y => y.text === b.text)) backlog.push({ ...b, host });
        }
      }
    }
    const list = [...cats.values()];
    for (const c of list) c.tok = catTokens(c.name);
    const hid = { ...(this.st.todo?.hidden || {}) };
    for (const [id, on] of this.hiding) if (on) hid[id] = true; else delete hid[id];
    const keep = id => this.showHidden || !hid[id];
    const q = this.findQ, found = s => [s.label, s.planTitle, s.cwd, ...(s.g ? s.g.order.map(id => s.g.nodes[id].title) : [])].join(" ").toLowerCase().includes(q);
    const mine = this.sessions.filter(s => (p.other ? !s.mainProject : s.mainProject === p.name) && (s.g || s.status !== "ended") && keep("s:" + s.key));
    const endedN = mine.filter(s => s.status === "ended").length;
    const sess = mine.filter(s => q ? found(s) : s.status !== "ended" || this.showEnded)
      .map(s => ({ kind: "session", id: "s:" + s.key, s, host: s.host, label: s.label,
                   report: s.workDir && reports.find(r => r.host === s.host && normp(r.path) === normp(s.workDir)),
                   text: [s.label, s.cwd, ...(s.g ? s.g.order.map(id => s.g.nodes[id].title) : [])].join(" ") }));
    const taken = new Set(sess.map(a => a.report?.id).filter(Boolean));
    reports.sort((a, b) => b.date.localeCompare(a.date) || b.mtime - a.mtime);
    const reps = reports.filter(r => !taken.has(r.id) && keep(r.id) && (!q || (r.slug + " " + (r.title || "")).toLowerCase().includes(q))).map(r => ({ kind: "report", id: r.id, r, host: r.host,
      label: r.title || r.slug.replace(/[_-]+/g, " "), text: r.slug + " " + (r.title || "") }));
    const read = paths => list.filter(c => c.parts.some(pt => paths.some(q => normp(q) === normp(pt.path) || normp(q).startsWith(normp(pt.path) + "/")))).map(c => c.key);
    for (const a of [...sess, ...reps]) {
      const inputs = (a.kind === "report" ? a.r : a.report)?.inputs || [];
      a.cats = inputs.length ? read(inputs) : [];
      a.exact = a.cats.length > 0;   // from the paths its report quotes ...
      if (a.kind === "session" && a.s.dataRefs?.length) {   // ... or that its conversation touched ...
        const base = normp(a.s.cwd);
        a.refs = a.s.dataRefs.map(([q, n]) => { const abs = /^([A-Za-z]:)?\//.test(q) ? q : base + "/" + q; return { path: abs, n, key: read([abs])[0] || null }; });
        if (!a.exact) { a.cats = [...new Set(a.refs.map(r => r.key).filter(Boolean))]; a.exact = a.cats.length > 0; }
      }
      if (!a.exact) a.cats = list.filter(c => uses(a.text, c.tok)).map(c => c.key);   // ... else guessed from names
    }
    findings.sort((a, b) => b.date.localeCompare(a.date));
    for (const a of [...sess, ...reps]) a.hidden = !!hid[a.id];
    const th = this.st.todo?.sessionThemes || {};
    for (const a of sess) {
      if (this.rethemed.has(a.id) && this.rethemed.get(a.id) === (th[a.id]?.theme || null)) this.rethemed.delete(a.id);
      const t = this.rethemed.has(a.id) ? this.rethemed.get(a.id) : th[a.id]?.theme;
      a.theme = t || null;
      a.themeBy = th[a.id]?.by || null;
    }
    return { p, cats: list, sessions: sess, reports: reps, findings, backlog, scans, hiddenN: Object.keys(hid).length, endedN,
             totals: { bytes: list.reduce((s, c) => s + c.bytes, 0), files: list.reduce((s, c) => s + c.files, 0) } };
  }

  // ── paint ─────────────────────────────────────────────────────────────
  paint(force) {
    if (!this.cur) return this.empty();
    const p = this.projects.find(x => x.name === this.cur), M = this.model(p);
    this.M = M;
    if (p.other) this.tab = "tree";   // no folders, so no data to catalog
    this.paintRail();
    this.paintHead(M);
    this.treeBox.hidden = this.tab !== "tree";
    this.root.querySelector(".pj-zoom").hidden = this.tab !== "tree";
    this.cat.hidden = this.tab !== "data";
    if (this.tab === "tree") this.drawTree(M, force);
    else this.drawCatalog(M);
    this.paintInsp(M);
    if (this.openAn) this.drawFlow(false);
    this.drawn.add(this.cur);
  }

  empty() {
    this.rail.innerHTML = this.head.innerHTML = this.svg.innerHTML = this.cat.innerHTML = "";
    this.insp.innerHTML = `<div class="pj-empty"><h2>프로젝트가 아직 없습니다</h2>
      <p>config.ini 에 프로젝트마다 섹션을 하나씩 넣으면, 서버가 달라도 같은 프로젝트의 세션이 한 트리로 모이고 데이터가 정리돼 보입니다.</p>
      <pre>[project:유방암 코호트]\nlab-server = /home/me/R_env/01_brca\nlocal      = C:\\work\\brca</pre><p>저장한 뒤 <code>fw restart</code>.</p></div>`;
  }

  paintRail() {
    const html = this.projects.map(p => {
      const ss = this.sessions.filter(s => (p.other ? !s.mainProject : s.mainProject === p.name) && s.status !== "ended");
      const run = ss.filter(s => s.status === "busy").length, wait = ss.filter(s => s.status === "waiting").length;
      return `<button class="pj-p${p.name === this.cur ? " on" : ""}${p.other ? " other" : ""}${run ? " running" : wait ? " waiting" : ""}" data-proj="${esc(p.name)}"${
        p.other ? "" : ` draggable="true" title="끌어서 순서 바꾸기 (Alt+↑↓)"`}>
        <span class="nm">${run || wait ? `<i class="beacon" aria-hidden="true"></i>` : ""}${esc(p.name)}</span>
        <span class="live">${run ? `<i class="dot run"></i>실행 중 ${run}` : ""}${wait ? `<i class="dot wait"></i>입력 대기 ${wait}` : ""}${!run && !wait ? `<span class="quiet">세션 ${ss.length}개 · 쉬는 중</span>` : ""}</span></button>`;
    }).join("");
    if (this.rail.dataset.h !== html) { this.rail.innerHTML = html; this.rail.dataset.h = html; }
  }

  // "프로젝트 추가" and "폴더 고치기": a name and, per server, the folders; the server writes config.ini
  bindAdd() {
    const box = this.root.querySelector(".pj-add"), btn = box.querySelector(".pj-add-btn"), form = this.addForm = box.querySelector("form");
    const err = form.querySelector(".pj-add-err"), hostsBox = form.querySelector(".pj-add-hosts");
    const close = () => { form.hidden = true; btn.hidden = false; btn.setAttribute("aria-expanded", "false"); err.hidden = true; form.reset(); this.editing = null; };
    btn.addEventListener("click", () => this.openProjectForm(null));
    form.querySelector("[data-add-cancel]").addEventListener("click", close);
    form.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const name = form.elements.name.value.trim(), folders = {}, was = this.editing;
      for (const i of hostsBox.querySelectorAll("input")) {
        const paths = i.value.split(",").map(s => s.trim()).filter(Boolean);
        if (paths.length) folders[i.dataset.host] = paths;
      }
      const bad = !name ? "이름을 적어 주세요" : !Object.keys(folders).length ? "폴더를 하나 이상 적어 주세요" : "";
      if (bad) { err.textContent = bad; err.hidden = false; return; }
      form.classList.add("busy");
      try {
        const out = await this.post("/api/project", was ? { do: "update", name: was, newName: name, folders } : { name, folders });
        close();
        if (was && was !== name) this.renameLocal(was, name);
        this.cur = name; this.sel = null;
        try { localStorage.setItem("fw-proj", name); } catch (x) {}
        this.say(out.note || (was ? `'${cut(name, 24)}' 고침 · 폴더를 다시 읽는 중` : `프로젝트 '${cut(name, 24)}' 추가함 · 폴더를 읽는 중`));
      } catch (x) {
        err.textContent = x.message; err.hidden = false;
      } finally {
        form.classList.remove("busy");
      }
    });
  }

  openProjectForm(p) {
    const form = this.addForm, btn = this.root.querySelector(".pj-add-btn"), hostsBox = form.querySelector(".pj-add-hosts");
    // a folder of an existing project on each server hints at where projects live there
    const near = h => { const f = this.projects.map(x => x.folders?.[h]?.[0]).find(Boolean); return f ? f.replace(/[\\/][^\\/]*$/, "") + (f.includes("\\") ? "\\…" : "/…") : ""; };
    this.editing = p ? p.name : null;
    form.querySelector(".pj-add-title").textContent = p ? `'${cut(p.name, 20)}' 고치기` : "프로젝트 추가";
    form.querySelector("button[type=submit]").textContent = p ? "저장" : "추가";
    form.elements.name.value = p ? p.name : "";
    hostsBox.innerHTML = (this.st?.hosts || []).map(h => `<label>${esc(h.name)}<input data-host="${esc(h.name)}" autocomplete="off" spellcheck="false"
      value="${esc((p?.folders?.[h.name] || []).join(", "))}" placeholder="${esc(near(h.name) || "폴더 경로")}"></label>`).join("");
    form.querySelector(".pj-add-err").hidden = true;
    form.hidden = false; btn.hidden = true; btn.setAttribute("aria-expanded", "true");
    form.scrollIntoView({ block: "nearest" });
    (p ? hostsBox.querySelector("input") : form.elements.name).focus();
  }

  // right-click on a project in the rail (or 프로젝트 고치기 on its box in the map)
  projectMenu(name) {
    const p = this.projects.find(x => x.name === name && !x.other);
    if (!p) return null;
    const list = this.projects.filter(x => !x.other).map(x => x.name), i = list.indexOf(name);
    const where = Object.entries(p.folders).map(([h, fs]) => `${h} ${fs.length}`).join(" · ");
    return { head: name, sub: `폴더 ${where}`, items: [
      { input: true, icon: "edit", value: name, placeholder: "프로젝트 이름", hint: "이름 바꾸기",
        submit: v => { if (v && v !== name) this.renameProject(p, v); } },
      { label: "폴더 고치기", icon: "folder", run: () => this.openProjectForm(p) },
      "-",
      { label: "위로 옮기기", icon: "up", disabled: i <= 0, run: () => this.moveProject(name, i - 1) },
      { label: "아래로 옮기기", icon: "down", disabled: i >= list.length - 1, run: () => this.moveProject(name, i + 1) },
      "-",
      { label: "목록에서 빼기", icon: "trash", danger: true, run: () => this.removeProject(p) }] };
  }

  renameProject(p, to) {
    this.post("/api/project", { do: "update", name: p.name, newName: to, folders: p.folders })
      .then(out => { this.renameLocal(p.name, to); this.paint(true); this.say(out.note || `'${cut(p.name, 16)}' 을 '${cut(to, 16)}' 로 바꿈`); },
            e => this.fail(e.message));
  }

  removeProject(p) {
    this.post("/api/project", { do: "delete", name: p.name })
      .then(() => {
        if (this.cur === p.name) this.cur = null;
        this.say(`'${cut(p.name, 20)}' 를 목록에서 뺌 · 폴더와 세션은 그대로`, () =>
          this.post("/api/project", { name: p.name, folders: p.folders }).then(() => this.say("되돌림"), e => this.fail(e.message)));
      }, e => this.fail(e.message));
  }

  // what this browser keeps under the project's name (order, chosen project, map view, moved boxes) follows a rename
  renameLocal(from, to) {
    const swap = o => { if (o && from in o) { o[to] = o[from]; delete o[from]; } };
    swap(this.views); swap(this.pos);
    if (this.cur === from) this.cur = to;
    this.drawn.delete(from);
    this.saveView();
    saveOrder(savedOrder().map(n => n === from ? to : n));
    try {
      if (localStorage.getItem("fw-proj") === from) localStorage.setItem("fw-proj", to);
      if (localStorage.getItem("fw-todo-proj") === from) localStorage.setItem("fw-todo-proj", to);
    } catch (e) {}
  }

  // a box whose name or line does not fit opens out over the map while the pointer rests on it
  bindPeek() {
    const peek = this.peek = document.createElement("div");
    peek.className = "pj-peek";
    peek.hidden = true;
    this.root.appendChild(peek);
    let timer = null, on = null;
    const hide = this.hidePeek = () => { clearTimeout(timer); on = null; peek.hidden = true; peek.classList.remove("in"); };
    this.svg.addEventListener("pointerover", e => {
      const nd = e.target.closest(".nd[data-tt]");
      if (!nd || nd === on) return;
      hide();
      if (this.drag || ![...nd.querySelectorAll(".nt, .ns")].some(t => t.textContent.endsWith("…"))) return;
      on = nd;
      timer = setTimeout(() => {
        if (!nd.isConnected || this.drag || (this.menu && !this.menu.hidden)) return;
        const r = nd.getBoundingClientRect(), z = this.view.z, dx = (+nd.dataset.tx || 0) * z;
        peek.innerHTML = `<b>${esc(nd.dataset.tt)}</b>${[nd.dataset.ts, nd.dataset.ts2].filter(Boolean).map(s => `<span>${esc(s)}</span>`).join("")}`;
        Object.assign(peek.style, { left: `${r.left + dx - 9 * z}px`, top: `${r.top}px`, minWidth: `${r.right - r.left - dx + 9 * z}px`,
          minHeight: `${r.height}px`, maxWidth: `${Math.max(r.width, 440 * z)}px`, fontSize: `${13 * z}px`, padding: `${7 * z}px ${12 * z}px ${8 * z}px ${9 * z}px` });
        peek.hidden = false;
        requestAnimationFrame(() => peek.classList.add("in"));
      }, 160);
    });
    this.svg.addEventListener("pointerout", e => { if (on && !on.contains(e.relatedTarget)) hide(); });
    this.treeBox.addEventListener("pointerdown", hide);
    this.treeBox.addEventListener("wheel", hide, { passive: true });
    this.svg.addEventListener("contextmenu", hide);
  }

  // drag a project up or down the rail (or Alt+arrow on the focused one) to reorder; "그 밖의 세션" stays last
  bindRailDrag() {
    const names = () => this.projects.filter(p => !p.other).map(p => p.name);
    const move = this.moveProject = (name, to) => {
      const list = names().filter(n => n !== name);
      list.splice(Math.max(0, Math.min(to, list.length)), 0, name);
      saveOrder(list);
      this.projects = orderProjects(this.projects);
      this.paintRail();
      this.rail.querySelector(`[data-proj="${CSS.escape(name)}"]`)?.focus();
      this.opts.onOrder?.();
    };
    const clear = () => this.rail.querySelectorAll(".drop-a,.drop-b").forEach(b => b.classList.remove("drop-a", "drop-b"));
    const slot = e => {   // the project under the pointer, and whether the drop lands above or below it
      const b = e.target.closest(".pj-p[draggable]");
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { b, below: e.clientY > r.top + r.height / 2 };
    };
    this.rail.addEventListener("dragstart", e => {
      const b = e.target.closest(".pj-p[draggable]");
      if (!b) return;
      this.dragProj = b.dataset.proj;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", this.dragProj);
      b.classList.add("dragging");
    });
    this.rail.addEventListener("dragover", e => {
      const s = this.dragProj && slot(e);
      if (!s) return;
      e.preventDefault();
      clear();
      if (s.b.dataset.proj !== this.dragProj) s.b.classList.add(s.below ? "drop-b" : "drop-a");
    });
    this.rail.addEventListener("dragleave", e => { if (!this.rail.contains(e.relatedTarget)) clear(); });
    this.rail.addEventListener("drop", e => {
      const s = this.dragProj && slot(e);
      clear();
      if (!s || s.b.dataset.proj === this.dragProj) return;
      e.preventDefault();
      const rest = names().filter(n => n !== this.dragProj);
      move(this.dragProj, rest.indexOf(s.b.dataset.proj) + (s.below ? 1 : 0));
    });
    this.rail.addEventListener("dragend", () => {
      clear();
      this.rail.querySelector(".dragging")?.classList.remove("dragging");
      this.dragProj = null;
    });
    this.rail.addEventListener("contextmenu", e => {
      const b = e.target.closest(".pj-p[draggable]");
      if (!b) return;
      e.preventDefault();
      this.openMenu(b, e.clientX, e.clientY, this.projectMenu(b.dataset.proj));
    });
    this.rail.addEventListener("keydown", e => {
      const b = e.target.closest(".pj-p[draggable]");
      if (b && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) {
        e.preventDefault();
        const r = b.getBoundingClientRect();
        return this.openMenu(b, r.left + 24, r.bottom - 4, this.projectMenu(b.dataset.proj));
      }
      if (!b || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      move(b.dataset.proj, names().indexOf(b.dataset.proj) + (e.key === "ArrowUp" ? -1 : 1));
    });
  }

  paintHead(M) {
    const scan = M.scans.map(s => `<span class="scan${s.error ? " bad" : ""}${s.running ? " busy" : ""}" title="${esc(s.error || "")}">${esc(s.host)} ${
      s.running ? "읽는 중" : s.error ? (s.t ? `연결 안 됨 · ${ago(s.t)} 내용` : "연결 안 됨") : s.t ? ago(s.t) : "아직 안 읽음"}</span>`).join("");
    const html = `<h1>${esc(M.p.name)}</h1>
      <div class="pj-tabs" role="tablist"${M.p.other ? " hidden" : ""}><button role="tab" data-tab="tree" aria-selected="${this.tab === "tree"}">세션 온톨로지</button><button role="tab" data-tab="data" aria-selected="${this.tab === "data"}">데이터 카탈로그</button></div>
      ${this.tab === "tree" ? `<div class="pj-legend"><span><i class="lg run"></i>실행 중</span><span><i class="lg wait"></i>입력 대기</span><span><i class="lg done"></i>끝난 단계</span><span><i class="lg left"></i>남은 단계</span></div>`
        : `<div class="pj-scans">${scan}<button class="pj-refresh" title="서버의 데이터 폴더를 지금 다시 읽기"${this.opts.demo ? " disabled" : ""}>다시 읽기</button></div>`}`;
    if (this.head.dataset.h !== html) { this.head.innerHTML = html; this.head.dataset.h = html; }
  }

  // ── a free canvas: drag the background to move, ⌘/Ctrl + wheel or a pinch to zoom, drag a node to place it ──
  get view() {
    return this.views[this.cur] ||= { x: 0, y: 0, z: 1 };
  }

  applyView() {
    const v = this.view;
    this.svg.querySelector(".vp")?.setAttribute("transform", `translate(${f1(v.x)} ${f1(v.y)}) scale(${v.z.toFixed(3)})`);
    this.treeBox.style.backgroundPosition = `${f1(v.x)}px ${f1(v.y)}px`;   // the dot grid moves and scales with the canvas
    this.treeBox.style.backgroundSize = `${f1(18 * v.z)}px ${f1(18 * v.z)}px`;
    const zl = this.root.querySelector(".pj-zl");
    if (zl) zl.textContent = Math.round(v.z * 100) + "%";
  }

  saveView() {
    try {
      localStorage.setItem("fw-proj-view", JSON.stringify(this.views));
      localStorage.setItem("fw-proj-pos", JSON.stringify(this.pos));
    } catch (e) {}
  }

  setZoom(z, at) {
    const v = this.view, r = this.treeBox.getBoundingClientRect();
    z = Math.min(2.5, Math.max(0.25, z));
    const px = at ? at.clientX - r.left : r.width / 2, py = at ? at.clientY - r.top : r.height / 2;
    v.x = px - (px - v.x) / v.z * z;   // the point under the pointer stays put
    v.y = py - (py - v.y) / v.z * z;
    v.z = z;
    this.applyView();
    this.saveView();
  }

  fitZoom() {
    const b = this.bounds();
    if (!b) return;
    const r = this.treeBox.getBoundingClientRect(), v = this.view;
    v.z = Math.min(1.4, Math.max(0.25, Math.min((r.width - 56) / (b.x2 - b.x1), (r.height - 56) / (b.y2 - b.y1))));
    v.x = (r.width - (b.x2 - b.x1) * v.z) / 2 - b.x1 * v.z;
    v.y = Math.max(24, (r.height - (b.y2 - b.y1) * v.z) / 2) - b.y1 * v.z;
    this.applyView();
    this.saveView();
  }

  firstView() {   // first look at a project: everything if it fits at a readable size, else the project in the middle
    const b = this.bounds(), r = this.treeBox.getBoundingClientRect(), v = this.view;
    if (!b || !r.width) return;
    const fit = Math.min((r.width - 56) / (b.x2 - b.x1), (r.height - 56) / (b.y2 - b.y1));
    v.z = Math.min(1, Math.max(0.72, fit));
    const p = this.at(this.T.items[0]), cx = fit >= 0.72 ? (b.x1 + b.x2) / 2 : p.x + p.w / 2, cy = fit >= 0.72 ? (b.y1 + b.y2) / 2 : p.y + p.h / 2;
    v.x = r.width / 2 - cx * v.z;
    v.y = r.height / 2 - cy * v.z;
    this.applyView();
  }

  bounds() {
    const items = this.T?.items;
    if (!items?.length) return null;
    const boxes = items.map(it => this.at(it));
    return { x1: Math.min(...boxes.map(b => b.x)), y1: Math.min(...boxes.map(b => b.y)),
             x2: Math.max(...boxes.map(b => b.x + b.w)), y2: Math.max(...boxes.map(b => b.y + b.h)) };
  }

  // where a node is: its place in the tree, moved by its own drag and by its parent's (a session takes its tasks along)
  at(it) {
    const pos = this.pos[this.cur] || {};
    let x = it.x, y = it.y;
    for (let k = it.key, n = 0; k && n < 4; k = this.carryOf?.get(k), n++) { const o = pos[k] || [0, 0]; x += o[0]; y += o[1]; }
    return { x, y, w: it.w, h: it.h };
  }

  rootOf(key) {   // the group a box moves with: its theme, else its session, else itself
    for (let n = 0; this.carryOf?.get(key) && n < 4; n++) key = this.carryOf.get(key);
    return key;
  }

  bindCanvas() {
    const box = this.treeBox;
    box.addEventListener("wheel", e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {   // a trackpad pinch arrives as ctrl + wheel with small steps
        this.setZoom(this.view.z * Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 30 ? 0.012 : 0.0018)), e);
      } else {
        this.view.x -= e.deltaX;
        this.view.y -= e.deltaY;
        this.applyView();
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.saveView(), 300);
      }
    }, { passive: false });
    box.addEventListener("pointerdown", e => {
      if (e.button !== 0 || e.target.closest(".chev, button, .pj-find")) return;
      const nd = e.target.closest(".nd[data-key]");
      const pos = this.pos[this.cur] ||= {};
      this.drag = nd ? { key: nd.dataset.key, sx: e.clientX, sy: e.clientY, o: [...(pos[nd.dataset.key] || [0, 0])], moved: false }
                     : { pan: true, sx: e.clientX, sy: e.clientY, o: [this.view.x, this.view.y], moved: false };
    });
    addEventListener("pointermove", e => {
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      box.classList.add(d.pan ? "grabbing" : "moving");
      if (d.pan) {
        this.view.x = d.o[0] + dx;
        this.view.y = d.o[1] + dy;
        this.applyView();
      } else {
        this.pos[this.cur][d.key] = [d.o[0] + dx / this.view.z, d.o[1] + dy / this.view.z];
        if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = null; this.renderTree(false); });
      }
    });
    addEventListener("pointerup", () => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      box.classList.remove("grabbing", "moving");
      if (d.moved) {
        this.dragged = true;
        if (!d.pan) this.resolve(this.rootOf(d.key), true);
        this.saveView();
      }
    });
  }

  // ── the session ontology ──────────────────────────────────────────────
  isOpen(id, live) { return this.toggled.has(id) ? this.toggled.get(id) : live; }

  // causal placement of a session's steps: a step's column is the longest chain of steps it waits for, so what runs
  // in parallel stacks in one column; columns wrap into lines of G.PER and read like text, away from the session
  flowGrid(steps, G) {
    const n = steps.length, dep = steps.map((x, i) => [...new Set((x.deps || []).filter(d => d >= 0 && d < n && d !== i))]);
    const memo = new Map(), up = i => {   // everything step i waits for, directly or not
      if (memo.has(i)) return memo.get(i);
      const s = new Set();
      memo.set(i, s);   // set first: a cycle stops here
      for (const d of dep[i]) { s.add(d); for (const e of up(d)) s.add(e); }
      return s;
    };
    const deps = dep.map(ds => ds.filter(d => !ds.some(e => e !== d && up(e).has(d))));   // a link a longer path already implies
    const rank = [], seen = new Set(), rk = i => {
      if (rank[i] != null) return rank[i];
      if (seen.has(i)) return 0;
      seen.add(i);
      return (rank[i] = deps[i].length ? 1 + Math.max(...deps[i].map(rk)) : 0);
    };
    steps.forEach((_, i) => rk(i));
    const byRank = [];
    steps.forEach((_, i) => (byRank[rank[i]] ||= []).push(i));
    const pos = [], lineY = [];
    let y = 0;
    for (let l = 0; l * G.PER < byRank.length; l++) {
      const ranks = byRank.slice(l * G.PER, (l + 1) * G.PER);
      ranks.forEach((ids, c) => (ids || []).forEach((i, row) => { pos[i] = { line: l, col: c, row }; }));
      lineY.push(y);
      y += (Math.max(1, ...ranks.map(r => r?.length || 0)) - 1) * G.TP + G.TH + G.LG;
    }
    const cols = Math.min(G.PER, byRank.length);
    return { deps, pos, lineY, w: G.SW + (n ? G.GAP2 + cols * G.TW + (cols - 1) * G.CG : 0),
             h: n ? Math.max(G.SH, (G.SH - G.TH) / 2 + y - G.LG) : G.SH };
  }

  treeLayout(M) {
    // a mind map: the project in the middle, sessions to its right and left (whichever side is shorter), each
    // session's steps flowing outward from it in the order they depend on each other
    const G = { PW: 210, PH: 70, SW: 276, SH: 58, TW: 224, TH: 30, TP: 38, CG: 40, GAP1: 70, GAP2: 44, VG: 22, ROWS: 6, PER: 3, LG: 26,
                HW: 196, HH: 48, GAPH: 56, HG: 34 };
    const rank = a => ({ busy: 0, waiting: 1, idle: 2 })[a.s.status] ?? 3;
    const sessions = [...M.sessions].sort((a, b) => rank(a) - rank(b) || lastAct(b) - lastAct(a));
    const size = (n, h0) => {
      const cols = Math.ceil(n / G.ROWS), rows = Math.min(n, G.ROWS);
      return { cols, rows, w: G.SW + (n ? G.GAP2 + cols * G.TW + (cols - 1) * G.CG : 0),
               h: Math.max(h0, rows ? (h0 - G.TH) / 2 + (rows - 1) * G.TP + G.TH : h0) };
    };
    const blocks = [];
    for (const a of sessions) {
      const live = a.s.status !== "ended", open = this.isOpen(a.id, live), F = this.flowOf(a, M);
      let steps = open ? F.steps : [];
      if (steps.length > 24) steps = [...steps.slice(0, 23), { title: `그 외 ${steps.length - 23}단계`, state: "more", deps: [22] }];
      blocks.push({ kind: "session", a, F, steps, open, n: F.steps.length, h0: G.SH, ...this.flowGrid(steps, G) });
    }
    if (M.reports.length) {
      const open = this.isOpen("reports", false), reps = open ? M.reports.slice(0, 12) : [];
      blocks.push({ kind: "group", reps, open, n: M.reports.length, h0: 48, ...size(reps.length, 48) });
    }
    // with themes: one unit per theme (its sessions stacked beside it); without: one unit per session as before
    const themed = M.sessions.some(a => a.theme);
    const units = [];
    if (themed) {
      const byTheme = new Map();
      for (const b of blocks) if (b.kind === "session") {
        const t = b.a.theme || "분류 전";
        if (!byTheme.has(t)) byTheme.set(t, []);
        byTheme.get(t).push(b);
      }
      const live = list => list.filter(b => b.a.s.status === "busy" || b.a.s.status === "waiting").length;
      for (const [name, list] of [...byTheme].sort((x, y) => (x[0] === "분류 전") - (y[0] === "분류 전") || live(y[1]) - live(x[1]) || y[1].length - x[1].length))
        units.push({ theme: name, list, h: list.reduce((h, b) => h + b.h + G.VG, -G.VG) });
      for (const b of blocks) if (b.kind === "group") units.push({ theme: null, list: [b], h: b.h });
    } else for (const b of blocks) units.push({ theme: null, list: [b], h: b.h });
    const side = { right: [], left: [] }, height = { right: 0, left: 0 };
    for (const u of units) {
      const s = height.right <= height.left ? "right" : "left";
      side[s].push(u);
      height[s] += u.h + (u.theme ? G.HG : G.VG);
    }
    const shift = themed ? G.HW + G.GAPH : 0;   // sessions move one column out to make room for the theme
    const themes = [];
    for (const s of ["right", "left"]) {
      let y = -(height[s] - G.VG) / 2;
      for (const u of side[s]) {
        const y0 = y;
        if (u.theme) themes.push({ name: u.theme, side: s, list: u.list,
          x: s === "right" ? G.PW + G.GAP1 : -G.GAP1 - G.HW, y: y0 + Math.min(u.h, 400) / 2 - G.HH / 2 });
        for (const b of u.list) {
        b.side = s;
        b.y = y;
        b.theme = u.theme;
        b.sx = b.kind === "group" ? (s === "right" ? G.PW + G.GAP1 : -G.GAP1 - G.SW)
          : s === "right" ? G.PW + G.GAP1 + shift : -G.GAP1 - shift - G.SW;   // the session box
        b.tx = c => s === "right" ? b.sx + G.SW + G.GAP2 + c * (G.TW + G.CG) : b.sx - G.GAP2 - G.TW - c * (G.TW + G.CG);
        b.ty = r => b.y + (b.h0 - G.TH) / 2 + r * G.TP;
        b.cell = b.kind === "session" ? i => [b.tx(b.pos[i].col), b.ty(b.pos[i].row) + b.lineY[b.pos[i].line]]
          : i => [b.tx(Math.floor(i / G.ROWS)), b.ty(i % G.ROWS)];
        y += b.h + G.VG;
        }
        if (u.theme) y += G.HG - G.VG;
      }
    }
    return { G, blocks, themes };
  }

  // the map as placed items (nodes) and links between them; drawn by renderTree, again on every drag
  drawTree(M, force) {
    const L = this.layout = this.treeLayout(M), { G } = L;
    const just = new Map();
    for (const b of L.blocks) if (b.kind === "session" && b.a.s.g) {
      const prev = this.prevDone.get(b.a.id), done = b.a.s.g.done;
      if (prev != null && done > prev) just.set(b.a.id, prev);
      this.prevDone.set(b.a.id, done);
    }
    const sw = this.root.querySelector(".pj-ended");
    sw.textContent = `꺼진 세션 ${M.endedN}개`;
    sw.setAttribute("aria-pressed", String(this.showEnded));
    sw.disabled = !M.endedN && !this.showEnded;
    const sig = JSON.stringify([this.findQ, this.showEnded, this.cur, L.blocks.map(b => b.kind === "group" ? ["g", b.open, b.n] : [b.a.id, b.a.s.status, b.open, b.steps.map(s => s.state), b.a.label, b.a.hidden, b.theme]), [...just], this.sel, M.hiddenN, this.showHidden]);
    if (!force && sig === this.svg.dataset.sig) return;
    this.svg.dataset.sig = sig;
    const items = [], links = [];
    const run = M.sessions.filter(a => a.s.status === "busy").length, wait = M.sessions.filter(a => a.s.status === "waiting").length;
    items.push({ key: "p", col: 0, x: 0, y: -G.PH / 2, w: G.PW, h: G.PH, draw: (x, y) => this.node({ x, y, w: G.PW, h: G.PH, icon: "project", cls: "project", key: "p",
      attrs: `data-sel=""`, title: M.p.name, sub: run || wait ? [run && `실행 중 ${run}`, wait && `입력 대기 ${wait}`].filter(Boolean).join(" · ") : `세션 ${M.sessions.length}`,
      sub2: M.p.other ? "어느 프로젝트 폴더에도 없는 세션" : `데이터 ${M.cats.length}종 · 보고서 ${M.reports.length}` }) });
    for (const t of L.themes) {
      const key = "th:" + t.name, run = t.list.filter(b => b.a.s.status === "busy").length, wait = t.list.filter(b => b.a.s.status === "waiting").length;
      items.push({ key, col: 1, x: t.x, y: t.y, w: G.HW, h: G.HH, draw: (x, y) => this.node({ x, y, w: G.HW, h: G.HH, icon: "theme",
        cls: `theme${t.name === "분류 전" ? " unsorted" : ""}${run ? " t-run" : wait ? " t-wait" : ""}`, key, attrs: `data-theme="${esc(t.name)}"`, title: t.name,
        sub: [`세션 ${t.list.length}`, run && `실행 중 ${run}`, wait && `입력 대기 ${wait}`].filter(Boolean).join(" · ") }) });
      links.push({ from: "p", to: key, cls: run ? "run" : wait ? "wait" : t.list.some(b => b.a.s.status !== "ended") ? "idle" : "ended" });
    }
    for (const b of L.blocks) {
      const cell = b.cell;
      if (b.kind === "group") {
        items.push({ key: "reports", col: 1, x: b.sx, y: b.y, w: G.SW, h: 48, draw: (x, y) => this.node({ x, y, w: G.SW, h: 48, icon: "group", cls: "group", key: "reports",
          attrs: `data-toggle="reports"`, title: "지난 분석 보고서", sub: `${b.n}개 · 최근 ${M.reports[0]?.r.date.slice(5).replace("-", ".")}`, chevron: b.open }) });
        links.push({ from: "p", to: "reports", cls: "ended" });
        b.reps.forEach((a, i) => {
          const key = "rep:" + a.id, [x, y] = cell(i);
          items.push({ key, carry: "reports", col: 2, x, y, w: G.TW, h: G.TH, draw: (x0, y0) => this.node({ x: x0, y: y0, w: G.TW, h: G.TH,
            icon: "report", cls: `task report${this.sel === a.id ? " sel" : ""}${a.hidden ? " hid" : ""}`, key, attrs: `data-sel="${esc(a.id)}"`, title: a.label,
            sub: a.r.date.slice(5).replace("-", "."), small: true }) });
          links.push({ from: "reports", to: key, cls: "done" });
        });
        continue;
      }
      const a = b.a, s = a.s, g = s.g, F = b.F, st = s.status;
      const prog = g && g.total ? g.done / g.total : null;
      const tasks = F.steps.filter(x => !x.agent), doneN = tasks.filter(x => x.state === "done").length;
      const sub = [STATUS_KO[st], a.host,
        g ? `${g.done}/${g.total} 단계` : F.stepKind === "todo" ? `할 일 ${doneN}/${tasks.length}` : F.stepKind === "ask" ? `요청 ${tasks.length}개` : tasks.length ? `스크립트 ${tasks.length}` : "기록 없음",
        st === "ended" ? ago(lastAct(a) / 1000) : "",
        s.planTitle ? `지금: ${s.planTitle}` : M.p.other ? normp(s.cwd).split("/").pop() : null].filter(Boolean).join(" · ");
      items.push({ key: a.id, carry: b.theme ? "th:" + b.theme : undefined, col: 1, x: b.sx, y: b.y, w: G.SW, h: G.SH, draw: (x, y) => this.node({ x, y, w: G.SW, h: G.SH, icon: "session",
        cls: `session s-${st}${this.sel === a.id ? " sel" : ""}${a.hidden ? " hid" : ""}`, key: a.id, attrs: `data-sel="${esc(a.id)}"`, title: a.label, sub, progress: prog,
        chevron: b.n ? b.open : null, toggle: a.id }) });
      links.push({ from: b.theme ? "th:" + b.theme : "p", to: a.id, cls: { busy: "run", waiting: "wait", idle: "idle", ended: "ended" }[st] });
      b.steps.forEach((x, i) => {
        const key = a.id + "#" + i, k = x.state === "now" ? (st === "busy" ? "run" : st === "waiting" ? "wait" : "now") : x.state === "blocked" ? "wait" : x.state;
        const since = x.state === "now" && x.since && st !== "ended" ? dur(Date.now() - x.since) : "";
        const [tx, ty] = cell(i);
        items.push({ key, carry: a.id, col: 2, x: tx, y: ty, w: G.TW, h: G.TH, draw: (x0, y0) => this.stepNode({ x: x0, y: y0, w: G.TW, h: G.TH,
          st: k, title: x.title, n: x.n, outs: x.outs, since, stamp: just.has(a.id) && i >= just.get(a.id) && x.state === "done", key,
          attrs: `data-sel="${esc(a.id)}"${x.id ? ` data-step="${esc(x.id)}"` : ""}` }) });
        // a step hangs off the steps it waits for (the session itself for a first step); the link takes the state of
        // the step it leads into, so the solid part of the chain is what is done and the moving dash is what runs now
        const cls = k === "side" ? "now" : k === "more" ? "left" : k;
        if (!b.deps[i].length) links.push({ from: a.id, to: key, cls });
        for (const d of b.deps[i]) links.push({ from: a.id + "#" + d, to: key, cls,
          flow: { s: b.side === "right" ? 1 : -1, gap: -(b.pos[i].row * G.TP) - G.LG / 2 } });
      });
    }
    this.T = { items, links, empty: !M.sessions.length && !M.reports.length };
    this.carryOf = new Map(items.filter(it => it.carry).map(it => [it.key, it.carry]));
    this.resolve(null, false);   // places the user moved earlier may now overlap a session that grew
    const fresh = !this.views[this.cur];
    this.renderTree(!this.drawn.has(this.cur) && !reduced());
    if (fresh) requestAnimationFrame(() => this.firstView());
  }

  // movable groups: a session with its tasks, the reports with their list, the project
  blocks() {
    const roots = new Map();
    for (const it of this.T.items) {
      const root = this.rootOf(it.key);
      if (!roots.has(root)) roots.set(root, []);
      roots.get(root).push(this.at(it));
    }
    return [...roots].map(([root, bs]) => ({ root, x1: Math.min(...bs.map(b => b.x)), y1: Math.min(...bs.map(b => b.y)),
      x2: Math.max(...bs.map(b => b.x + b.w)), y2: Math.max(...bs.map(b => b.y + b.h)) }));
  }

  // push overlapping groups apart the shorter way out, never moving `fixed` (the group just dropped)
  resolve(fixed, animate) {
    const pos = this.pos[this.cur] ||= {}, before = JSON.parse(JSON.stringify(pos)), PAD = 18;
    let changed = false;
    for (let round = 0; round < 200; round++) {
      const B = this.blocks();
      let hit = null;
      for (let i = 0; i < B.length && !hit; i++) for (let j = i + 1; j < B.length && !hit; j++) {
        const a = B[i], b = B[j];
        const ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) + PAD, oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) + PAD;
        if (ox > 0 && oy > 0) hit = [a, b, ox, oy];
      }
      if (!hit) break;
      const [a, b, ox, oy] = hit;
      const mover = b.root === fixed || (b.root === "p" && a.root !== fixed) ? a : b, other = mover === a ? b : a;
      const mid = (lo, hi) => (lo + hi) / 2;
      const o = pos[mover.root] || [0, 0];
      pos[mover.root] = oy <= ox * 1.4
        ? [o[0], o[1] + (mid(mover.y1, mover.y2) >= mid(other.y1, other.y2) ? oy : -oy)]
        : [o[0] + (mid(mover.x1, mover.x2) >= mid(other.x1, other.x2) ? ox : -ox), o[1]];
      changed = true;
    }
    if (!changed || !animate || reduced()) return changed;
    // ease the pushed groups from where they were to where they now go
    const after = JSON.parse(JSON.stringify(pos)), t0 = performance.now(), D = 240;
    const step = now => {
      const k = Math.min(1, (now - t0) / D), e = 1 - (1 - k) ** 3;
      for (const key of Object.keys(after)) {
        const a = before[key] || [0, 0], b = after[key];
        pos[key] = [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e];
      }
      this.renderTree(false);
      if (k < 1) requestAnimationFrame(step); else this.saveView();
    };
    requestAnimationFrame(step);
    return changed;
  }

  renderTree(first) {
    const { items, links, empty } = this.T, byKey = new Map(items.map(it => [it.key, this.at(it)]));
    let edges = "", hot = "";
    for (const l of links) {
      const a = byKey.get(l.from), b = byKey.get(l.to);
      if (!a || !b) continue;
      const ay = a.y + Math.min(a.h, 58) / 2, by = b.y + b.h / 2;
      let d, head = "";
      if (l.flow) {   // step to step, pointing outward; to a step on the next line it runs back along the gap above that line
        const s = l.flow.s, out = s > 0 ? a.x + a.w : a.x, inn = s > 0 ? b.x : b.x + b.w;
        d = (inn - out) * s >= 24 ? elbow(out, ay, inn - s * Math.min(16, Math.abs(inn - out) / 2), inn, by)
          : route([[out, ay], [out + s * 12, ay], [out + s * 12, b.y + l.flow.gap], [inn - s * 14, b.y + l.flow.gap], [inn - s * 14, by], [inn, by]]);
        head = `<path class="edge ah ${l.cls}" d="M${f1(inn - s * 6)} ${f1(by - 4)} L${f1(inn)} ${f1(by)} L${f1(inn - s * 6)} ${f1(by + 4)}"/>`;
      } else if (b.x >= a.x + a.w + 20) d = elbow(a.x + a.w, ay, a.x + a.w + Math.min(30, (b.x - a.x - a.w) / 2), b.x, by);   // child to the right
      else if (b.x + b.w <= a.x - 20) d = elbow(a.x, ay, a.x - Math.min(30, (a.x - b.x - b.w) / 2), b.x + b.w, by);  // child to the left
      else {   // moved above or below its parent: a soft vertical curve
        const down = by > ay, y1 = down ? a.y + a.h : a.y, y2 = down ? b.y : b.y + b.h, ax = a.x + a.w / 2, bx = b.x + b.w / 2;
        d = `M${f1(ax)} ${f1(y1)} C${f1(ax)} ${f1((y1 + y2) / 2)} ${f1(bx)} ${f1((y1 + y2) / 2)} ${f1(bx)} ${f1(y2)}`;
      }
      const p = `<path class="edge ${l.cls}" d="${d}"/>${head}`;
      if (l.cls === "run" || l.cls === "wait") hot += p; else edges += p;
    }
    const cols = [0, 1, 2].map(c => items.filter(it => it.col === c).map(it => { const b = byKey.get(it.key); return it.draw(b.x, b.y); }).join(""));
    const fade = c => first ? ` class="col" style="animation-delay:${c * 110}ms"` : "";
    this.svg.innerHTML = `<g class="vp"><g class="edges${first ? " enter" : ""}">${edges}</g><g class="edges hot${first ? " enter" : ""}">${hot}</g>
      ${cols.map((html, c) => `<g${fade(c)}>${html}</g>`).join("")}
      ${empty ? `<text x="260" y="5" class="t-sub">${this.findQ ? "찾는 세션이 없습니다" : this.M?.endedN && !this.showEnded
        ? `지금 떠 있는 세션이 없습니다 · 왼쪽 위 '꺼진 세션 ${this.M.endedN}개' 로 지난 세션을 볼 수 있습니다` : "이 프로젝트 폴더에서 돌아가는 세션도, 보고서도 아직 없습니다"}</text>` : ""}</g>`;
    this.svg.setAttribute("aria-label", `${this.M?.p.name || ""} 세션 온톨로지`);
    this.applyView();
  }

  node({ x, y, w, h, icon, cls, attrs, key, title, sub, sub2, progress, chevron, toggle, small }) {
    const ic = small ? 20 : 26, ix = x + (small ? 6 : 9), iy = y + (small ? (h - ic) / 2 : 10), tx = ix + ic + (small ? 8 : 10);
    const room = x + w - tx - (chevron != null ? 30 : 10) - (small && sub ? textW(sub, 11) + 12 : 0);
    const ty = small ? y + h / 2 + 4.5 : y + (sub2 ? 22 : sub ? h / 2 - 3 : h / 2 + 4.5);
    const full = `data-tt="${esc(title)}" data-tx="${f1(tx - x)}"${sub ? ` data-ts="${esc(sub)}"` : ""}${sub2 ? ` data-ts2="${esc(sub2)}"` : ""} aria-label="${esc(title)}"`;
    return `<g class="nd ${cls}" ${attrs}${key ? ` data-key="${esc(key)}"` : ""} ${full} tabindex="0"><rect class="box" x="${f1(x)}" y="${f1(y)}" width="${w}" height="${h}" rx="${small ? 5 : 7}"/>
      <rect class="ic" x="${ix}" y="${f1(iy)}" width="${ic}" height="${ic}" rx="${small ? 4 : 6}"/>
      <path class="icp" d="${ICON[icon]}" transform="translate(${f1(ix + (ic - 16) / 2)} ${f1(iy + (ic - 16) / 2)})"/>
      <text class="nt${small ? " sm" : ""}" x="${f1(tx)}" y="${f1(ty)}">${esc(fit(title, room, small ? 12.5 : 13))}</text>
      ${sub && !small ? `<text class="ns" x="${f1(tx)}" y="${f1(ty + 16)}">${esc(fit(sub, room + 20, 11))}</text>` : ""}
      ${sub2 ? `<text class="ns" x="${f1(tx)}" y="${f1(ty + 31)}">${esc(fit(sub2, room + 20, 11))}</text>` : ""}
      ${sub && small ? `<text class="ns end" x="${x + w - 9}" y="${f1(y + h / 2 + 4)}">${esc(sub)}</text>` : ""}
      ${progress != null ? `<rect class="pbar" x="${f1(tx)}" y="${f1(y + h - 7)}" width="${f1(x + w - tx - 12)}" height="2.5" rx="1.2"/><rect class="pfill" x="${f1(tx)}" y="${f1(y + h - 7)}" width="${f1((x + w - tx - 12) * progress)}" height="2.5" rx="1.2"/>` : ""}
      ${chevron != null ? `<g class="chev" data-toggle="${esc(toggle || "reports")}"><rect x="${x + w - 26}" y="${f1(y + h / 2 - 10)}" width="20" height="20" rx="4"/><path d="${chevron ? `M${x + w - 20} ${f1(y + h / 2 - 2)}l4 4 4-4` : `M${x + w - 18} ${f1(y + h / 2 - 4)}l4 4-4 4`}"/></g>` : ""}</g>`;
  }

  stepNode({ x, y, w, h, st, title, n, outs, since, stamp, key, attrs }) {
    const cx = x + 15, cy = y + h / 2;
    const mark = st === "done" ? `<circle class="sm-dot" cx="${cx}" cy="${cy}" r="6.5"/><path class="sm-tick${stamp ? " stamp" : ""}" d="M${cx - 3} ${cy} l2.2 2.2 l3.8 -4.3"/>`
      : st === "run" ? `<circle class="sm-ring" cx="${cx}" cy="${cy}" r="6.5"/><path class="sm-spin" d="${arc(cx, cy, 6.5, -90, 40)}" style="transform-origin:${cx}px ${f1(cy)}px"/>`
      : st === "wait" ? `<circle class="sm-wait" cx="${cx}" cy="${cy}" r="6.5"/><path class="sm-bang" d="M${cx} ${cy - 3.2}v3.4M${cx} ${cy + 2.6}v.2"/>`
      : st === "now" ? `<circle class="sm-ring now" cx="${cx}" cy="${cy}" r="6.5"/><circle class="sm-core" cx="${cx}" cy="${cy}" r="2.6"/>`
      : st === "more" ? `<path class="sm-more" d="M${cx - 5} ${cy}h.1M${cx} ${cy}h.1M${cx + 5} ${cy}h.1"/>` : `<circle class="sm-left" cx="${cx}" cy="${cy}" r="6.5"/>`;
    const right = since ? since : n ? `${n}개` : outs ? `산출물 ${outs}` : "";
    const room = w - 38 - (right ? textW(right, 11) + 14 : 8);
    return `<g class="nd task t-${st}" ${attrs}${key ? ` data-key="${esc(key)}"` : ""} data-tt="${esc(title)}" data-tx="30" aria-label="${esc(title)}" tabindex="0"><rect class="box" x="${f1(x)}" y="${f1(y)}" width="${w}" height="${h}" rx="5"/>${mark}
      <text class="nt sm" x="${x + 30}" y="${f1(cy + 4.5)}">${esc(fit(title, room, 12.5))}</text>
      ${right ? `<text class="ns end" x="${x + w - 9}" y="${f1(cy + 4)}">${esc(right)}</text>` : ""}</g>`;
  }

  // ── the data catalog ──────────────────────────────────────────────────
  catalog(M) {
    const users = new Map(M.cats.map(c => [c.key, [...M.sessions, ...M.reports].filter(a => a.cats.includes(c.key))]));
    const groups = new Map([...MODALITY, ETC].map(([k, label]) => [k, { k, label, list: [] }]));
    for (const c of M.cats) groups.get(modalityOf(c)[0]).list.push(c);
    const out = [...groups.values()].filter(g => g.list.length);
    for (const g of out) {
      g.list.sort((a, b) => b.bytes - a.bytes);
      g.bytes = g.list.reduce((s, c) => s + c.bytes, 0);
      g.users = new Set(g.list.flatMap(c => users.get(c.key).map(a => a.id))).size;
    }
    return { groups: out, users };
  }

  drawCatalog(M) {
    const { groups, users } = this.catalog(M), max = Math.max(1, ...M.cats.map(c => c.bytes)), total = M.totals.bytes || 1;
    const row = c => {
      const [sk, sl] = stageOf(c), u = users.get(c.key), open = this.dsOpen === c.key;
      const exts = Object.entries(c.exts).sort((a, b) => b[1] - a[1]).slice(0, 3);
      return `<div class="dc-row${open ? " open" : ""}${u.length ? "" : " unused"}"><button class="dc-main" data-ds="${esc(c.key)}" aria-expanded="${open}">
          <span class="dc-name">${esc(c.name)}<span class="dc-hosts">${[...new Set(c.parts.map(p => p.host))].map(h => `<i>${esc(h)}</i>`).join("")}</span></span>
          <span class="dc-stage ${sk}">${sl}</span>
          <span class="dc-fmt">${exts.map(([e, n]) => `${esc(e)} <b>${count(n)}</b>`).join(" · ") || "-"}</span>
          <span class="dc-smp num">${c.samples ? "약 " + count(c.samples) : "-"}</span>
          <span class="dc-size num">${bytes(c.bytes)}${c.partial ? "+" : ""}<i style="width:${Math.max(2, 100 * c.bytes / max).toFixed(1)}%"></i></span>
          <span class="dc-age">${c.newest ? ago(c.newest) : "-"}</span>
          <span class="dc-use${u.length ? "" : " none"}">${u.length ? `분석 ${u.length}` : "안 씀"}</span></button>
        ${open ? `<div class="dc-detail">${c.note ? `<p class="note">${esc(c.note)}</p>` : ""}
          <div class="dc-cols"><div><h4>파일 형태</h4>${Object.entries(c.kinds).sort((a, b) => b[1][1] - a[1][1]).map(([k, [n, b]]) =>
            `<div class="dc-kind"><span>${KIND_KO[k] || k}</span><b class="num">${count(n)}개 · ${bytes(b)}</b></div>`).join("") || "<p class='hint'>파일 없음</p>"}
            ${c.partial ? `<p class="warn">파일이 많아 일부만 셌습니다 (+ 는 그보다 많다는 뜻)</p>` : ""}</div>
          <div><h4>위치</h4>${c.parts.map(p => `<div class="dc-path"><i>${esc(p.host)}</i><code>${esc(p.path)}</code><span class="num">${bytes(p.bytes)}</span></div>`).join("")}</div>
          <div><h4>이 데이터를 쓴 분석 <b class="num">${u.length}</b></h4>${u.length ? u.slice(0, 8).map(a => `<button class="dc-an" data-pick="${esc(a.id)}">
            <i class="dot ${a.kind === "session" ? a.s.status : "rep"}"></i><span>${esc(a.label)}</span><small>${a.exact ? "" : "추정"}</small></button>`).join("") : `<p class="hint">아직 이 데이터를 쓴 분석이 없습니다</p>`}</div></div></div>` : ""}</div>`;
    };
    const html = `<div class="dc-sum"><div class="dc-total"><b class="num">${bytes(M.totals.bytes)}</b><span>데이터 ${M.cats.length}종 · 파일 ${count(M.totals.files)}개</span></div>
        <div class="dc-bar">${groups.map(g => `<i class="m-${g.k}" style="flex:${Math.max(0.6, 100 * g.bytes / total).toFixed(2)}" title="${esc(g.label)} ${bytes(g.bytes)}"></i>`).join("")}</div>
        <div class="dc-chips">${groups.map(g => `<button class="dc-chip" data-jump="${g.k}"><i class="m-${g.k}"></i>${esc(g.label)}<b class="num">${bytes(g.bytes)}</b></button>`).join("")}</div></div>
      ${M.cats.length ? `<div class="dc-head"><span>데이터</span><span>단계</span><span>주요 형식</span><span>샘플</span><span>크기</span><span>변경</span><span>쓰는 분석</span></div>` : ""}
      ${groups.map(g => `<section class="dc-group" id="dc-${g.k}"><h3><i class="m-${g.k}"></i>${esc(g.label)}<span class="num">${g.list.length}종 · ${bytes(g.bytes)}${g.users ? ` · 분석 ${g.users}개가 씀` : ""}</span></h3>
        ${g.list.map(row).join("")}</section>`).join("")}
      ${M.cats.length ? "" : `<p class="hint">${M.scans.some(s => s.error && !s.t) ? "서버에 연결되지 않아 데이터 폴더를 아직 읽지 못했습니다" : "데이터 폴더를 찾지 못했습니다. config.ini 의 이 프로젝트 섹션에 data = 00_raw_data, 02_data 처럼 지정할 수 있습니다"}</p>`}`;
    if (this.cat.dataset.h !== html) { this.cat.innerHTML = html; this.cat.dataset.h = html; }
  }

  // ── right-hand panel ──────────────────────────────────────────────────
  paintInsp(M) {
    const a = this.sel && [...M.sessions, ...M.reports].find(x => x.id === this.sel);
    if (this.sel && !a) this.sel = null;
    const html = a ? this.analysisHtml(a, M) : this.projectHtml(M);
    if (this.insp.dataset.h !== html) {
      const fresh = this.insp.dataset.who !== (this.sel || this.cur);
      this.insp.innerHTML = html;
      this.insp.dataset.h = html;
      this.insp.dataset.who = this.sel || this.cur;
      if (fresh) this.insp.scrollTop = 0;
    }
  }

  projectHtml(M) {
    const live = M.sessions.filter(a => a.s.status !== "ended");
    const { groups } = this.catalog(M), max = Math.max(1, ...groups.map(g => g.bytes));
    if (M.p.other) return `<div class="ik">모음</div><h2>${esc(M.p.name)}</h2>
      <p class="hint">config.ini 의 어느 프로젝트 폴더에도 들어 있지 않은 세션입니다. 자주 쓰는 폴더라면 <code>[project:<이름>]</code> 에 넣어 프로젝트로 묶을 수 있습니다.</p>
      <h3>지금 열린 세션 <b class="num">${live.length}</b></h3>
      ${live.length ? `<div class="ilist">${live.map(a => `<button class="irow" data-pick="${esc(a.id)}"><i class="dot ${a.s.status}"></i><span>${esc(a.label)}</span><small>${esc(normp(a.s.cwd).split("/").pop())}</small></button>`).join("")}</div>`
        : `<p class="hint">돌아가는 세션이 없습니다</p>`}`;
    return `<div class="ik">프로젝트</div><h2>${esc(M.p.name)}</h2>
      <h3>지금 열린 세션 <b class="num">${live.length}</b></h3>
      ${live.length ? `<div class="ilist">${live.map(a => `<button class="irow" data-pick="${esc(a.id)}"><i class="dot ${a.s.status}"></i><span>${esc(a.label)}</span><small>${STATUS_KO[a.s.status]}</small></button>`).join("")}</div>`
        : `<p class="hint">돌아가는 세션이 없습니다</p>`}
      <h3>데이터 <b class="num">${M.cats.length}종 · ${bytes(M.totals.bytes)}</b></h3>
      ${groups.length ? `<div class="mlist">${groups.map(g => `<button class="mrow" data-jump="${g.k}"><span><i class="m-${g.k}"></i>${esc(g.label)}</span><b class="num">${bytes(g.bytes)}</b>
        <span class="bar"><i class="m-${g.k}" style="width:${Math.max(2, 100 * g.bytes / max).toFixed(1)}%"></i></span></button>`).join("")}</div>` : `<p class="hint">아직 읽은 데이터가 없습니다</p>`}
      ${M.findings.length ? `<h3>최근 발견</h3><ul class="finds">${M.findings.slice(0, 4).map(f => `<li><time class="num">${esc(f.date.slice(5).replace("-", "."))}</time><span>${esc(f.text)}${f.tag ? `<em class="tag">${esc(f.tag)}</em>` : ""}</span></li>`).join("")}</ul>` : ""}
      ${M.backlog.length ? `<h3>다음 후보 <small>백로그</small></h3><ul class="ideas">${M.backlog.slice(0, 5).map(b => `<li>${esc(b.text)}</li>`).join("")}</ul>` : ""}`;
  }

  // the data an analysis reads, flowing into it, and what it has made so far
  lineage(a, F) {
    const ins = F.inputs.slice(0, 6), more = F.inputs.length - ins.length, run = F.s?.status === "busy";
    const W = 324, dh = 40, n = Math.max(1, ins.length), H = Math.max(96, n * dh + 16 + (more ? 18 : 0));
    const sy = H / 2 - (more ? 9 : 0), sx = 196, top = (H - (more ? 18 : 0)) / 2 - (n - 1) * dh / 2;
    let s = "";
    ins.forEach((d, i) => {
      const y = top + i * dh;
      s += `<path class="edge ${run ? "run" : d.key && a.exact ? "done" : "guess"}" d="${elbow(132, y, 164, sx, sy)}"/>`;
      s += `<g class="nd data${d.key ? "" : " raw"}"${d.key ? ` data-ds="${esc(d.key)}"` : ""}><rect class="box" x="0" y="${f1(y - 16)}" width="132" height="32" rx="5"/>
        <path class="icp" d="${ICON.data}" transform="translate(6 ${f1(y - 8)})"/><text class="nt sm" x="26" y="${f1(y - 2)}">${esc(fit(d.label, 100, 12.5))}</text>
        <text class="ns" x="26" y="${f1(y + 11)}">${esc(fit(d.sub, 100, 11))}</text><title>${esc(d.path || d.label)}</title></g>`;
    });
    if (more) s += `<text class="ns" x="4" y="${H - 4}">그 외 ${more}개</text>`;
    if (!ins.length) s += `<text class="ns" x="0" y="${f1(sy + 4)}">읽은 데이터 기록 없음</text>`;
    const st = F.s ? `s-${F.s.status}` : "report";
    s += `<g class="nd session ${st}"><rect class="box" x="${sx}" y="${f1(sy - 26)}" width="128" height="52" rx="7"/>
      <rect class="ic" x="${sx + 8}" y="${f1(sy - 12)}" width="24" height="24" rx="5"/><path class="icp" d="${ICON[F.s ? "session" : "report"]}" transform="translate(${sx + 12} ${f1(sy - 8)})"/>
      <text class="nt sm" x="${sx + 38}" y="${f1(sy - 3)}">${F.s ? STATUS_KO[F.s.status] : "보고서"}</text><text class="ns" x="${sx + 38}" y="${f1(sy + 12)}">표 ${F.tables} · 그림 ${F.figures}</text></g>`;
    return `<svg class="lineage" viewBox="0 0 ${W} ${f1(H)}" width="100%" role="img" aria-label="읽은 데이터에서 이 분석으로">${s}</svg>`;
  }

  analysisHtml(a, M) {
    const F = this.flowOf(a, M), s = F.s, VK = { 지지: "ok", 기각: "no", 미결: "open", 판정보류: "hold" };
    const where = !s ? "끝난 분석" : STATUS_KO[s.status];
    const src = a.exact ? (a.kind === "session" && a.refs?.length && !a.report?.inputs?.length ? "대화에서 읽은 경로" : "보고서에 적힌 경로") : "제목·단계 이름으로 추정";
    return `<button class="back" data-pick="">← ${esc(M.p.name)}</button><div class="ik">${a.kind === "session" ? "세션" : "보고서"}</div>
      <h2>${esc(a.label)}</h2><div class="who">${esc(where)} · ${esc(a.host)} · ${esc(F.when)}</div>
      <h3>읽은 데이터 <small>${src}</small></h3>${this.lineage(a, F)}
      <button class="primary ghost" data-flow="${esc(a.id)}">흐름 크게 보기</button>
      ${F.why ? `<h3>질문</h3><p class="q">${esc(F.why.replace(/^질문[:：]\s*/, ""))}</p>` : ""}
      ${F.conclusion && F.conclusion !== a.label ? `<h3>결론</h3><p class="concl">${esc(F.conclusion)}</p>` : ""}
      ${F.checks.length ? `<h3>확인과 판정</h3><ul class="vlist">${F.checks.map(x => `<li class="${VK[x.verdict]}"><b>${x.verdict}${x.mixed ? " 외" : ""}</b><span>${esc(x.text)}</span></li>`).join("")}</ul>` : ""}
      ${F.inputs.some(d => d.path) ? `<h3>데이터 경로</h3>${F.inputs.filter(d => d.path).map(d => `<code class="path">${esc(d.path || d.label)}${d.n ? ` <span>· ${d.n}번</span>` : ""}</code>`).join("")}` : ""}
      ${s?.g?.outs.length ? `<h3>산출물</h3><div class="outs compact">${outputsHtml(s)}</div>` : ""}
      ${(F.rep || s?.workDir || s?.cwd) ? `<h3>폴더</h3><code class="path">${esc(F.rep?.path || s.workDir || s.cwd)}</code>` : ""}
      ${s ? `<button class="primary" data-open="${esc(s.key)}">진행 페이지 열기</button>` : ""}`;
  }

  openFlowAt(id, el) {
    if (this.openCat || this.openAn) { this.openCat = this.openAn = null; this.win.innerHTML = ""; }
    this.openAn = id;
    this.win.hidden = false;
    this.scrim.classList.add("on");
    this.drawFlow(true);
    if (el && !reduced()) {
      const a = el.getBoundingClientRect(), b = this.win.getBoundingClientRect();
      this.win.style.transformOrigin = `${a.left + a.width / 2 - b.left}px ${a.top + a.height / 2 - b.top}px`;
      this.win.animate([{ opacity: 0, transform: "scale(.08)" }, { opacity: 1, transform: "scale(1)" }], { duration: 460, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
    this.win.querySelector(".x")?.focus({ preventScroll: true });
    this.opts.onCat?.(id);
  }

  closeCat() {
    if (!this.openCat && !this.openAn) return;
    this.openCat = this.openAn = null;
    this.scrim.classList.remove("on");
    const done = () => { this.win.hidden = true; this.win.innerHTML = ""; };
    this.opts.onCat?.(null);
    if (reduced()) return done();
    this.win.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(.1)" }], { duration: 240, easing: "cubic-bezier(.4,0,1,1)" }).onfinish = done;
  }

  flowOf(a, M) {
    const s = a.kind === "session" ? a.s : null, rep = a.kind === "report" ? a.r : a.report;
    const live = s && s.status !== "ended";
    const work = s?.work || null;
    const isScript = f => /\.(r|py|sh|ipynb|rmd|qmd|nf|smk|wdl|jl)$/i.test(f);
    const isFig = f => /\.(png|svg|pdf|jpe?g|tiff?)$/i.test(f) && !/^(REPORT|00_)/.test(f);
    const isTable = f => /\.(tsv|csv|txt|xlsx?|rds|rdata|parquet|json|h5ad|h5|vcf|maf|bed|gmt)$/i.test(f) && !/(^|\/)(sessionInfo|README)/.test(f);
    const scripts = work ? work.filter(f => isScript(f[0])).map(f => f[0]).sort() : rep?.scripts || [];
    // what the session is doing, best source first: its follow plan, Claude's own to-do list, the requests it was given,
    // and for a finished analysis without any of those, its scripts
    // each step's deps: the steps it waits for (indexes into steps); a plan says so, a list runs in its own order
    let steps, stepKind;
    const chain = xs => xs.map((x, i) => ({ ...x, deps: i ? [i - 1] : [] }));
    if (s?.g) {
      stepKind = "plan";
      const g = s.g, kept = g.order.filter(id => g.nodes[id].state !== "dropped"), at = new Map(kept.map((id, i) => [id, i]));
      // a step without deps waits for the step it branched from; a dropped step hands over to its replacement or its own deps
      const need = (id, seen) => {
        const n = g.nodes[id];
        if (!n || seen.has(id)) return [];
        seen.add(id);
        const ds = n.state === "dropped" && n.by ? [n.by] : n.deps.length ? n.deps : n.from ? [n.from] : [];
        return ds.flatMap(d => at.has(d) ? [at.get(d)] : need(d, seen));
      };
      steps = kept.map(id => { const n = g.nodes[id];
        return { id, title: n.title, state: n.state, outs: n.outs.length, since: n.since, deps: [...new Set(need(id, new Set()))] }; });
    } else if (s?.todos?.length) {
      stepKind = "todo";
      steps = chain(s.todos.map(t => ({ title: t.t, state: t.s === "now" && !live ? "done" : t.s })));
    } else if (s?.asks?.length) {
      stepKind = "ask";
      const last = s.asks.length - 1;
      steps = chain(s.asks.map((x, i) => ({ title: x.t, t0: Date.parse(x.at) || 0, state: i === last && (s.status === "busy" || s.status === "waiting") ? "now" : "done",
                                            since: i === last ? Date.parse(x.at) || null : null })));
    } else {   // no plan: the scripts are the steps (grouped by sub-analysis when the folder has several)
      stepKind = "script";
      const top = f => f.includes("/") ? f.split("/")[0] : "";
      const groups = new Set(scripts.map(top).filter(g => g && !/^(\d+_)?(scripts?|shared|src|code|R|py)$/i.test(g)));
      const named = groups.size > 1 ? [...groups].map(g => ({ title: g, n: scripts.filter(f => top(f) === g).length }))
        : scripts.map(f => ({ title: f.split("/").pop().replace(/\.[^.]+$/, "") }));
      steps = named.map(x => ({ title: x.title.replace(/^\d+[a-z]?[_-]/i, "").replace(/[_-]+/g, " "), n: x.n, state: "done" }));
      if (steps.length > 9) steps = [...steps.slice(0, 8), { title: `그 외 ${steps.length - 8}개`, state: "done" }];
      steps = chain(steps);
      if (live && steps.length && s.status === "busy") steps[steps.length - 1].state = "now";
    }
    // side work (subagents, background commands, workflows) hangs off the step that was running when it started
    const KIND = { agent: "에이전트", bg: "백그라운드", wf: "워크플로" }, END = { blocked: " (실패)", dropped: " (중단)" };
    const began = steps.map(x => x.since || x.t0 || 0);
    for (const ag of s?.agents || []) {
      const t = Date.parse(ag.at || "") || 0;
      let dep = -1;
      if (t) began.forEach((b, i) => { if (b && b <= t && (dep < 0 || b >= began[dep])) dep = i; });
      steps.push({ title: `${KIND[ag.k] || KIND.agent} · ${ag.t}${END[ag.s] || ""}`, agent: true, deps: dep >= 0 ? [dep] : [],
                   state: ag.s === "now" ? (live ? "now" : "done") : ag.s === "dropped" ? "left" : ag.s });
    }
    const now = Date.now() / 1000;
    const files = work ? work.filter(f => isTable(f[0]) || isFig(f[0])).sort((x, y) => x[2] - y[2]) : null;
    const recent = files ? files.slice(-6).reverse().map(f => ({ name: f[0], fresh: now - f[2] < 180 }))
      : (rep?.recent || []).slice(-6).reverse().map(n => ({ name: n, fresh: false }));
    const inputs = rep?.inputs?.length
      ? rep.inputs.map(q => { const c = M.cats.find(c => c.parts.some(pt => normp(q) === normp(pt.path) || normp(q).startsWith(normp(pt.path) + "/")));
          return { label: c ? c.name : normp(q).split("/").slice(-2).join("/"), sub: c ? bytes(c.bytes) : "데이터 경로", key: c?.key, path: q }; })
      : a.refs?.length ? a.refs.map(r => { const c = r.key && M.cats.find(x => x.key === r.key);
          return { label: c ? c.name : normp(r.path).split("/").slice(-2).join("/"), sub: (c ? bytes(c.bytes) + " · " : "") + r.n + "번 읽음", key: c?.key, path: r.path, n: r.n }; })
      : a.cats.map(k => M.cats.find(c => c.key === k)).filter(Boolean).map(c => ({ label: c.name, sub: bytes(c.bytes) + " · 추정", key: c.key }));
    const seen = new Set(), ins = inputs.filter(x => !seen.has(x.label) && seen.add(x.label));
    return {
      a, s, rep, live, color: this.opts.hostColor(a.host), steps, stepKind, inputs: ins, recent,
      tables: files ? files.filter(f => isTable(f[0])).length : rep?.tables || 0,
      figures: files ? files.filter(f => isFig(f[0])).length : rep?.figures || 0,
      checks: rep?.checks || [], why: rep?.why || null,
      conclusion: rep?.report ? rep.title : null,
      when: rep?.date || (s ? new Date(Math.max(s.updatedAt || 0, s.statusUpdatedAt || 0) || Date.now()).toISOString().slice(0, 10) : ""),
    };
  }

  drawFlow(first) {
    const M = this.M, a = M && [...M.sessions, ...M.reports].find(x => x.id === this.openAn);
    if (!a) return this.closeCat();
    const F = this.flowOf(a, M), anim = first && !reduced(), c = F.color;
    const st = F.s?.status;
    const running = st === "busy", waiting = st === "waiting" || F.steps.some(n => n.state === "blocked");
    const finished = !F.live;
    // which outputs are new since this window last drew (they slide in)
    const seen = this.seenFiles.get(a.id) || new Set(F.recent.map(r => r.name));
    const added = new Set(F.recent.map(r => r.name).filter(n => !seen.has(n)));
    this.seenFiles.set(a.id, new Set([...seen, ...F.recent.map(r => r.name)]));

    const W = 800, H = 540, top = 74, DX = 16, DW = 158, X0 = 258, OX = 482, CX = 640;   // columns
    let s = "", delay = 0;
    const rv = (ms = 70) => anim ? ` class="reveal" style="animation-delay:${(delay += ms)}ms"` : "";
    const col = (x, label) => `<text x="${x}" y="40" class="t-cap">${label}</text>`;
    s += col(DX, "읽은 데이터") + col(X0 - 14, { plan: "계획 단계", todo: "Claude 의 할 일", ask: "받은 요청", script: "단계 (스크립트)" }[F.stepKind]) + col(OX, "만든 것") + col(CX - 8, F.checks.length ? "확인과 판정" : "결론");

    // steps: a spine down the middle
    const n = Math.max(1, F.steps.length), sp = Math.min(52, (H - top - 40) / n), x0 = X0;
    const y0 = top + 22 + Math.max(0, (H - top - 40 - sp * (n - 1)) / 2 - 22);
    const sy = i => y0 + i * sp;
    const curI = Math.max(0, F.steps.findIndex(x => x.state === "now" || x.state === "blocked"));
    const lastDone = F.steps.reduce((k, x, i) => x.state === "done" ? i : k, -1);
    for (let i = 0; i < F.steps.length - 1; i++) {
      const solid = F.steps[i + 1].state === "done" || (F.steps[i].state === "done" && F.steps[i + 1].state !== "left");
      s += `<line class="spine${solid ? "" : " todo"}${anim ? " draw" : ""}" x1="${x0}" y1="${f1(sy(i) + 10)}" x2="${x0}" y2="${f1(sy(i + 1) - 10)}" style="${solid ? `stroke:${c};` : ""}${anim ? `animation-delay:${400 + i * 90}ms` : ""}"/>`;
    }
    // data → the first step
    const ni = Math.min(F.inputs.length, 7), dh = 44;
    const dy = i => top + 22 + Math.max(0, (H - top - 40 - dh * (ni - 1)) / 2 - 22) + i * dh;
    F.inputs.slice(0, ni).forEach((d, i) => {
      const y = dy(i), path = `M${DX + DW} ${f1(y)} C${DX + DW + 50} ${f1(y)} ${x0 - 60} ${f1(sy(0))} ${x0 - 13} ${f1(sy(0))}`;
      s += `<path class="flink${anim ? " draw" : ""}" d="${path}" ${anim ? `style="animation-delay:${200 + i * 60}ms"` : ""}/>`;
      if (!reduced() && (running || anim)) {   // data keeps flowing in while it runs; a finished one gets a single pass
        const full = path + ` L${x0} ${f1(sy(0))} L${x0} ${f1(sy(running ? curI : Math.max(0, lastDone)))}`;
        s += `<circle r="2.8" style="fill:${c}" opacity="${running ? 1 : 0}"><animateMotion dur="${running ? 3.2 : 1.6}s" ${running ? `repeatCount="indefinite" begin="${(i * 0.45).toFixed(2)}s"` : `begin="${(0.9 + i * 0.08).toFixed(2)}s" fill="freeze"`} path="${full}" calcMode="spline" keyTimes="0;1" keySplines="0.45 0 0.25 1"/>${running ? "" : `<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.1;.85;1" dur="1.6s" begin="${(0.9 + i * 0.08).toFixed(2)}s" fill="freeze"/>`}</circle>`;
      }
      s += `<g class="fdata${d.key ? "" : " raw"}"${d.key ? ` data-cat="${esc(d.key)}"` : ""}${rv(60)}><rect x="${DX}" y="${f1(y - 17)}" width="${DW}" height="34" rx="4"/>
        <text x="${DX + 11}" y="${f1(y - 1)}" class="t-node">${esc(cut(d.label, 16))}</text><text x="${DX + 11}" y="${f1(y + 12)}" class="t-n start">${esc(d.sub)}</text>${d.path ? `<title>${esc(d.path)}</title>` : ""}</g>`;
    });
    if (!F.inputs.length) s += `<text x="${DX}" y="${f1(sy(0) + 4)}" class="t-sub">적힌 데이터 경로 없음</text>`;
    if (F.inputs.length > ni) s += `<text x="${DX}" y="${f1(dy(ni - 1) + 34)}" class="t-cap">그 외 ${F.inputs.length - ni}개</text>`;
    // the steps themselves
    F.steps.forEach((x, i) => {
      const y = sy(i), cur = x.state === "now" || x.state === "blocked", bad = x.state === "blocked" || (cur && waiting);
      const dd = anim ? 420 + i * 90 : 0;
      s += `<g class="fstep ${x.state}${bad ? " bad" : ""}"${anim ? ` style="animation-delay:${dd}ms"` : ""}>`;
      if (cur && F.live && !bad) s += `<circle class="halo" cx="${x0}" cy="${f1(y)}" r="11" style="stroke:${c}"/><path class="spin" d="${arc(x0, y, 14, -90, 30)}" style="stroke:${c};transform-origin:${x0}px ${f1(y)}px"/>`;
      if (bad) s += `<circle class="ring-wait breathe" cx="${x0}" cy="${f1(y)}" r="13"/>`;
      s += `<circle class="node" cx="${x0}" cy="${f1(y)}" r="${cur ? 8 : 7}" style="${x.state === "done" || (cur && !bad) ? `fill:${c};stroke:${c}` : ""}"/>`;
      if (x.state === "done") s += `<path class="tick${anim && finished ? " late" : ""}" d="M${x0 - 3.2} ${f1(y)} l2.4 2.4 l4.2 -4.8"${anim && finished ? ` style="animation-delay:${1100 + i * 110}ms"` : ""}/>`;
      s += `<text x="${x0 + 22}" y="${f1(y + 4)}" class="t-node${cur ? " strong" : x.state === "left" ? " t-faint" : ""}">${esc(cut(x.title, 17))}${x.n ? `<tspan class="t-sub" dx="6">${x.n}개</tspan>` : ""}</text>`;
      if (cur && F.live) s += `<text x="${x0 + 22}" y="${f1(y + 19)}" class="${bad ? "t-wait" : "t-sub"}">${bad ? "입력을 기다림" : "지금 하는 단계"}</text>`;
      s += `<title>${esc(x.title)}</title></g>`;
    });
    // steps → tables and figures
    const oy = [top + 70, top + 160], ox = OX;
    const from = Math.max(0, F.live ? curI : F.steps.length - 1);
    [["표", F.tables], ["그림", F.figures]].forEach(([label, count], k) => {
      const y = oy[k];
      s += `<path class="flink${count ? "" : " todo"}${anim ? " draw" : ""}" d="M${x0 + 12} ${f1(sy(from))} C${x0 + 150} ${f1(sy(from))} ${ox - 90} ${y} ${ox - 6} ${y}"${anim ? ` style="animation-delay:${900 + k * 80}ms"` : ""}/>`;
      s += `<g class="fout"${rv(80)}><rect class="sheet" x="${ox + 6}" y="${y - 22}" width="96" height="40" rx="4"/><rect class="sheet" x="${ox + 3}" y="${y - 19}" width="96" height="40" rx="4"/>
        <rect class="sheet front" x="${ox}" y="${y - 16}" width="96" height="40" rx="4"/>
        <text x="${ox + 12}" y="${y + 9}" class="t-big">${count}</text><text x="${ox + 52}" y="${y + 8}" class="t-sub">${label}</text></g>`;
    });
    F.recent.slice(0, 5).forEach((r, i) => {
      const y = top + 228 + i * 22, isNew = added.has(r.name) || (r.fresh && F.live);
      s += `<g class="ffile${isNew ? " fresh" : ""}"${anim ? ` style="animation-delay:${1000 + i * 60}ms"` : ""}><path class="fi" d="M${ox} ${y - 8} h7 l3 3 v8 h-10 z"/>
        <text x="${ox + 16}" y="${y + 1}" class="t-sub">${esc(cut(r.name.split("/").pop(), 17))}</text>${isNew ? `<text x="${ox - 4}" y="${y + 1}" class="t-new" text-anchor="end">새</text>` : ""}<title>${esc(r.name)}</title></g>`;
    });
    // checks with their verdicts (or the conclusion when the report has none)
    const VK = { 지지: "ok", 기각: "no", 미결: "open", 판정보류: "hold" };
    const ck = F.checks.slice(0, 8), ch = Math.min(46, (H - top - 30) / Math.max(1, ck.length));
    ck.forEach((x, i) => {
      const y = top + 26 + i * ch, dd = 1500 + i * 140;
      s += `<path class="flink${anim ? " draw" : ""}" d="M${ox + 100} ${oy[0]} C${ox + 130} ${oy[0]} ${CX - 36} ${f1(y)} ${CX - 10} ${f1(y)}"${anim ? ` style="animation-delay:${1300 + i * 60}ms"` : ""}/>`;
      s += `<g class="fcheck ${VK[x.verdict]}"${anim ? ` style="animation-delay:${dd}ms"` : ""}><circle cx="${CX}" cy="${f1(y)}" r="7"/>${{ ok: `<path d="M${CX - 3.4} ${f1(y)} l2.4 2.4 l4.2 -4.8"/>`, no: `<path d="M${CX - 3} ${f1(y - 3)} l6 6 m0 -6 l-6 6"/>`, hold: `<path d="M${CX} ${f1(y - 7)} a7 7 0 0 1 0 14 z"/>`, open: "" }[VK[x.verdict]]}
        <text x="${CX + 16}" y="${f1(y - 1)}" class="t-node">${esc(cut(x.text, 11))}</text><text x="${CX + 16}" y="${f1(y + 13)}" class="t-v">${x.verdict}${x.mixed ? " 외" : ""}</text><title>${esc(x.text + " → " + x.verdict)}</title></g>`;
    });
    if (!ck.length) {
      s += `<path class="flink${anim ? " draw" : ""}" d="M${ox + 100} ${oy[0]} C${ox + 140} ${oy[0]} ${CX - 36} ${top + 110} ${CX - 10} ${top + 110}"/>`;
      s += `<g${rv(120)}><circle class="node end${finished ? "" : " todo"}" cx="${CX}" cy="${top + 110}" r="7" style="${finished ? `fill:${c};stroke:${c}` : ""}"/>
        <text x="${CX + 16}" y="${top + 114}" class="t-node">${finished ? (F.conclusion ? "보고서 있음" : "끝남") : "아직 진행 중"}</text></g>`;
    }

    const stateWord = running ? "실행 중" : waiting ? "입력을 기다리는 중" : st === "idle" ? "대기 중" : st === "ended" ? "끝난 세션" : "끝난 분석";
    const html = `<div class="pw-head"><button class="crumb" data-close>${esc(M.p.name)}</button><span class="sep">/</span><b>${esc(cut(a.label, 60))}</b>
        <span class="meta${running ? " live" : ""}">${stateWord}</span><button class="x" data-close aria-label="닫기">×</button></div>
      <div class="pw-body one"><div class="fl-main${anim ? " enter" : ""}${running ? " running" : ""}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(a.label)} 분석 흐름">${s}</svg></div></div>`;
    const sig = JSON.stringify([a.id, F.steps.map(x => x.state), F.tables, F.figures, F.recent.map(r => r.name), F.checks.length, st]);
    if (first || this.win.dataset.sig !== sig) { this.win.innerHTML = html; this.win.dataset.sig = sig; }
  }


  // ── context menu (right click, or the menu key / Shift+F10 on a focused box) ──────────────────────────────
  bindMenu() {
    this.menu = document.createElement("div");
    this.menu.className = "pj-menu";
    this.menu.setAttribute("role", "menu");
    this.menu.hidden = true;
    this.toast = document.createElement("div");
    this.toast.className = "pj-toast";
    this.toast.setAttribute("role", "status");
    document.body.append(this.menu, this.toast);
    this.svg.addEventListener("contextmenu", e => {
      const nd = e.target.closest(".nd");
      if (!nd) return;
      e.preventDefault();
      this.openMenu(nd, e.clientX, e.clientY);
    });
    this.svg.addEventListener("keydown", e => {
      const nd = e.target.closest(".nd");
      if (nd && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) {
        e.preventDefault();
        const r = nd.getBoundingClientRect();
        this.openMenu(nd, r.left + 24, r.bottom - 4);
      }
    });
    this.menu.addEventListener("click", e => {
      const b = e.target.closest("button[data-i]");
      if (!b || b.disabled) return;
      const act = this.menuActs[+b.dataset.i];
      if (!b.dataset.keep) this.closeMenu(true);
      act();
    });
    this.menu.addEventListener("submit", e => {
      e.preventDefault();
      const f = e.target.closest("form[data-i]"), v = f.querySelector("input").value.trim(), act = this.menuActs[+f.dataset.i];
      this.closeMenu(true);
      act(v);
    });
    this.menu.addEventListener("keydown", e => {
      const bs = [...this.menu.querySelectorAll("button:not(:disabled), input")], i = bs.indexOf(document.activeElement);
      if (e.target.tagName === "INPUT" && e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Escape") return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); bs[(i + (e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length]?.focus(); }
      else if (e.key === "Home" || e.key === "End") { e.preventDefault(); bs[e.key === "Home" ? 0 : bs.length - 1]?.focus(); }
      else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); this.closeMenu(true); }
    });
    const away = e => { if (!this.menu.hidden && !this.menu.contains(e.target)) this.closeMenu(false); };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("blur", () => this.closeMenu(false));
    window.addEventListener("resize", () => this.closeMenu(false));
    this.svg.addEventListener("wheel", () => this.closeMenu(false), { passive: true });
  }

  menuItems(nd) {
    const M = this.M, id = nd.dataset.sel, key = nd.dataset.key;
    const a = id ? [...M.sessions, ...M.reports].find(x => x.id === id) : null;
    const copy = (label, text) => ({ label, icon: "copy", run: () => this.copy(text, label) });
    const todo = (text, links) => [
      { label: "질문으로 보내기", icon: "ask", run: () => this.toTodo(text, "question", links) },
      { label: "할 일로 보내기", icon: "todo", run: () => this.toTodo(text, "todo", links) }];
    const hide = x => x.hidden
      ? { label: "다시 보이기", icon: "show", run: () => this.setHidden(x, false) }
      : { label: "화면에서 숨기기", icon: "hide", danger: true, run: () => this.setHidden(x, true) };
    if (nd.dataset.step != null && a) {   // a plan step: its state is written to that session's plan
      const s = a.s, step = nd.dataset.step, cur = s.g?.nodes[step]?.state;
      const set = (state, label, icon) => ({ label, icon, on: cur === state, disabled: cur === state, run: () => this.setStep(a, step, state, label) });
      return { head: s.g?.nodes[step]?.title || step, sub: a.label, items: [
        set("done", "완료로 표시", "done"), set("now", "진행 중으로 표시", "now"), set("blocked", "막힘으로 표시", "blocked"), set("left", "대기로 되돌리기", "left"),
        "-", { label: "세션 진행 페이지 열기", icon: "open", run: () => this.opts.onOpen(s.key) },
        copy("단계 이름 복사", s.g?.nodes[step]?.title || step),
        "-", ...todo(`${s.g?.nodes[step]?.title || step} — ${a.label}`, [a.id])] };
    }
    if (key && key.includes("#") && a) {   // a step from a to-do list, the requests or scripts: nothing to set
      const title = nd.querySelector("title")?.textContent || "";
      return { head: title, sub: a.label, items: [{ label: "세션 진행 페이지 열기", icon: "open", disabled: !a.s, run: () => this.opts.onOpen(a.s.key) },
        copy("이름 복사", title), "-", ...todo(`${title} — ${a.label}`, [a.id])] };
    }
    if (a?.kind === "session") {
      const s = a.s, row = this.layout?.blocks.find(b => b.a?.id === a.id), q = x => `"${String(x || "").replace(/"/g, '\\"')}"`;
      return { head: a.label, sub: `${STATUS_KO[s.status]} · ${a.host}`, items: [
        { label: "진행 페이지 열기", icon: "open", run: () => this.opts.onOpen(s.key) },
        { label: "흐름 크게 보기", icon: "flow", run: () => this.openFlowAt(a.id, nd) },
        ...(row?.n ? [{ label: row.open ? "단계 접기" : "단계 펼치기", icon: "fold", run: () => { this.toggled.set(a.id, !row.open); this.paint(true); } }] : []),
        "-", { label: a.theme ? `테마 옮기기 (지금: ${cut(a.theme, 14)}${a.themeBy === "auto" ? ", 자동" : ""})` : "테마 정하기", icon: "theme",
               keep: true, run: () => this.openThemeMenu(nd, [a]) },
        "-", copy("폴더 경로 복사", s.workDir || s.cwd), copy("세션 ID 복사", s.sessionId),
        copy("재개 명령 복사", `cd ${q(s.cwd)}; claude --resume ${s.sessionId}`),
        "-", ...todo(a.label, [a.id]), "-", hide(a)] };
    }
    if (a?.kind === "report") {
      return { head: a.label, sub: `보고서 · ${a.host} · ${a.r.date}`, items: [
        { label: "흐름 크게 보기", icon: "flow", run: () => this.openFlowAt(a.id, nd) },
        copy("보고서 폴더 복사", a.r.path), "-", ...todo(a.label, [a.id]), "-", hide(a)] };
    }
    if (key?.startsWith("th:")) {   // a theme: rename it (every session in it moves), fold its sessions
      const name = nd.dataset.theme, list = M.sessions.filter(x => (x.theme || "분류 전") === name);
      const rows = this.layout?.blocks.filter(b => b.kind === "session" && list.includes(b.a)) || [];
      const auto = list.filter(x => x.themeBy === "auto").length;
      return { head: name, sub: `세션 ${list.length}${auto ? ` · 자동 분류 ${auto}` : ""}`, items: [
        ...(name === "분류 전" ? [] : [{ input: true, icon: "theme", value: name, placeholder: "테마 이름", hint: "이름 바꾸기",
          submit: v => { if (v && v !== name) this.setTheme(list, v, `'${cut(name, 16)}' 을 '${cut(v, 16)}' 로 바꿈`); } }]),
        { label: "세션 단계 모두 펼치기", icon: "fold", run: () => { rows.forEach(b => this.toggled.set(b.a.id, true)); this.paint(true); } },
        { label: "세션 단계 모두 접기", icon: "fold", run: () => { rows.forEach(b => this.toggled.set(b.a.id, false)); this.paint(true); } },
        ...(auto ? [{ label: `자동 분류 ${auto}개 그대로 확정`, icon: "done", run: () => this.setTheme(list.filter(x => x.themeBy === "auto"), name, "확정함") }] : [])] };
    }
    if (key === "reports") {
      const row = this.layout?.blocks.find(b => b.kind === "group");
      return { head: "지난 분석 보고서", items: [{ label: row?.open ? "목록 접기" : "목록 펼치기", icon: "fold", run: () => { this.toggled.set("reports", !row?.open); this.paint(true); } }] };
    }
    if (key === "p") {
      return { head: M.p.name, items: [
        ...(M.p.other ? [] : [{ label: "프로젝트 이름·폴더 고치기", icon: "edit", keep: true,
          run: () => this.openMenu(nd, this.menuAt.x, this.menuAt.y, this.projectMenu(M.p.name)) }, "-"]),
        { label: this.showHidden ? "숨긴 항목 감추기" : `숨긴 항목 보기${M.hiddenN ? ` (${M.hiddenN})` : ""}`, icon: this.showHidden ? "hide" : "show",
          disabled: !M.hiddenN && !this.showHidden, run: () => { this.showHidden = !this.showHidden; this.paint(true); } },
        { label: this.showEnded ? "꺼진 세션 감추기" : `꺼진 세션 보기${M.endedN ? ` (${M.endedN})` : ""}`, icon: this.showEnded ? "hide" : "show",
          disabled: !M.endedN && !this.showEnded, run: () => this.root.querySelector(".pj-ended").click() },
        { label: "화면에 맞추기", icon: "fit", run: () => this.fitZoom() },
        { label: "옮긴 상자 제자리로", icon: "fold", run: () => { delete this.pos[this.cur]; this.renderTree(false); this.fitZoom(); } },
        { label: "데이터 다시 읽기", icon: "flow", run: () => fetch("/api/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
          .then(() => this.say("데이터를 다시 읽는 중")) }] };
    }
    return null;
  }

  openThemeMenu(nd, list) {
    const cur = list[0].theme, names = [...new Set(this.M.sessions.map(x => x.theme).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const r = this.menuAt || { x: 0, y: 0 };
    this.openMenu(nd, r.x, r.y, { head: "테마 옮기기", sub: cut(list[0].label, 40), items: [
      ...names.map(n => ({ label: n, icon: "theme", on: n === cur, disabled: n === cur && list[0].themeBy === "user",
                           run: () => this.setTheme(list, n, `'${cut(n, 20)}' 로 옮김`) })),
      "-", { input: true, icon: "theme", placeholder: "새 테마 이름", hint: "새 테마", submit: v => v && this.setTheme(list, v, `새 테마 '${cut(v, 20)}' 로 옮김`) }] });
  }

  setTheme(list, theme, done) {
    for (const a of list) this.rethemed.set(a.id, theme);
    this.paint(true);
    this.post("/api/todo", { do: "themes", project: this.M.p.other ? "" : this.M.p.name, set: Object.fromEntries(list.map(a => [a.id, theme])) })
      .then(() => this.say(done), e => { for (const a of list) this.rethemed.delete(a.id); this.paint(true); this.fail(e.message); });
  }

  openMenu(nd, x, y, spec) {
    const m = spec || this.menuItems(nd);
    if (!m) return;
    this.menuAt = { x, y };
    this.menuFrom = nd;
    this.menuActs = [];
    const ICONS = {   // 16px line icons, same stroke as the map's
      done: "M3.5 8.5l3 3 6-7", now: "M8 3.5a4.5 4.5 0 1 1-4.5 4.5", blocked: "M8 4v5M8 11.5v.2M2.5 13.5L8 2.5l5.5 11z",
      left: "M8 3.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9", open: "M6.5 3.5h-3v9h9v-3M9 3.5h3.5V7M12.5 3.5L7 9",
      flow: "M2.5 8h3l2-4 2 8 2-4h2", fold: "M4 6l4 4 4-4", copy: "M5.5 5.5h7v7h-7zM3.5 10.5v-7h7",
      ask: "M6 6.2a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6 1v.6M8 11.5v.2", todo: "M3.5 4.5h1M3.5 8h1M3.5 11.5h1M6.5 4.5h6M6.5 8h6M6.5 11.5h6",
      hide: "M2.5 8s2-4 5.5-4 5.5 4 5.5 4-2 4-5.5 4-5.5-4-5.5-4zM3.5 12.5l9-9", show: "M2.5 8s2-4 5.5-4 5.5 4 5.5 4-2 4-5.5 4-5.5-4-5.5-4zM8 6.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3",
      fit: "M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3", edit: "M3 13l1-3.5 7-7 2.5 2.5-7 7zM9.5 4l2.5 2.5",
      folder: "M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z", up: "M8 12.5v-9M4.5 7L8 3.5 11.5 7", down: "M8 3.5v9M4.5 9L8 12.5 11.5 9",
      trash: "M3.5 4.5h9M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5", theme: "M2.5 5.5l5.5-3 5.5 3-5.5 3zM2.5 8.5l5.5 3 5.5-3M2.5 11l5.5 3 5.5-3" };
    const rows = m.items.map(it => {
      if (it === "-") return `<hr>`;
      if (it.input) {   // a name typed into the menu: Enter applies it
        const i = this.menuActs.push(it.submit) - 1;
        return `<form class="mi" data-i="${i}"><svg viewBox="0 0 16 16"><path d="${ICONS[it.icon] || ""}"/></svg>
          <input value="${esc(it.value || "")}" placeholder="${esc(it.placeholder)}" aria-label="${esc(it.hint)}" maxlength="60"><kbd>Enter</kbd></form>`;
      }
      const i = this.menuActs.push(it.run) - 1;
      return `<button role="menuitem" data-i="${i}" class="${it.danger ? "danger" : ""}${it.on ? " on" : ""}"${it.disabled ? " disabled" : ""}${it.keep ? ` data-keep="1"` : ""}>
        <svg viewBox="0 0 16 16"><path d="${ICONS[it.icon] || ""}"/></svg><span>${esc(it.label)}</span>${it.on ? `<i>지금</i>` : ""}</button>`;
    }).join("");
    this.menu.innerHTML = `<div class="mh"><b>${esc(cut(m.head, 40))}</b>${m.sub ? `<small>${esc(cut(m.sub, 48))}</small>` : ""}</div>${rows}`;
    this.menu.hidden = false;
    const w = this.menu.offsetWidth, h = this.menu.offsetHeight, pad = 8;
    const left = Math.min(x, innerWidth - w - pad), top = y + h > innerHeight - pad ? Math.max(pad, y - h) : y;
    this.menu.style.left = Math.max(pad, left) + "px";
    this.menu.style.top = top + "px";
    this.menu.style.transformOrigin = `${x - left}px ${top < y ? h : 0}px`;
    this.menu.classList.remove("in");
    void this.menu.offsetWidth;   // restart the entrance
    this.menu.classList.add("in");
    nd.classList.add("menu-on");
    (spec ? this.menu.querySelector("button:not(:disabled), input") : this.menu.querySelector("button:not(:disabled)"))?.focus({ preventScroll: true });
  }

  closeMenu(refocus) {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.menuFrom?.classList.remove("menu-on");
    if (refocus) this.menuFrom?.focus?.({ preventScroll: true });
    this.menuFrom = null;
  }

  say(text, undo) {
    clearTimeout(this.toastT);
    this.toast.innerHTML = `<span>${esc(text)}</span>${undo ? `<button>되돌리기</button>` : ""}`;
    this.toast.classList.remove("err");
    this.toast.classList.add("on");
    if (undo) this.toast.querySelector("button").onclick = () => { this.toast.classList.remove("on"); undo(); };
    const later = () => { this.toastT = setTimeout(() => this.toast.classList.remove("on"), undo ? 8000 : 2600); };
    this.toast.onpointerenter = () => clearTimeout(this.toastT);   // stays while the pointer is on it
    this.toast.onpointerleave = later;
    later();
  }

  fail(text) { this.say(text); this.toast.classList.add("err"); }

  async post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = await r.json().catch(() => ({ ok: false, error: "응답을 읽지 못함" }));
    if (!out.ok) throw new Error(out.error || "실패");
    return out;
  }

  copy(text, label) {
    navigator.clipboard.writeText(String(text || "")).then(() => this.say(label.replace(/ 복사$/, "") + " 복사함"), () => this.fail("복사하지 못함"));
  }

  toTodo(text, kind, links) {
    const project = this.M.p.other ? null : this.M.p.name;
    this.post("/api/todo", { do: "add", items: [{ text, kind, project, links }] })
      .then(() => this.say(`${kind === "question" ? "질문" : "할 일"}에 추가함`), e => this.fail(e.message));
  }

  setHidden(a, on) {
    this.hiding.set(a.id, on);   // leave (or come back) at once; the list host confirms within a moment
    if (on && this.sel === a.id) this.sel = null;
    this.paint(true);
    const done = () => { this.hiding.delete(a.id); };
    this.post("/api/todo", { do: on ? "hide" : "unhide", ids: [a.id], label: a.label })
      .then(() => { done(); this.say(on ? `'${cut(a.label, 24)}' 숨김` : "다시 보임", on ? () => this.setHidden(a, false) : null); },
            e => { done(); this.paint(true); this.fail(e.message); });
  }

  setStep(a, step, state, label) {
    const nd = this.svg.querySelector(`.nd[data-step="${CSS.escape(step)}"][data-sel="${CSS.escape(a.id)}"]`);
    nd?.classList.add("saving");
    this.post("/api/step", { host: a.s.host, session: a.s.sessionId, step, state })
      .then(() => this.say(label.replace(/표시$/, "표시함").replace(/되돌리기$/, "되돌림")), e => this.fail(e.message))
      .finally(() => setTimeout(() => this.svg.querySelector(`.nd.saving[data-step="${CSS.escape(step)}"]`)?.classList.remove("saving"), 2500));
  }

  // ── input ─────────────────────────────────────────────────────────────
  click(e) {
    const t = e.target;
    const proj = t.closest("[data-proj]");
    if (proj) {
      this.cur = proj.dataset.proj; this.sel = null; this.dsOpen = null; this.closeCat();
      try { localStorage.setItem("fw-proj", this.cur); } catch (err) {}
      this.opts.onProject?.(this.cur);
      return this.paint(true);
    }
    const tab = t.closest("[data-tab]");
    if (tab) { this.tab = tab.dataset.tab; try { localStorage.setItem("fw-proj-tab", this.tab); } catch (err) {} return this.paint(true); }
    if (t.closest("[data-close]")) return this.closeCat();
    const tog = t.closest("[data-toggle]");
    if (tog) {
      const id = tog.dataset.toggle, row = this.layout?.blocks.find(r => (r.kind === "group" ? "reports" : r.a.id) === id);
      this.toggled.set(id, !(row ? row.open : this.isOpen(id, false)));
      return this.paint(true);
    }
    const jump = t.closest("[data-jump]");
    if (jump) {
      if (this.tab !== "data") { this.tab = "data"; this.paint(true); }
      return this.cat.querySelector(`#dc-${jump.dataset.jump}`)?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" });
    }
    const ds = t.closest("[data-ds]");
    if (ds) {
      this.dsOpen = this.dsOpen === ds.dataset.ds ? null : ds.dataset.ds;
      if (this.tab !== "data") { this.tab = "data"; this.paint(true); }
      else this.paint();
      return this.cat.querySelector(`[data-ds="${CSS.escape(ds.dataset.ds)}"]`)?.scrollIntoView({ block: "nearest" });
    }
    const open = t.closest("[data-open]");
    if (open) return this.opts.onOpen(open.dataset.open);
    const fl = t.closest("[data-flow]");
    if (fl) return this.openFlowAt(fl.dataset.flow, fl);
    const pick = t.closest("[data-pick], [data-sel]");
    if (pick) {
      const id = pick.dataset.pick ?? pick.dataset.sel;
      this.sel = id || null;
      if (id && this.tab !== "tree" && pick.dataset.pick != null) this.tab = "tree";
      return this.paint(true);
    }
    if (t.closest(".pj-refresh")) {
      const b = t.closest(".pj-refresh");
      b.disabled = true;
      fetch("/api/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
        .finally(() => setTimeout(() => { b.disabled = false; }, 4000));
      return;
    }
    const z = t.closest("[data-zoom]");
    if (z) {
      const k = z.dataset.zoom;
      if (k === "reset") { delete this.pos[this.cur]; this.renderTree(false); return this.fitZoom(); }
      return k === "fit" ? this.fitZoom() : this.setZoom(k === "in" ? this.view.z * 1.2 : k === "out" ? this.view.z / 1.2 : 1);
    }
    if (this.dragged) { this.dragged = false; return; }   // the end of a drag is not a click on the canvas
    if (t.closest(".pj-tree") && !t.closest(".nd") && this.sel) { this.sel = null; this.paint(true); }
  }

  select(name, cat, an) {   // from the address bar: ?p=<project>&d=<data>&a=<analysis>
    if (name && this.projects?.some(p => p.name === name)) this.cur = name;
    if (cat) { this.tab = "data"; this.dsOpen = cat.toLowerCase(); }
    this.paint(true);
    if (an && this.M && [...this.M.sessions, ...this.M.reports].some(x => x.id === an)) { this.sel = an; this.paint(true); }
  }
}
