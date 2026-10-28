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
    this.proj = null;          // the project on the right (the index on the left lists them all)
    this.q = "";               // search across every project
    this.full = new Set();     // "project|theme" shown in full instead of its first few
    this.sugOpen = new Set();  // items whose "looks related" suggestions are unfolded
    try {
      this.showDone = localStorage.getItem("fw-todo-done") === "1"; this.kind = localStorage.getItem("fw-todo-kind") || "all";
      this.proj = localStorage.getItem("fw-todo-proj");
    } catch (e) {}
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
          <label class="td-find"><svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
            <input type="search" placeholder="찾기" aria-label="질문·할 일 찾기"></label>
        </div>
      </div>
      <div class="td-split"><nav class="td-index" aria-label="프로젝트와 테마"></nav><div class="td-grid"></div></div></div>`;
    this.grid = root.querySelector(".td-grid");
    this.index = root.querySelector(".td-index");
    root.querySelector(".td-find input").addEventListener("input", e => { this.q = e.target.value.trim().toLowerCase(); this.paint(); });
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
    const all = this.items();
    const fresh = this.seen ? new Set(all.map(i => i.id).filter(id => !this.seen.has(id))) : new Set();
    this.seen = new Set(all.map(i => i.id));
    const q = this.q, hit = it => !q || (it.text + " " + (it.theme || "")).toLowerCase().includes(q);
    const show = all.filter(it => (this.showDone || !it.done) && (this.kind === "all" || it.kind === this.kind) && hit(it));
    const INBOX = "", of = it => it.project && projects.includes(it.project) ? it.project : INBOX;
    const groups = [...(show.some(i => of(i) === INBOX) ? [INBOX] : []), ...projects];
    const by = new Map(groups.map(p => [p, show.filter(i => of(i) === p)]));
    if (!groups.includes(this.proj) || (q && !by.get(this.proj).length)) this.proj = groups.find(p => by.get(p).length) ?? groups[0] ?? null;
    const themesOf = list => {
      const m = new Map();
      for (const it of list) { const k = it.theme || "테마 없음"; if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
      return [...m].sort((a, b) => b[1].filter(i => !i.done).length - a[1].filter(i => !i.done).length || a[0].localeCompare(b[0]));
    };
    const ratio = list => {   // open questions | open to-dos | done, as one thin bar
      const qn = list.filter(i => !i.done && i.kind === "question").length, tn = list.filter(i => !i.done && i.kind === "todo").length, dn = list.length - qn - tn;
      return { qn, tn, dn, bar: list.length ? `<span class="td-bar" aria-hidden="true"><i class="q" style="flex:${qn}"></i><i class="t" style="flex:${tn}"></i><i class="d" style="flex:${dn}"></i></span>` : "" };
    };
    // every project first (each with its question/to-do bar), then the open project's themes to jump between
    const idx = groups.map(p => {
      const list = by.get(p), r = ratio(list), on = p === this.proj;
      return `<button class="td-ip${on ? " on" : ""}${p === INBOX ? " inbox" : ""}" data-tproj="${esc(p)}" aria-current="${on}">
          <span class="nm">${p === INBOX ? "어느 프로젝트인지 모름" : esc(p)}</span><b>${r.qn + r.tn}</b>${r.bar}</button>`;
    }).join("") + (this.proj != null && by.get(this.proj)?.length ? `<h4 class="td-ih">테마</h4><div class="td-it">${themesOf(by.get(this.proj)).map(([t, l]) =>
      `<button data-ttheme="${esc(t)}"><span>${esc(t)}</span><b>${l.filter(i => !i.done).length}</b></button>`).join("")}</div>` : "");
    const tot = ratio(show);
    const head = `<p class="td-legend"><span><i class="q"></i>질문 ${tot.qn}</span><span><i class="t"></i>할 일 ${tot.tn}</span>`
      + `${this.showDone ? `<span><i class="d"></i>완료 ${tot.dn}</span>` : ""}${q ? `<span class="hit">"${esc(this.q)}" 찾은 결과</span>` : ""}</p>`;
    if (this.index.dataset.h !== head + idx) { this.index.innerHTML = head + idx; this.index.dataset.h = head + idx; }
    const html = this.proj == null ? `<p class="td-empty">${q ? "찾는 항목이 없습니다" : "아직 적어 둔 것이 없습니다. 위에 적어 넣어 보세요."}</p>`
      : this.projectHtml(this.proj || null, by.get(this.proj) || [], fresh, projects, themesOf);
    if (this.grid.dataset.h !== html) {
      this.grid.innerHTML = html;
      this.grid.dataset.h = html;
    }
  }

  projectHtml(p, items, fresh, projects, themesOf) {
    const found = x => !this.q || String(x.text || "").toLowerCase().includes(this.q);
    const backlog = p ? this.backlog(p).filter(found) : [], log = p ? this.questionLog(p).filter(found) : [];
    if (!items.length && !backlog.length && !log.length && p) return `<section class="td-proj quiet"><h2>${esc(p)}</h2><p class="td-empty">${this.q ?"이 프로젝트에는 찾는 항목이 없습니다" : "아직 적어 둔 것이 없습니다"}</p></section>`;
    const analyses = p ? this.opts.analyses(p) : [], FEW = 3;
    const open = items.filter(i => !i.done);
    return `<section class="td-proj${p ? "" : " inbox"}"><h2>${p ? esc(p) : "어느 프로젝트인지 모름"}
        <span>${p ? `질문 ${open.filter(i => i.kind === "question").length} · 할 일 ${open.filter(i => i.kind === "todo").length}` : "옮기기로 프로젝트를 고르세요"}</span></h2>
      ${themesOf(items).map(([theme, list]) => {
        const k = (p || "") + "|" + theme, all = this.q || this.full.has(k);
        const sorted = list.sort((a, b) => !!a.done - !!b.done || (b.created || "").localeCompare(a.created || ""));
        const shown = all ? sorted : sorted.slice(0, FEW), rest = sorted.length - shown.length;
        return `<div class="td-theme" data-theme="${esc(theme)}"><h3><span>${esc(theme)}</span><b>${list.filter(i => !i.done).length}</b></h3>
          <ul>${shown.map(it => this.itemHtml(it, analyses, fresh, projects)).join("")}</ul>
          ${rest > 0 ? `<button class="td-moreit" data-full="${esc(k)}">${rest}개 더 보기</button>`
            : !this.q && this.full.has(k) && sorted.length > FEW ? `<button class="td-moreit" data-full="${esc(k)}">접기</button>` : ""}</div>`;
      }).join("")}
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
    return `<li class="td-item ${it.kind}${it.done ? " done" : ""}${fresh.has(it.id) ? " fresh" : ""}" data-id="${esc(it.id)}" aria-label="${it.kind === "question" ? "질문" : "할 일"}">
      <button class="td-check" data-check aria-label="${it.done ? "다시 열기" : "완료"}" aria-pressed="${!!it.done}"><svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="7.2"/><path d="M5.6 9.2l2.3 2.3 4.4-4.9"/></svg></button>
      <div class="td-body">
        <p class="td-text" title="두 번 눌러 고치기">${esc(it.text)}</p>
        <div class="td-meta">${it.source ? this.sourceHtml(it) : `<span>${day(it.created)} 적음</span>`}${it.evidence ? `<button class="td-ev"${it.evidence.id.startsWith("q:") ? "" : ` data-open="${esc(it.evidence.id)}"`} title="${esc((it.evidence.why || "") + " — " + it.evidence.title)}">처리됨 · ${esc(day(it.evidence.date))} ${esc(cut(it.evidence.title, 22))}</button>`
          : it.done ? `<span>${day(it.done)} 완료</span>` : ""}
          ${sugg.length && !this.sugOpen.has(it.id) ? `<button class="td-sugb" data-sug title="이 항목과 관련 있어 보이는 분석">연결 후보 ${sugg.length}</button>` : ""}
          <button class="td-more" data-edit title="${esc(it.ref || it.id)}">${editing ? "닫기" : "옮기기"}</button></div>
        ${editing ? `<div class="td-edit"><select data-f="project"><option value="">어느 프로젝트인지 모름</option>${projects.map(p => `<option${p === it.project ? " selected" : ""}>${esc(p)}</option>`).join("")}</select>
          <input data-f="theme" value="${esc(it.theme || "")}" placeholder="테마" list="td-themes-${esc(it.id)}"><datalist id="td-themes-${esc(it.id)}">${[...new Set(this.items().filter(x => x.project === it.project && x.theme).map(x => x.theme))].map(t => `<option value="${esc(t)}">`).join("")}</datalist>
          <select data-f="kind"><option value="question"${it.kind === "question" ? " selected" : ""}>질문</option><option value="todo"${it.kind === "todo" ? " selected" : ""}>할 일</option></select>
          <button data-save>저장</button><button class="danger" data-delete>지우기</button></div>` : ""}
        ${links.length || (sugg.length && this.sugOpen.has(it.id)) ? `<div class="td-links">${links.map(a => chip(a, "linked")).join("")}${sugg.length && this.sugOpen.has(it.id) ? `<span class="td-sl">관련 있어 보임</span>${sugg.map(a => chip(a, "sug")).join("")}` : ""}</div>` : ""}
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
    const tp = t.closest("[data-tproj]");
    if (tp) {
      this.proj = tp.dataset.tproj;
      try { localStorage.setItem("fw-todo-proj", this.proj); } catch (err) {}
      this.paint();
      return this.root.closest("#todo")?.scrollTo({ top: 0, behavior: "smooth" });
    }
    const tt = t.closest("[data-ttheme]");
    if (tt) {   // jump to that theme and let it glow once so the eye lands on it
      const sec = [...this.grid.querySelectorAll(".td-theme")].find(x => x.dataset.theme === tt.dataset.ttheme);
      if (!sec) return;
      sec.scrollIntoView({ behavior: document.documentElement.classList.contains("calm") ? "auto" : "smooth", block: "start" });
      sec.classList.remove("flash"); void sec.offsetWidth; sec.classList.add("flash");
      return;
    }
    const fl = t.closest("[data-full]");
    if (fl) { const k = fl.dataset.full; if (this.full.has(k)) this.full.delete(k); else this.full.add(k); return this.paint(); }
    if (t.closest("[data-sug]") && id) { this.sugOpen.add(id); return this.paint(); }
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
      if (!it.done && !document.documentElement.classList.contains("calm")) {
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
