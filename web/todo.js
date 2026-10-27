// Questions and to-dos: one page across projects. A memo typed or pasted at the top is split into items and filed
// under a project and a theme (Claude Code on this computer does the sorting); the list lives in one file on the
// [todo] host so every desktop sees the same. Checked items move to the finished list (shown on request). Analyses
// that look related are suggested under each item; confirming one links it, and a link opens that analysis.

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cut = (s, n) => [...String(s || "")].length > n ? [...String(s)].slice(0, n - 1).join("") + "…" : String(s || "");
const day = iso => (iso || "").slice(5, 10).replace("-", ".");

// words for "looks related": Korean particles and endings off, short and common words out
const STOP = new Set(["the", "and", "for", "with", "what", "how", "why", "확인", "하기", "보기", "정리", "분석", "결과", "데이터", "다시", "있나", "있는지",
  "어떻게", "무엇", "때문", "관련", "위해", "대한", "그리고", "하는", "있음", "없음", "같은", "다음", "이번", "기준"]);
const PARTICLE = /(으로|에서|까지|부터|하고|이다|인가|인지|은|는|이|가|을|를|에|의|로|와|과|도|만)$/;
const terms = s => new Set(String(s || "").toLowerCase().split(/[^a-z0-9가-힣]+/)
  .map(w => (w.length > 2 && /[가-힣]$/.test(w) ? w.replace(PARTICLE, "") : w)).filter(w => w.length >= 2 && !STOP.has(w)));
function related(text, a) {
  const q = terms(text), t = terms(a.text);
  let score = 0;
  for (const w of q) if (t.has(w) || (w.length >= 4 && [...t].some(x => x.length >= 4 && (x.startsWith(w) || w.startsWith(x))))) score += w.length >= 5 ? 1.5 : 1;
  return score;
}

export class Todos {
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;   // { hostColor, analyses(project) -> [{id, label, host, date, text}], openAnalysis(project, id), demo }
    this.kind = "all";
    this.showDone = false;
    this.seen = null;       // item ids already drawn (new ones slide in)
    this.pending = new Map(); // id -> fields changed here and not yet confirmed by the store
    this.editing = null;
    try { this.showDone = localStorage.getItem("fw-todo-done") === "1"; this.kind = localStorage.getItem("fw-todo-kind") || "all"; } catch (e) {}
    root.innerHTML = `<div class="td-page">
      <div class="td-top">
        <div class="td-title"><h1>질문과 할 일</h1><p class="td-where"></p></div>
        <form class="td-cap" autocomplete="off">
          <textarea rows="3" placeholder="생각난 질문이나 할 일, 회의 메모를 그대로 적거나 붙여 넣으세요. 항목으로 나눠 프로젝트와 테마에 넣습니다."></textarea>
          <div class="td-capbar"><span class="td-note"></span><span class="td-hint">⌘/Ctrl + Enter</span><button type="submit">정리해서 넣기</button></div>
        </form>
        <div class="td-tools">
          <div class="td-seg" role="group" aria-label="종류"><button data-kind="all">모두</button><button data-kind="question">질문</button><button data-kind="todo">할 일</button></div>
          <label class="td-toggle"><input type="checkbox" class="td-done-toggle"><span></span>완료한 것도 보기</label>
          <button class="td-review" data-review title="회의·메모에서 온 항목 중 그 뒤 분석 보고서로 처리된 것을 찾아 완료로 표시">처리된 것 확인</button>
          <span class="td-count"></span>
        </div>
      </div>
      <div class="td-grid"></div></div>`;
    this.grid = root.querySelector(".td-grid");
    this.form = root.querySelector(".td-cap");
    this.area = this.form.querySelector("textarea");
    root.querySelector(".td-done-toggle").checked = this.showDone;
    this.form.addEventListener("submit", e => { e.preventDefault(); this.capture(); });
    this.area.addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.capture(); } });
    root.addEventListener("click", e => this.click(e));
    root.addEventListener("change", e => {
      if (e.target.classList.contains("td-done-toggle")) {
        this.showDone = e.target.checked;
        try { localStorage.setItem("fw-todo-done", this.showDone ? "1" : "0"); } catch (err) {}
        this.paint();
      }
    });
    root.addEventListener("keydown", e => {
      const t = e.target.closest(".td-text[contenteditable]");
      if (t && e.key === "Enter") { e.preventDefault(); t.blur(); }
      if (t && e.key === "Escape") { t.textContent = t.dataset.orig; t.blur(); }
    });
    root.addEventListener("focusout", e => {
      const t = e.target.closest(".td-text[contenteditable]");
      if (!t) return;
      t.removeAttribute("contenteditable");
      const text = t.textContent.trim();
      if (text && text !== t.dataset.orig) this.change(t.closest("[data-id]").dataset.id, { text });
    });
  }

  update(st) {
    this.st = st;
    this.paint();
  }

  items() {
    const store = (this.st.todo?.items || []).map(it => ({ ...it, ...(this.pending.get(it.id) || {}) }));
    for (const [id, f] of this.pending) {   // confirmed by the store: forget the local copy
      const it = (this.st.todo?.items || []).find(x => x.id === id);
      if (it && Object.entries(f).every(([k, v]) => JSON.stringify(k === "done" ? !!it.done : it[k]) === JSON.stringify(k === "done" ? !!v : v))) this.pending.delete(id);
    }
    return store;
  }

  paint() {
    if (!this.st) return;
    const T = this.st.todo || {}, projects = (this.st.projects || []).map(p => p.name);
    const where = this.root.querySelector(".td-where");
    const imp = T.importing, notes = Object.keys(T.sources || {}).length, rv = T.reviewing;
    const auto = (T.items || []).filter(i => i.evidence).length;
    where.textContent = !T.host ? "config.ini 에 [todo] host = <호스트 이름> 을 넣으면 목록을 그 서버에 둡니다"
      : T.error ? `${T.host} 에 연결되지 않음 · ${T.t ? "마지막으로 읽은 목록" : "목록을 아직 못 읽음"}`
      : `${T.host} 에 저장 · 회의록·코멘트 ${notes}개에서 가져옴${imp?.pending ? ` · ${imp.pending}개 읽는 중` : ""}`
        + (rv?.running ? " · 처리된 것 확인 중" : auto ? ` · 보고서로 처리 확인 ${auto}개` : "");
    this.root.querySelector(".td-review").disabled = !!rv?.running;
    where.classList.toggle("bad", !!T.error || !T.host);
    this.root.querySelectorAll(".td-seg button").forEach(b => b.classList.toggle("on", b.dataset.kind === this.kind));
    const all = this.items(), open = all.filter(it => !it.done);
    this.root.querySelector(".td-count").textContent = `열린 질문 ${open.filter(i => i.kind === "question").length} · 할 일 ${open.filter(i => i.kind === "todo").length} · 완료 ${all.length - open.length}`;
    const fresh = this.seen ? new Set(all.map(i => i.id).filter(id => !this.seen.has(id))) : new Set();
    this.seen = new Set(all.map(i => i.id));
    const show = all.filter(it => (this.showDone || !it.done) && (this.kind === "all" || it.kind === this.kind));
    const groups = [...(show.some(i => !i.project || !projects.includes(i.project)) ? [null] : []), ...projects];
    const html = groups.map(p => this.projectHtml(p, show.filter(i => p ? i.project === p : !i.project || !projects.includes(i.project)), fresh, projects)).join("");
    if (this.grid.dataset.h !== html) {
      this.grid.innerHTML = html;
      this.grid.dataset.h = html;
    }
  }

  projectHtml(p, items, fresh, projects) {
    const backlog = p ? this.backlog(p) : [], log = p ? this.questionLog(p) : [];
    if (!items.length && !backlog.length && !log.length && p) return `<section class="td-proj quiet"><h2>${esc(p)}</h2><p class="td-empty">아직 적어 둔 것이 없습니다</p></section>`;
    const analyses = p ? this.opts.analyses(p) : [];
    const themes = new Map();
    for (const it of items) {
      const k = it.theme || "테마 없음";
      if (!themes.has(k)) themes.set(k, []);
      themes.get(k).push(it);
    }
    const ordered = [...themes].sort((a, b) => b[1].filter(i => !i.done).length - a[1].filter(i => !i.done).length);
    const open = items.filter(i => !i.done);
    return `<section class="td-proj${p ? "" : " inbox"}"><h2>${p ? esc(p) : "어느 프로젝트인지 모름"}
        <span>${p ? `질문 ${open.filter(i => i.kind === "question").length} · 할 일 ${open.filter(i => i.kind === "todo").length}` : "옮길 프로젝트를 고르세요"}</span></h2>
      ${ordered.map(([theme, list]) => `<div class="td-theme"><h3>${esc(theme)}<b>${list.filter(i => !i.done).length}</b></h3>
        <ul>${list.sort((a, b) => !!a.done - !!b.done || (b.created || "").localeCompare(a.created || "")).map(it => this.itemHtml(it, analyses, fresh, projects)).join("")}</ul></div>`).join("")}
      ${backlog.length && this.kind !== "question" ? `<div class="td-theme backlog"><h3>분석 백로그<small>서버 · 읽기 전용</small><b>${backlog.length}</b></h3><ul>${backlog.map(b =>
        `<li class="td-item ro${b.priority ? "" : " np"}">${b.priority ? `<span class="td-pri ${esc(b.priority)}">${esc(b.priority)}</span>` : ""}<div class="td-body"><p class="td-text">${esc(b.text)}</p>
          ${b.id ? `<div class="td-meta">${esc(b.id)}</div>` : ""}</div></li>`).join("")}</ul></div>` : ""}
      ${log.length && this.kind !== "todo" ? this.logHtml(log) : ""}</section>`;
  }

  itemHtml(it, analyses, fresh, projects) {
    const byId = new Map(analyses.map(a => [a.id, a]));
    const links = (it.links || []).map(id => byId.get(id) || { id, label: id.split(/[/:]/).pop(), host: null });
    const sugg = it.done ? [] : analyses.filter(a => !(it.links || []).includes(a.id) && !(it.dismissed || []).includes(a.id))
      .map(a => [a, related(it.text + " " + (it.theme || ""), a)]).filter(([, s]) => s >= 2).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([a]) => a);
    const chip = (a, cls) => `<span class="td-an ${cls}" data-an="${esc(a.id)}">${a.host ? `<i style="background:${this.opts.hostColor(a.host)}"></i>` : ""}
      <button class="td-open" data-open="${esc(a.id)}" title="${esc(a.label)}">${esc(cut(a.label, 34))}</button>${a.date ? `<time>${esc(day(a.date))}</time>` : ""}
      ${cls === "sug" ? `<button class="td-yes" data-link="${esc(a.id)}" title="이 질문과 연결">연결</button><button class="td-no" data-dismiss="${esc(a.id)}" title="관련 없음" aria-label="관련 없음">×</button>`
        : `<button class="td-no" data-unlink="${esc(a.id)}" title="연결 끊기" aria-label="연결 끊기">×</button>`}</span>`;
    const editing = this.editing === it.id;
    return `<li class="td-item ${it.kind}${it.done ? " done" : ""}${fresh.has(it.id) ? " fresh" : ""}" data-id="${esc(it.id)}">
      <button class="td-check" data-check aria-label="${it.done ? "다시 열기" : "완료"}" aria-pressed="${!!it.done}"><svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="7.2"/><path d="M5.6 9.2l2.3 2.3 4.4-4.9"/></svg></button>
      <div class="td-body">
        <p class="td-text" title="두 번 눌러 고치기">${esc(it.text)}</p>
        <div class="td-meta"><span class="td-kind">${it.kind === "question" ? "질문" : "할 일"}</span>${it.source ? this.sourceHtml(it) : day(it.created)}${it.evidence ? `<button class="td-ev"${it.evidence.id.startsWith("q:") ? "" : ` data-open="${esc(it.evidence.id)}"`} title="${esc((it.evidence.why || "") + " — " + it.evidence.title)}">처리됨 · ${esc(day(it.evidence.date))} ${esc(cut(it.evidence.title, 22))}</button>`
          : it.done ? ` · ${day(it.done)} 완료` : ""}<span class="td-id">${esc(it.ref || it.id)}</span>
          <button class="td-more" data-edit>${editing ? "닫기" : "옮기기"}</button></div>
        ${editing ? `<div class="td-edit"><select data-f="project"><option value="">어느 프로젝트인지 모름</option>${projects.map(p => `<option${p === it.project ? " selected" : ""}>${esc(p)}</option>`).join("")}</select>
          <input data-f="theme" value="${esc(it.theme || "")}" placeholder="테마" list="td-themes-${esc(it.id)}"><datalist id="td-themes-${esc(it.id)}">${[...new Set(this.items().filter(x => x.project === it.project && x.theme).map(x => x.theme))].map(t => `<option value="${esc(t)}">`).join("")}</datalist>
          <select data-f="kind"><option value="question"${it.kind === "question" ? " selected" : ""}>질문</option><option value="todo"${it.kind === "todo" ? " selected" : ""}>할 일</option></select>
          <button data-save>저장</button><button class="danger" data-delete>지우기</button></div>` : ""}
        ${links.length || sugg.length ? `<div class="td-links">${links.map(a => chip(a, "linked")).join("")}${sugg.length ? `<span class="td-sl">관련 있어 보임</span>${sugg.map(a => chip(a, "sug")).join("")}` : ""}</div>` : ""}
      </div></li>`;
  }

  // the note an imported item came from, as this computer sees it (the same Obsidian note has another path elsewhere)
  sourceHtml(it) {
    const src = it.source, [proj, ...rest] = (src.key || "").split(":"), rel = rest.join(":");
    let host = null, path = null;
    const p = (this.st.projects || []).find(x => x.name === proj);
    for (const [h, folders] of Object.entries(p?.folders || {}))
      for (const f of folders) for (const n of this.st.inventory?.[h]?.folders?.[f]?.notes || []) if (n.rel === rel) { host = h; path = n.path; }
    const label = `${day(src.date)} ${cut(src.title || rel.split("/").pop(), 22)}`;
    if (!path) return `<span class="td-src" title="${esc(rel)}">${esc(label)}</span>`;
    const local = (this.st.hosts || []).find(h => h.name === host)?.type === "local";
    const href = local && /obsidian/i.test(path) ? "obsidian://open?path=" + encodeURIComponent(path)   // a vault note opens in Obsidian
      : "/api/file?" + new URLSearchParams({ host, path });
    return `<a class="td-src" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(rel)} 열기">${esc(label)}</a>`;
  }

  // the project's question log on the server (claude-daily-log/QUESTIONS.md): read only, with its own status and verdicts
  questionLog(p) {
    const proj = (this.st.projects || []).find(x => x.name === p), out = [];
    for (const [host, folders] of Object.entries(proj?.folders || {}))
      for (const f of folders) for (const q of this.st.inventory?.[host]?.folders?.[f]?.questions || []) if (!out.some(x => x.id === q.id)) out.push(q);
    return out;
  }

  logHtml(log) {
    const VK = { 지지: "ok", 기각: "no", 미결: "open", 판정보류: "hold", 철회: "no" };
    const shown = log.filter(q => this.showDone || q.status !== "closed")
      .sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
    const open = log.filter(q => q.status !== "closed").length;
    return `<div class="td-theme qlog"><h3>질문 기록<small>서버 · 검정과 판정이 쌓이는 곳</small><b>${open}</b></h3><ul>${shown.map(q => {
      const stale = parseInt(q.stale) || 0;
      return `<li class="td-item ro ql${q.status === "closed" ? " done" : ""}"><span class="td-qid">${esc(q.id)}</span><div class="td-body"><p class="td-text">${esc(q.text)}</p>
        <div class="td-meta">${q.verdict && q.verdict !== "—" ? `<span class="td-vd ${VK[q.verdict] || ""}">${esc(q.verdict)}</span>` : `<span class="td-vd">판정 없음</span>`}
          ${q.flipped ? `<span class="td-flip" title="같은 질문 안에서 판정이 뒤집혔음">⚠ 뒤집힘</span>` : ""}
          ${q.tests && q.tests !== "—" ? `검정 ${esc(q.tests)}` : "검정 전"}${q.updated ? ` · ${esc(q.updated.slice(5).replace("-", "."))} 갱신` : ""}
          ${stale >= 30 ? `<span class="td-stale">${stale}일째 그대로</span>` : ""}${q.status === "closed" ? " · 닫힘" : ""}</div></div></li>`;
    }).join("")}</ul></div>`;
  }

  backlog(p) {
    const proj = (this.st.projects || []).find(x => x.name === p), out = [];
    for (const [host, folders] of Object.entries(proj?.folders || {}))
      for (const f of folders) for (const b of this.st.inventory?.[host]?.folders?.[f]?.backlog || [])
        if (!out.some(x => x.text === (b.text || b))) out.push(typeof b === "string" ? { text: b } : b);
    return out;
  }

  // ── changes ───────────────────────────────────────────────────────────
  async send(op) {
    if (this.opts.demo) return this.demoApply(op);
    const r = await fetch("/api/todo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(op) });
    const body = await r.json().catch(() => ({ ok: false, error: "응답을 읽지 못함" }));
    if (!body.ok) throw new Error(body.error || "실패");
    return body;
  }

  change(id, fields) {
    this.pending.set(id, { ...(this.pending.get(id) || {}), ...fields });
    this.paint();
    this.send({ do: "update", id, set: fields }).catch(e => { this.pending.delete(id); this.note(e.message, true); this.paint(); });
  }

  async capture() {
    const text = this.area.value.trim();
    if (!text || this.form.classList.contains("busy")) return;
    this.form.classList.add("busy");
    this.note("항목으로 나눠 프로젝트와 테마를 고르는 중…");
    try {
      const r = await this.send({ do: "capture", text });
      this.area.value = "";
      this.note(r.note || `${r.added?.length || 0}개를 넣었습니다`, !!r.note);
    } catch (e) {
      this.note(e.message, true);
    } finally {
      this.form.classList.remove("busy");
    }
  }

  note(text, bad) {
    const n = this.root.querySelector(".td-note");
    n.textContent = text;
    n.classList.toggle("bad", !!bad);
    clearTimeout(this.noteTimer);
    if (!this.form.classList.contains("busy")) this.noteTimer = setTimeout(() => { n.textContent = ""; }, 6000);
  }

  click(e) {
    const t = e.target, li = t.closest("[data-id]"), id = li?.dataset.id;
    if (t.closest("[data-review]")) {
      this.note("회의·메모 항목을 그 뒤 분석 보고서와 맞춰 보는 중… (몇 분 걸릴 수 있음)");
      return this.send({ do: "review" }).catch(e => this.note(e.message, true));
    }
    const k = t.closest("[data-kind]");
    if (k) { this.kind = k.dataset.kind; try { localStorage.setItem("fw-todo-kind", this.kind); } catch (err) {} return this.paint(); }
    const open = t.closest("[data-open]");
    if (open) {
      const proj = this.items().find(i => i.id === id)?.project;
      return this.opts.openAnalysis(proj, open.dataset.open);
    }
    if (!id) return;
    const it = this.items().find(i => i.id === id);
    if (t.closest("[data-check]")) {
      if (!it.done && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        li.classList.add("checking");   // the tick draws and the line strikes through before it leaves the list
        return setTimeout(() => this.change(id, { done: true }), 650);
      }
      return this.change(id, { done: it.done ? null : true });
    }
    if (t.closest("[data-link]")) return this.change(id, { links: [...(it.links || []), t.closest("[data-link]").dataset.link] });
    if (t.closest("[data-unlink]")) return this.change(id, { links: (it.links || []).filter(x => x !== t.closest("[data-unlink]").dataset.unlink) });
    if (t.closest("[data-dismiss]")) return this.change(id, { dismissed: [...(it.dismissed || []), t.closest("[data-dismiss]").dataset.dismiss] });
    if (t.closest("[data-edit]")) { this.editing = this.editing === id ? null : id; return this.paint(); }
    if (t.closest("[data-save]")) {
      const f = n => li.querySelector(`[data-f="${n}"]`).value.trim();
      this.editing = null;
      return this.change(id, { project: f("project") || null, theme: f("theme") || null, kind: f("kind") });
    }
    if (t.closest("[data-delete]")) {
      this.editing = null;
      this.pending.delete(id);
      if (this.st.todo?.items) this.st.todo.items = this.st.todo.items.filter(i => i.id !== id);
      this.paint();
      return this.send({ do: "delete", id }).catch(err => this.note(err.message, true));
    }
    const text = t.closest(".td-text");
    if (text && e.detail === 2 && !li.classList.contains("ro")) {
      text.dataset.orig = text.textContent;
      text.setAttribute("contenteditable", "plaintext-only");
      text.focus();
    }
  }

  demoApply(op) {   // ?demo: the list lives in the page only
    const T = this.st.todo, now = new Date().toISOString();
    if (op.do === "capture") {
      const items = op.text.split(/\n+/).map(s => s.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean);
      const ids = items.map(text => {
        const id = "Q-" + String(T.next++).padStart(4, "0");
        T.items.push({ id, text, kind: /[?？]$/.test(text) ? "question" : "todo", project: null, theme: null, created: now, done: null, links: [], dismissed: [] });
        return id;
      });
      this.paint();
      return Promise.resolve({ ok: true, added: ids, note: "데모: 분류 없이 넣었습니다" });
    }
    const it = T.items.find(i => i.id === op.id);
    if (op.do === "update" && it) for (const [k, v] of Object.entries(op.set)) it[k] = k === "done" && v === true ? now : v;
    if (op.do === "delete") T.items = T.items.filter(i => i.id !== op.id);
    this.paint();
    return Promise.resolve({ ok: true });
  }
}
