// Step outputs: one icon language for every file type, and a viewer that lists a session's outputs by step.
// Files are fetched through /api/file, which only serves paths a session recorded with `follow.py out`.

const KINDS = [
  [/^pdf$/, "pdf", "PDF", "#CD4246"],
  [/^pptx?$|^key$/, "slides", "PPT", "#D9822B"],
  [/^docx?$|^hwpx?$|^odt$/, "doc", "DOC", "#2D72D2"],
  [/^xlsx?$|^ods$/, "sheet", "XLS", "#238551"],
  [/^csv$|^tsv$/, "table", "CSV", "#238551"],
  [/^html?$/, "html", "WEB", "#7961DB"],
  [/^png$|^jpe?g$|^gif$|^webp$|^svg$/, "image", "IMG", "#00A396"],
  [/^md$|^txt$|^log$|^json$|^tex$/, "text", "TXT", "#5F6B7C"],
];
const STATE_KO = { done: "완료", now: "진행 중", side: "병행 중", blocked: "막힘", left: "대기", dropped: "제외" };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function fileKind(name) {
  const ext = (String(name).match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
  for (const [re, kind, label, color] of KINDS) if (re.test(ext)) return { kind, label, color, ext };
  return { kind: "file", label: (ext || "file").slice(0, 4).toUpperCase(), color: "#738091", ext };
}

// a folded-corner page with a coloured type band: the same shape for every format, so only the band changes
export function fileIcon(name, size = 22) {
  const k = fileKind(name);
  return `<svg class="ficon" width="${size * 0.82}" height="${size}" viewBox="0 0 18 22" aria-hidden="true">
    <path d="M2.5 1h9L16 5.5V20a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z" class="fi-page"/>
    <path d="M11.5 1v4.5H16" class="fi-fold"/>
    <rect x="0" y="11" width="15" height="7.5" rx="1.2" fill="${k.color}"/>
    <text x="7.5" y="16.6" class="fi-t">${k.label}</text></svg>`;
}

const url = (host, path, dl) => `/api/file?host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}${dl ? "&dl=1" : ""}`;

let root = null, cur = null;   // cur = { s, files, i }

function build() {
  root = document.createElement("div");
  root.className = "vw";
  root.hidden = true;
  root.innerHTML = `<div class="vw-back" data-close></div>
    <div class="vw-box" role="dialog" aria-modal="true" aria-label="산출물 보기">
      <nav class="vw-list"></nav>
      <section class="vw-main">
        <div class="vw-bar"><span class="vw-ic"></span><div class="vw-tt"><b></b><span></span></div>
          <a class="vw-btn" data-act="tab" target="_blank" rel="noopener">새 탭</a><a class="vw-btn" data-act="dl">내려받기</a>
          <button class="vw-x" data-close title="닫기 (Esc)">×</button></div>
        <div class="vw-body"></div>
      </section>
    </div>`;
  document.body.appendChild(root);
  root.addEventListener("click", e => {
    if (e.target.closest("[data-close]")) return close();
    const row = e.target.closest("[data-i]");
    if (row) show(+row.dataset.i);
  });
  document.addEventListener("keydown", e => {
    if (root.hidden) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown" || e.key === "ArrowRight") show(Math.min(cur.files.length - 1, cur.i + 1));
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") show(Math.max(0, cur.i - 1));
  });
}

function close() {
  root.hidden = true;
  root.querySelector(".vw-body").innerHTML = "";
  document.body.classList.remove("vw-open");
}

// open the viewer on one session's outputs; `at` is a file path or a step id
export function openOutputs(s, at, demo = false) {
  if (!root) build();
  const g = s.g, files = g.outs;
  if (!files.length) return;
  let i = files.findIndex(f => f.path === at);
  if (i < 0) i = Math.max(0, files.findIndex(f => f.step === at));
  cur = { s, files, i, demo };
  let html = `<div class="vw-sess"><b>${esc(s.label)}</b><span>${esc(s.host)} · 산출물 ${files.length}</span></div>`;
  for (const id of g.order) {
    const n = g.nodes[id];
    if (!n.outs.length) continue;
    html += `<div class="vw-step"><i class="sd ${n.state}"></i>${esc(n.title)}<span>${STATE_KO[n.state] || ""}</span></div>` +
      n.outs.map(f => { const k = files.indexOf(f); return `<button class="vw-row" data-i="${k}">${fileIcon(f.name, 20)}<span>${esc(f.name)}</span></button>`; }).join("");
  }
  root.querySelector(".vw-list").innerHTML = html;
  root.hidden = false;
  document.body.classList.add("vw-open");
  show(i);
}

async function show(i) {
  const { s, files, demo } = cur, f = files[i], g = s.g;
  cur.i = i;
  root.querySelectorAll(".vw-row").forEach(r => r.classList.toggle("on", +r.dataset.i === i));
  root.querySelector(`.vw-row[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  const k = fileKind(f.name), u = url(s.host, f.path);
  root.querySelector(".vw-ic").innerHTML = fileIcon(f.name, 26);
  root.querySelector(".vw-tt b").textContent = f.name;
  root.querySelector(".vw-tt span").textContent = `${g.nodes[f.step]?.title || f.step} · ${s.host}:${f.path}`;
  root.querySelector('[data-act="tab"]').href = u;
  root.querySelector('[data-act="dl"]').href = url(s.host, f.path, true);
  const body = root.querySelector(".vw-body");
  body.className = "vw-body " + k.kind;
  const note = (title, text) => `<div class="vw-note">${fileIcon(f.name, 64)}<b>${title}</b><p>${text}</p>
    <a class="primary" href="${esc(url(s.host, f.path, true))}">내려받기</a></div>`;
  if (demo) { body.innerHTML = note("데모 데이터", "실제 세션의 산출물은 여기에서 바로 열립니다."); return; }
  if (k.kind === "pdf") body.innerHTML = `<iframe src="${esc(u)}" title="${esc(f.name)}"></iframe>`;
  else if (k.kind === "html") body.innerHTML = `<iframe src="${esc(u)}" title="${esc(f.name)}" sandbox="allow-scripts allow-popups allow-downloads"></iframe>`;
  else if (k.kind === "image") body.innerHTML = `<div class="vw-img"><img src="${esc(u)}" alt="${esc(f.name)}"></div>`;
  else if (k.kind === "text" || k.kind === "table") {
    body.innerHTML = `<div class="vw-wait">불러오는 중…</div>`;
    try {
      const r = await fetch(u);
      const text = await r.text();
      if (cur.files[cur.i] !== f) return;   // moved on while loading
      if (!r.ok) throw new Error(text);
      body.innerHTML = k.kind === "table" ? table(text, k.ext === "tsv" ? "\t" : ",") : `<pre>${esc(text.slice(0, 400000))}</pre>`;
    } catch (e) {
      body.innerHTML = note("열지 못했습니다", esc(e.message));
    }
  } else body.innerHTML = note(`${k.label} 파일은 브라우저에서 바로 볼 수 없습니다`, "내려받으면 이 컴퓨터의 기본 프로그램으로 열 수 있습니다.");
}

// ponytail: naive split (no quoted delimiters), enough to eyeball a results table; first 300 rows
function table(text, sep) {
  const rows = text.split(/\r?\n/).filter(Boolean).slice(0, 301).map(l => l.split(sep));
  const [head, ...rest] = rows;
  return `<div class="vw-table"><table><thead><tr>${head.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead>
    <tbody>${rest.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

// tiles for a session's outputs grouped by step, in plan order; `seen` marks tiles that should not animate in
export function outputsHtml(s, seen) {
  const g = s.g;
  let html = "";
  for (const id of g.order) {
    const n = g.nodes[id];
    if (!n.outs.length) continue;
    html += `<div class="ostep"><div class="os-t"><i class="sd ${n.state}"></i>${esc(n.title)}</div><div class="ofiles">${n.outs.map(f =>
      `<button class="otile${seen && !seen.has(f.path) ? " new" : ""}" data-out="${esc(f.path)}" data-key="${esc(s.key)}" title="${esc(f.path)}">
        ${fileIcon(f.name, 22)}<span class="ot-n">${esc(f.name)}</span><span class="ot-t num">${esc((f.t || "").slice(5, 16).replace("T", " "))}</span></button>`).join("")}</div></div>`;
  }
  return html;
}
