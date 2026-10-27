#!/usr/bin/env python3
"""follow_wollof inventory: what data each project folder holds, for the dashboard's project view.

Stdlib only, Python 3.6+. Run locally or piped over ssh like agent.py (nothing is installed on the host):
    ssh host 'nice -n 10 python3 - <base64 JSON>' < inventory.py
The argument is a base64 JSON list of {"folder": path, "data": [glob, ...]}. Output is one JSON line:
    {"host": ..., "t": ..., "folders": {path: {"exists", "data", "reports", "findings", "backlog"}}}

data      one entry per category: a child folder of each data root (00_raw_data/01_DNA → "DNA"), with file count,
          size, newest change, file kinds and an estimated sample count. Data roots are the globs given for the
          project, or else the project's child folders named like data, raw_data, 02_data or _cohort. A numbered
          sub-project's own data root (01_ybc_somatic/00_rawdata) becomes one category named after the sub-project.
reports   daily_analysis/<date>/<slug>/ folders and how each went (report_flow): the question (00_WHY.md), the
          data it read (data paths quoted in REPORT.md), its scripts in order, the tables and figures it made, the
          checks in REPORT.md that end in a verdict, and the conclusion (REPORT.md title)
findings  "- [date] text [tag]" lines of RESULTS_DIGEST.md, and "- … → 지지|기각|미결|판정보류" lines of RESEARCH_FLOW.md
backlog   items of analysis_backlog/backlog.md, BACKLOG.md or backlog.md: "### B-001. title" entries when the file
          has them (with their Priority), else open bullet lines
notes     meeting notes, professor comments, feedback trackers and idea memos of the last NOTE_DAYS days (by the date in
          their path, else their change time): where they are and when, for the questions page to pull to-dos from.
          A feedback tracker ("- 260930-F3 · 진행 중 · … text") is read here, item by item with its status and the
          analyses its records point to.
Each folder is walked within a time and file budget; a cut-short category is marked "partial".
"""
import base64
import glob
import json
import os
import re
import socket
import sys
import time

DATA_ROOT = re.compile(r"^(\d+[_-]?)?(raw[_-]?data|data|datasets?|_?cohorts?)$", re.I)
KINDS = {
    "reads": ("fastq", "fq", "bam", "cram", "sam", "pod5", "fast5", "ubam", "sra"),
    "variants": ("vcf", "gvcf", "bcf", "maf", "seg", "bedpe"),
    "tables": ("csv", "tsv", "txt", "xlsx", "xls", "rds", "rdata", "rda", "parquet", "feather", "h5", "h5ad", "hdf5",
               "loom", "mtx", "json", "bed", "bedgraph", "bw", "bigwig", "gct"),
    "reference": ("fa", "fasta", "fna", "gtf", "gff", "gff3", "dict", "2bit"),
    "images": ("png", "jpg", "jpeg", "tif", "tiff", "svs", "ndpi", "czi"),
    "docs": ("pdf", "docx", "doc", "md", "pptx", "html"),
}
KIND_OF = {ext: k for k, exts in KINDS.items() for ext in exts}
SKIP_EXT = ("bai", "crai", "csi", "tbi", "fai", "md5", "idx")      # index files: counted in size, not as kinds
SAMPLE_TAIL = re.compile(r"([._-](r?[12]|l\d{3}|s\d+|sorted|dedup|markdup|recal|bqsr|filtered|final|merged|"
                         r"trimmed|aligned|tumou?r|normal|germline|somatic|pass|norm|ann|vep|snpeff|hg38|grch38|b37))+$", re.I)
FILE_BUDGET, TIME_BUDGET = 400000, 180.0          # per project folder
CAT_FILES, CAT_SECONDS = 40000, 20.0               # per category, so one huge folder cannot starve the rest
NOTE_FILES = ("README.md", "README.txt", "README", "PATH_MAP.md")


def ext_of(name):
    parts = name.lower().split(".")
    while len(parts) > 1 and parts[-1] in ("gz", "bgz", "bz2", "xz", "zst", "zip"):
        parts.pop()
    return parts[-1] if len(parts) > 1 else ""


def first_line(path, limit=140):
    """First prose line of a note: no front matter, headings, tables or HTML comments."""
    try:
        with open(path, encoding="utf-8", errors="ignore") as fh:
            lines = fh.read(20000).splitlines()
    except OSError:
        return None
    in_meta = bool(lines) and lines[0].strip() == "---"
    in_comment = False
    for i, raw in enumerate(lines):
        s = raw.strip()
        if in_meta:
            in_meta = not (i > 0 and s == "---")
            continue
        if "<!--" in s:
            in_comment = "-->" not in s
            continue
        if in_comment:
            in_comment = "-->" not in s
            continue
        if not s or s.startswith(("#", "|", "```", ">", "---")):
            continue
        s = re.sub(r"[*`\[\]]", "", s.lstrip("-* ")).strip()
        if s:
            return s[:limit] + ("…" if len(s) > limit else "")
    return None


def heading(path, limit=100):
    try:
        with open(path, encoding="utf-8", errors="ignore") as fh:
            for line in fh.read(8000).splitlines():
                if line.startswith("# "):
                    return line[2:].strip()[:limit]
    except OSError:
        pass
    return None


class Budget:
    def __init__(self, files=FILE_BUDGET, seconds=TIME_BUDGET, parent=None):
        self.files, self.max, self.end, self.parent = 0, files, time.time() + seconds, parent

    def take(self):
        self.files += 1
        if self.parent:
            self.parent.take()

    def spent(self):
        return self.files >= self.max or time.time() > self.end or bool(self.parent and self.parent.spent())


def walk(top, budget, seen=None, depth=0):
    """Files under top. Symlinked folders are followed (data folders are often links to storage); each real
    folder is entered once, so link loops end."""
    seen = set() if seen is None else seen
    try:
        st = os.stat(top)
        if (st.st_dev, st.st_ino) in seen:
            return
        seen.add((st.st_dev, st.st_ino))
        it = list(os.scandir(top))
    except OSError:
        return
    for e in it:
        if budget.spent():
            return
        if e.name.startswith("."):
            continue
        try:
            if e.is_dir():
                if depth < 10:
                    for f in walk(e.path, budget, seen, depth + 1):
                        yield f
            elif e.is_file():
                budget.take()
                yield e
        except OSError:
            continue


def category(name, root, path, parent, files=None):
    c = {"name": re.sub(r"^\d+[_-]", "", name) or name, "folder": name, "root": root, "path": path,
         "files": 0, "bytes": 0, "newest": 0, "kinds": {}, "exts": {}, "samples": 0, "partial": False}
    budget = Budget(CAT_FILES, CAT_SECONDS, parent)
    stems, dirs = set(), set()
    for e in (files if files is not None else walk(path, budget)):
        if e.name in NOTE_FILES:
            continue
        try:
            st = e.stat()
        except OSError:
            continue
        c["files"] += 1
        c["bytes"] += st.st_size
        c["newest"] = max(c["newest"], st.st_mtime)
        ext = ext_of(e.name)
        if ext in SKIP_EXT:
            continue
        kind = KIND_OF.get(ext, "other")
        k = c["kinds"].setdefault(kind, [0, 0])
        k[0] += 1
        k[1] += st.st_size
        if ext:
            c["exts"][ext] = c["exts"].get(ext, 0) + 1
        if kind in ("reads", "variants"):
            stems.add(SAMPLE_TAIL.sub("", e.name.split(".")[0]))
            dirs.add(os.path.dirname(e.path))
    c["partial"] = budget.spent()
    # one file per sample (P01_R1.fastq.gz), or one folder per sample holding generic names (P01/Aligned.out.bam)
    c["samples"] = max(len(stems), len(dirs) if len(dirs) > 1 else 0)
    c["exts"] = sorted(c["exts"].items(), key=lambda x: -x[1])[:6]
    for n in NOTE_FILES:
        note = first_line(os.path.join(path, n)) if os.path.isdir(path) else None
        if note:
            c["note"] = note
            break
    return c


def subdirs(path):
    try:
        return sorted(e.name for e in os.scandir(path) if e.is_dir() and not e.name.startswith("."))
    except OSError:
        return []


def data_roots(folder, globs):
    """[(root path, sub-project name or None)], each real folder once (`data` is often a link to `02_data`)."""
    found = []
    if globs:
        for g in globs:
            found += [(p, None) for p in sorted(glob.glob(g if os.path.isabs(g) else os.path.join(folder, g))) if os.path.isdir(p)]
    else:
        for n in subdirs(folder):
            if DATA_ROOT.match(n):
                found.append((os.path.join(folder, n), None))
            elif re.match(r"^\d+[_-]", n):   # a numbered sub-project with a data folder of its own
                found += [(os.path.join(folder, n, m), n) for m in subdirs(os.path.join(folder, n)) if DATA_ROOT.match(m)]
    out, seen = [], set()
    for path, sub in found:
        real = os.path.realpath(path)
        if real not in seen:
            seen.add(real)
            out.append((path, sub))
    return out


def scan_data(folder, globs, budget):
    out = []
    for root, sub in data_roots(folder, globs):
        if sub:
            out.append(category(sub, "하위 프로젝트", root, budget))
            continue
        rname = os.path.basename(root.rstrip("/\\"))
        try:
            entries = sorted(os.scandir(root), key=lambda e: e.name)
        except OSError:
            continue
        dirs = [e for e in entries if not e.name.startswith(".") and e.is_dir()]
        loose = [e for e in entries if not e.name.startswith(".") and e.is_file() and e.name not in NOTE_FILES]
        if not dirs:   # a flat data folder is one category
            out.append(category(rname, rname, root, budget, loose))
            continue
        for d in dirs:
            out.append(category(d.name, rname, d.path, budget))
        if loose:
            c = category(rname, rname, root, budget, loose)
            c["name"] = "%s (낱개 파일)" % c["name"]
            out.append(c)
    return out


def scan_reports(folder, limit=260, full=40):
    """daily_analysis/<date>/<slug> and History_Archive/<date>/<slug>, newest first. The newest `full` carry their
    whole flow; older ones only what tells whether a question was dealt with (date, title, question, verdicts)."""
    found = []
    for top in ("daily_analysis", "History_Archive"):
        try:
            days = [e for e in os.scandir(os.path.join(folder, top)) if e.is_dir() and re.match(r"\d{4}-\d{2}-\d{2}", e.name)]
        except OSError:
            continue
        for day in days:
            try:
                found += [(day.name[:10], s, top) for s in os.scandir(day.path) if s.is_dir() and not s.name.startswith((".", "_"))]
            except OSError:
                continue
    found.sort(key=lambda x: (x[0], x[1].name), reverse=True)
    out = []
    for i, (date, s, top) in enumerate(found[:limit]):
        report = os.path.join(s.path, "REPORT.md")
        has = os.path.isfile(report)
        r = {"date": date, "slug": s.name, "path": s.path, "report": has, "title": heading(report) if has else None,
             "mtime": s.stat().st_mtime, "archive": top == "History_Archive"}
        if i < full:
            r.update(report_flow(s.path, folder))
        else:
            r["why"] = first_line(os.path.join(s.path, "00_WHY.md"), 160)
            r["checks"] = [c for c in report_flow_checks(report)][:4]
        out.append(r)
    return out


def report_flow_checks(report):
    text = read_md(report) or ""
    for line in text.splitlines():
        m = re.match(r"\s*[-*]\s+(.+?)\s*→\s*(.+)$", line)
        v = m and VERDICT.search(m.group(2))
        if v:
            yield {"text": re.split(r"(?<=[.。])\s", plain(m.group(1)), 1)[0].rstrip(".")[:90], "verdict": v.group(1), "mixed": False}


def scan_questions(folder):
    """claude-daily-log/QUESTIONS.md, the index of the project's question log: each question with its status,
    latest verdict, how often it was tested, when it last moved, and whether its verdict flipped."""
    text = read_md(os.path.join(folder, "claude-daily-log", "QUESTIONS.md"), 600000)
    out, cols, flipped = {}, None, set()
    for line in (text or "").splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")] if line.startswith("|") else None
        if not cells:
            cols = None
            continue
        if cells[0] == "Q":
            cols = cells
            continue
        if not cols or not re.match(r"Q\d+$", cells[0]) or len(cells) < len(cols) - 1:
            continue
        row = dict(zip(cols, cells))
        if "이전 판정" in cols:
            flipped.add(cells[0])
            continue
        clean = lambda x: plain(re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", x or "")).strip("* ")
        out[cells[0]] = {"id": cells[0], "text": clean(row.get("질문"))[:240], "status": clean(row.get("상태")) or "open",
                         "verdict": clean(row.get("최신 판정")).replace("⚠", "").strip() or None, "tests": clean(row.get("검정")),
                         "updated": clean(row.get("최종갱신")), "stale": clean(row.get("정체"))}
    for q in flipped:
        if q in out:
            out[q]["flipped"] = True
    return sorted(out.values(), key=lambda q: q["id"])


def read_md(path, size=400000):
    try:
        with open(path, encoding="utf-8", errors="ignore") as fh:
            return re.sub(r"<!--.*?-->", "", fh.read(size), flags=re.S)
    except OSError:
        return None


def plain(text):
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)          # [label](link) -> label
    return re.sub(r"[*`]|\[\[|\]\]", "", text).strip()   # underscores stay: they are in file names


def scan_flow(folder):
    """RESEARCH_FLOW.md: "## date · title" blocks whose bullets end in a verdict."""
    text = read_md(os.path.join(folder, "RESEARCH_FLOW.md"), 1500000)
    out, date, block = [], None, None
    for line in (text or "").splitlines():
        m = re.match(r"##\s+(\d{4}-\d{2}-\d{2})\s*[·-]?\s*(.*)", line)
        if m:
            date, block = m.group(1), plain(m.group(2))
            continue
        m = re.match(r"\s*[-*]\s+(.+?)\s*→\s*(지지|기각|미결|판정보류)\s*$", line)
        if m and date:
            out.append({"date": date, "text": plain(m.group(1))[:220], "tag": m.group(2), "section": block})
    return out


SCRIPT_EXT = ("r", "py", "sh", "ipynb", "rmd", "qmd", "nf", "smk", "wdl", "jl")
FIGURE_EXT = ("png", "svg", "pdf", "jpg", "jpeg", "tif", "tiff")
TABLE_EXT = ("tsv", "csv", "txt", "xlsx", "xls", "rds", "rdata", "parquet", "json", "h5ad", "h5", "vcf", "maf", "bed", "gmt")
DATA_HINT = re.compile(r"(^|/)(\d+[_-]?)?(raw[_-]?data|data|datasets?|_?cohorts?)/", re.I)
VERDICT = re.compile(r"(지지|기각|미결|판정보류)")


def files_of(top, limit=600, depth=3):
    """[(relative path, size, mtime)] of an analysis folder, newest last; scripts' own logs included."""
    out = []

    def go(path, d):
        try:
            entries = sorted(os.scandir(path), key=lambda e: e.name)
        except OSError:
            return
        for e in entries:
            if len(out) >= limit or e.name.startswith((".", "__")):
                continue
            try:
                if e.is_dir():
                    if d < depth:
                        go(e.path, d + 1)
                else:
                    st = e.stat()
                    out.append((os.path.relpath(e.path, top).replace(os.sep, "/"), st.st_size, int(st.st_mtime)))
            except OSError:
                continue
    go(top, 0)
    return out


def report_flow(path, project):
    """How one analysis went, read from its folder: question → data → scripts → tables·figures → checks → conclusion."""
    files = files_of(path)
    kind = lambda rel: ext_of(rel.rsplit("/", 1)[-1])
    scripts = [r for r, _, _ in files if kind(r) in SCRIPT_EXT]
    figures = [r for r, _, _ in files if kind(r) in FIGURE_EXT and not r.startswith(("REPORT", "00_"))]
    tables = [r for r, _, _ in files if kind(r) in TABLE_EXT and not r.rsplit("/", 1)[-1].startswith(("sessionInfo", "README"))]
    text = read_md(os.path.join(path, "REPORT.md")) or ""
    inputs = []
    for q in re.findall(r"`([^`\s]+/[^`\s]+)`", text):
        q = q.split("{")[0].rstrip("/,.")
        if DATA_HINT.search("/" + q.lstrip("./")):
            full = q if os.path.isabs(q) else os.path.normpath(os.path.join(project if not q.startswith("..") else path, q))
            if full not in inputs:
                inputs.append(full)
    checks = []
    for line in text.splitlines():
        m = re.match(r"\s*[-*]\s+(.+?)\s*→\s*(.+)$", line)
        v = m and VERDICT.search(m.group(2))
        if v:
            label = re.split(r"(?<=[.。])\s", plain(m.group(1)), 1)[0].rstrip(".")
            checks.append({"text": label[:90], "verdict": v.group(1), "mixed": len(set(VERDICT.findall(m.group(2)))) > 1})
    recent = sorted((f for f in files if f[0] in tables or f[0] in figures), key=lambda f: f[2])[-10:]
    return {"why": first_line(os.path.join(path, "00_WHY.md"), 200), "scripts": scripts[:16], "nscripts": len(scripts),
            "tables": len(tables), "figures": len(figures), "files": len(files), "inputs": inputs[:16],
            "checks": checks[:10], "recent": [r for r, _, _ in recent]}


def scan_findings(folder, limit=12):
    text = read_md(os.path.join(folder, "RESULTS_DIGEST.md"))
    out, section = scan_flow(folder), None
    for line in (text or "").splitlines():
        if line.startswith("## "):
            section = line[3:].strip()
            continue
        m = re.match(r"\s*[-*]\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.+)", line)
        if m:
            body = m.group(2).strip()
            tag = re.search(r"\[(원문|추론|가설)\]\s*$", body)
            out.append({"date": m.group(1), "text": re.sub(r"\s*\[(원문|추론|가설)\]\s*$", "", body)[:220],
                        "tag": tag.group(1) if tag else None, "section": section})
    out.sort(key=lambda f: f["date"], reverse=True)   # stable: within a day the file order stays
    return out[:limit]


def scan_backlog(folder, limit=12):
    for rel in ("analysis_backlog/backlog.md", "BACKLOG.md", "backlog.md", "analysis_backlog/BACKLOG.md"):
        text = read_md(os.path.join(folder, rel), 600000)
        if text is None:
            continue
        lines = text.splitlines()
        entries = [(i, m) for i, l in enumerate(lines) for m in [re.match(r"#{2,4}\s+([A-Z]{1,3}-\d+)[.)]?\s+(.+)", l)] if m]
        if entries:   # "### B-015. ⭐ title" with "- **Priority**: low" below it
            out = []
            for k, (i, m) in enumerate(entries):
                body = lines[i + 1:entries[k + 1][0] if k + 1 < len(entries) else len(lines)]
                pr = next((re.search(r"(high|medium|low)", b, re.I).group(1).lower() for b in body
                           if "priority" in b.lower() and re.search(r"(high|medium|low)", b, re.I)), "medium")
                out.append({"id": m.group(1), "text": plain(m.group(2)).lstrip("⭐ ").strip()[:160], "priority": pr})
            rank = {"high": 0, "medium": 1, "low": 2}
            return sorted(out, key=lambda b: rank[b["priority"]])[:limit]
        out = []
        for line in lines:
            m = re.match(r"\s*[-*]\s+(\[( |x|X)\]\s+)?(.+)", line)
            if not m or (m.group(2) or " ").lower() == "x":
                continue
            item = re.sub(r"[*_`]|\[\[|\]\]", "", m.group(3)).strip()
            if item and not item.startswith("~~"):
                out.append(item[:160])
            if len(out) >= limit:
                break
        return out
    return []


NOTE_DAYS = 180
NOTE_PATH = re.compile(r"(meet|회의|미팅|comment|코멘트|교수님|feedback|피드백|memo|메모|idea|아이디어|todo|할.?일|question|질문|tracker)", re.I)
NOTE_SKIP = re.compile(r"(glossary|stt_|^index\.md$|^themes\.md$|^readme|^claude\.md$|_project_hub|deck_index|corrected|_old)", re.I)
NOTE_PRUNE = {"daily_analysis", "renv", "history_archive", "archive", "analysis_cleanup", "node_modules", "output", "plot",
              "01_scripts", "claude-daily-log", "_incoming", "references", "manuscript"}
TRACKED = re.compile(r"^-\s+(\S+)\s+·\s+(미반영|진행 중|반영함|접음)\s+·\s+(?:요청\s*\d+회[^·]*·\s+)?(.+)$")


def note_date(rel, mtime):
    for m in reversed(list(re.finditer(r"(?<!\d)(20\d{2})-?(\d{2})-?(\d{2})(?!\d)|(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)", rel))):
        y, mo, d = (m.group(1), m.group(2), m.group(3)) if m.group(1) else ("20" + m.group(4), m.group(5), m.group(6))
        if 1 <= int(mo) <= 12 and 1 <= int(d) <= 31:
            return "%s-%s-%s" % (y, mo, d)
    return time.strftime("%Y-%m-%d", time.localtime(mtime))


def parse_tracker(path):
    """A feedback tracker: one line per request with its status; indented lines below record what answered it."""
    text = read_md(path, 600000) or ""
    out, section, base = [], None, os.path.dirname(path)
    for line in text.splitlines():
        if line.startswith("## "):
            section = plain(re.sub(r"\(\[.*?\]\(.*?\)\)", "", line[3:])).strip()
            continue
        m = TRACKED.match(line)
        if m:
            out.append({"ref": m.group(1), "status": m.group(2), "text": plain(m.group(3))[:400], "section": section, "links": []})
        elif out and line.startswith((" ", "\t")):
            for link in re.findall(r"\]\(([^)]+)\)", line):
                full = os.path.normpath(os.path.join(base, link))
                m2 = re.match(r"(.*/daily_analysis/\d{4}-\d{2}-\d{2}/[^/]+)", full.replace(os.sep, "/"))
                if m2 and m2.group(1) not in out[-1]["links"]:
                    out[-1]["links"].append(m2.group(1))
    return out


def scan_notes(folder, limit=60):
    cutoff = time.time() - NOTE_DAYS * 86400
    out = []
    for base, dirs, files in os.walk(folder):
        depth = base[len(folder):].count(os.sep)
        dirs[:] = [] if depth >= 5 else sorted(d for d in dirs if not d.startswith(".") and d.lower() not in NOTE_PRUNE and not DATA_ROOT.match(d))
        md = [f for f in files if f.lower().endswith(".md")]
        summary = [f for f in md if f.lower() == "summary.md"]   # a meeting folder's summary stands for its raw minutes
        for f in summary or md:
            full = os.path.join(base, f)
            rel = os.path.relpath(full, folder).replace(os.sep, "/")
            if NOTE_SKIP.search(f) or not NOTE_PATH.search(rel):
                continue
            try:
                st = os.stat(full)
            except OSError:
                continue
            date = note_date(rel, st.st_mtime)
            if time.mktime(time.strptime(date, "%Y-%m-%d")) < cutoff and st.st_mtime < cutoff:
                continue
            note = {"path": full, "rel": rel, "date": date, "mtime": int(st.st_mtime), "size": st.st_size,
                    "title": heading(full) or f[:-3]}
            if "tracker" in f.lower():
                note["tracker"] = parse_tracker(full)
            out.append(note)
    out.sort(key=lambda n: n["date"], reverse=True)
    return out[:limit]


def scan(folder, globs):
    if not os.path.isdir(folder):
        return {"exists": False}
    budget = Budget()
    return {"exists": True, "data": scan_data(folder, globs, budget), "reports": scan_reports(folder),
            "findings": scan_findings(folder), "backlog": scan_backlog(folder), "notes": scan_notes(folder),
            "questions": scan_questions(folder)}


def main():
    req = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8")) if len(sys.argv) > 1 else []
    out = {"host": socket.gethostname(), "t": time.time(), "folders": {}}
    for r in req:
        try:
            out["folders"][r["folder"]] = scan(os.path.expanduser(r["folder"]), r.get("data") or [])
        except Exception as e:   # one unreadable folder must not hide the others
            out["folders"][r["folder"]] = {"exists": True, "error": repr(e)}
    sys.stdout.buffer.write((json.dumps(out, ensure_ascii=False) + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
