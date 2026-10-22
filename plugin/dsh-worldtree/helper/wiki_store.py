# -*- coding: utf-8 -*-
"""
流变·记忆 wiki 存储（v0.2，S1+S2 + 银杏审读修订）
================================================
条目模型（设计文档：docs/流变记忆wiki化_DSH实施方案.md v0.2）：
  条目五要件 = 家族归宿 / 内容介绍 / 正文 / 修订记录（含贡献者）/ 梯度稀释检查点
  森林结构 = 条目可嵌套，家族归宿 = 到根的有序路径（结构化 tag）

家族规则 v0.2（银杏审读定稿）：
  · 物化全路径列 full_path：根条目（familyPath == slug）full = slug，子条目 full = 父full + '/' + slug
  · 层级/子树查询全部走 full_path（= 等于父full 为直系子；LIKE 父full/% 为子树）
  · **slug 不可变**（v0）：改标题/内容用 update；改名+级联列 v1
  · status 词表：draft（整理中）/ stable（定稿）/ obsolete（废弃）
  · move = 改挂（子树批量跟随，逐条记修订）

调用协议（与 memory_query.py 同款）：stdin 喂 JSON，stdout 吐 JSON。
  {"op":"create","slug":..,"familyPath":..,"title":..,"intro":..,"content":..,"status":..,
   "sessionHash":..,"workspace":..,"sourceContributor":?}
  {"op":"update","slug":..,"content":?,"intro":?,"title":?,"status":?,"summary":?,同上三键}
  {"op":"get","slug":..}
  {"op":"tree"}                                   → 森林（roots/orphans/children 平面清单）
  {"op":"list","familyPrefix":"自然/水果"}          → 子树清单
  {"op":"move","slug":..,"newFamilyPath":..,同上三键}  → 改挂（目标家族须已存在）
  {"op":"rollback","slug":..,"time":..,同上三键}       → 按时间定位检查点恢复

归因（〈升格流落树约定〉规则 7，2026-10-01 定稿）：
  · 执行者 executor 由 `sessionHash` 查注册中心 bindings 派生，**不可由传参覆盖**；
    未命中 / 无会话 / 注册中心离线 → 回退 `workspace` 并标 workspace-fallback（summary 自动标注）；
  · 内容来源者 sourceContributor 显式可选（旧键 `contributor` 保留为别名）；
  · 两者落库为独立列；legacy `contributor` 列老行冻结、新行写执行者作兼容镜像。
"""
import json, sys, os, sqlite3, time, unicodedata, hashlib, re

CHECKPOINT_THRESHOLDS_MIN = [5, 10, 30, 60, 360, 720, 1440, 10080]  # 5m/10m/30m/1h/6h/12h/24h/7d
MAX_CHECKPOINTS = len(CHECKPOINT_THRESHOLDS_MIN)  # 8
STATUSES = ("draft", "stable", "obsolete")
REGISTRY_DB = os.path.expanduser("~/.dsh/liubian-infra/registry.db")

_registry_cache = None

def resolve_contributor(name):
    """独特名解析：查注册中心拿短ID，格式「名字 #短ID」。注册中心离线或查不到 → 原样返回。"""
    global _registry_cache
    if _registry_cache is None:
        _registry_cache = {}
        try:
            rc = sqlite3.connect(f"file:{REGISTRY_DB}?mode=ro", uri=True, timeout=5)
            for row in rc.execute("SELECT name, short_id FROM identities"):
                _registry_cache[row[0]] = row[1]
            rc.close()
        except Exception:
            pass  # 注册中心离线 → 空缓存，降级原样返回
    sid = _registry_cache.get(name)
    if sid:
        return f"{name} #{sid}"
    return name


_binding_cache = None


def _bindings():
    """只读注册中心 bindings 表：session_hash → name。
    与基建 v0.2 的 bindings 表同源（契约 v1 §3 只读 URI、§5.1 会话哈希派生同源）。
    注册中心离线/表不存在 → 空缓存，调用方走工作区兜底。"""
    global _binding_cache
    if _binding_cache is None:
        _binding_cache = {}
        try:
            rc = sqlite3.connect(f"file:{REGISTRY_DB}?mode=ro", uri=True, timeout=5)
            for row in rc.execute("SELECT session_hash, name FROM bindings"):
                _binding_cache[row[0]] = row[1]
            rc.close()
        except Exception:
            pass
    return _binding_cache


def resolve_executor(session_hash, workspace):
    """执行者两级解析（〈升格流落树约定〉规则 7 定稿，2026-10-01）：
      ① 会话哈希命中注册中心绑定 → 用该名字，标记 binding；
      ② 未命中 / 无会话上下文 / 注册中心离线 → 回退工作区名，标记 workspace-fallback。
    **执行者不可由显式传参覆盖**——冒名在结构上不可能（银杏 #12 加固）。
    返回 (格式化执行者, 三态标记)。"""
    sh = str(session_hash or "").strip()
    if sh:
        name = _bindings().get(sh)
        if name:
            return resolve_contributor(name), "binding"
    return resolve_contributor(str(workspace or "").strip() or "未知"), "workspace-fallback"


FALLBACK_NOTE = "贡献者按工作区兜底"


def annotate_fallback(summary, resolved):
    """兜底归因要在账目上自己标出来（玉簪提的：可疑归因不能长得像正常归因）。
    只在 workspace-fallback 时追加，且幂等——不重复叠加。"""
    s = str(summary or "").strip()
    if resolved != "workspace-fallback":
        return s
    if FALLBACK_NOTE in s:
        return s
    return (s + "｜" + FALLBACK_NOTE) if s else FALLBACK_NOTE


def attribution(req):
    """归因三件套：执行者（会话派生，不可覆盖）/ 三态标记 / 内容来源者（显式可选）。
    工具参数 `contributor` 保留为 source_contributor 的**别名**（不破坏既有调用形态）。"""
    executor, marker = resolve_executor(req.get("sessionHash"), req.get("workspace"))
    raw_source = str(req.get("sourceContributor") or req.get("contributor") or "").strip()
    source = resolve_contributor(raw_source) if raw_source else ""
    return executor, marker, source

DDL = [
    """CREATE TABLE IF NOT EXISTS wiki_pages (
        slug TEXT PRIMARY KEY,
        family_path TEXT NOT NULL,
        full_path TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        intro TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        revisions INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS wiki_revisions (
        slug TEXT NOT NULL,
        rev INTEGER NOT NULL,
        time INTEGER NOT NULL,
        contributor TEXT NOT NULL,
        action TEXT NOT NULL,
        summary TEXT,
        content TEXT NOT NULL,
        PRIMARY KEY (slug, rev))""",
    """CREATE TABLE IF NOT EXISTS wiki_checkpoints (
        slug TEXT NOT NULL,
        slot INTEGER NOT NULL,
        time INTEGER NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (slug, slot))""",
    """CREATE INDEX IF NOT EXISTS idx_wiki_family ON wiki_pages(family_path)""",
    """CREATE INDEX IF NOT EXISTS idx_wiki_full ON wiki_pages(full_path)""",
]

# 归因二分（规则 7）：贡献者/执行者拆列，**加法式迁移**——老行原样冻结、不重写不删。
# legacy `contributor` 列保持 NOT NULL：新行写执行者作兼容镜像（未升级的读取方仍能读到人）。
REVISION_OPT_COLUMNS = (("executor", "TEXT"), ("source_contributor", "TEXT"), ("executor_resolved", "TEXT"))
_REV_COLS = None


def revision_columns(conn):
    """wiki_revisions 的实际列集合（进程内缓存；迁移失败也能安全降级到老列写入）。"""
    global _REV_COLS
    if _REV_COLS is None:
        _REV_COLS = {r[1] for r in conn.execute("PRAGMA table_info(wiki_revisions)")}
    return _REV_COLS


def ensure_revision_columns(conn):
    """幂等加法迁移：缺列就补。失败只警告不阻断（写入侧会按实际列自适应）。"""
    for name, typ in REVISION_OPT_COLUMNS:
        if name not in revision_columns(conn):
            try:
                conn.execute(f"ALTER TABLE wiki_revisions ADD COLUMN {name} {typ}")
                _REV_COLS.add(name)
            except Exception as e:
                sys.stderr.write(f"[wiki_store] 列迁移失败 {name}: {e}\n")


def out(obj):
    # default=str：任何漏网的非序列化对象（如 Row）降级为字符串，不让整个工具调用炸掉
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str))
    sys.stdout.flush()


def connect():
    db = os.environ.get("LU_DB", "")
    if not db or not os.path.isfile(db):
        out({"ok": False, "error": "liubian.db not found: " + db})
        sys.exit(0)
    conn = sqlite3.connect(db, timeout=20)
    conn.row_factory = sqlite3.Row  # 命名访问——杜绝列序错位（v0.2.2 注入块字段错位教训）
    for stmt in DDL:  # 幂等建表
        conn.execute(stmt)
    ensure_revision_columns(conn)  # 幂等加法迁移（归因二分）
    conn.commit()
    return conn


def full_of(family, slug):
    """全路径：根条目（familyPath == slug）full = slug，不重复拼接（银杏审读①）。"""
    return slug if family == slug else family + "/" + slug


# ── 梯度稀释检查点：时间稀释保留规则 ─────────────────────────────────────
# 全部候选快照（含刚被替换的旧正文）按时间降序，贪心保留：
#   保留最新一份；此后每份必须与上一份保留快照相距 ≥ 下一档阈值（5m/10m/30m/...）；
#   最多保留 MAX_CHECKPOINTS 份，其余丢弃（稀释 = 存储有界）。


def retain(snaps_desc):
    kept = []
    last_t = None
    for s in snaps_desc:
        if not kept:
            kept.append(s)
            last_t = s["time"]
            continue
        if len(kept) > MAX_CHECKPOINTS:
            break
        th_min = CHECKPOINT_THRESHOLDS_MIN[len(kept) - 1]
        if last_t - s["time"] >= th_min * 60000:
            kept.append(s)
            last_t = s["time"]
    return kept[:MAX_CHECKPOINTS]


def load_checkpoints(conn, slug):
    rows = conn.execute(
        "SELECT slot, time, content FROM wiki_checkpoints WHERE slug=? ORDER BY time DESC",
        (slug,)).fetchall()
    return [{"time": t, "content": c} for _, t, c in rows]


def save_checkpoints(conn, slug, kept):
    conn.execute("DELETE FROM wiki_checkpoints WHERE slug=?", (slug,))
    for i, s in enumerate(kept):
        conn.execute(
            "INSERT INTO wiki_checkpoints(slug, slot, time, content) VALUES(?,?,?,?)",
            (slug, i, s["time"], s["content"]))


def on_update_cascade(conn, slug, prev_content, prev_time, now_ms):
    """编辑提交时调用：把被替换的旧正文送入稀释检查点体系。"""
    snaps = load_checkpoints(conn, slug)
    snaps.sort(key=lambda s: -s["time"])
    if snaps and snaps[0]["content"] == prev_content:
        return  # 内容没变不重复入槽
    snaps.insert(0, {"time": prev_time, "content": prev_content})
    kept = retain(snaps)
    save_checkpoints(conn, slug, kept)


def log_revision(conn, slug, rev, now, executor, action, summary, content,
                 executor_resolved="", source_contributor=""):
    """写修订账目。归因二分（〈升格流落树约定〉规则 7）：
      · executor —— 永远由调用会话绑定派生（resolve_executor），**不可覆盖**；
      · source_contributor —— 显式可选（升格流原作者/被引用者），可空；
      · legacy `contributor` 列 —— 老行原样冻结；**新行写执行者作兼容镜像**，
        免得未升级的读取方读到空白（语义边界见规则 7，逐行判读、不做自动回填）。
    按实际列自适应：迁移失败或旧库也能写入（少写可选列，不报错）。"""
    fields = {
        "slug": slug, "rev": rev, "time": now,
        "contributor": executor,                      # legacy 兼容镜像
        "executor": executor,
        "source_contributor": source_contributor or None,
        "executor_resolved": executor_resolved or None,
        "action": action, "summary": summary, "content": content,
    }
    base = ("slug", "rev", "time", "contributor", "action", "summary", "content")
    have = revision_columns(conn)
    names = list(base) + [c for c, _ in REVISION_OPT_COLUMNS if c in have]
    conn.execute(
        "INSERT INTO wiki_revisions(%s) VALUES(%s)" % (",".join(names), ",".join("?" * len(names))),
        tuple(fields[n] for n in names))


def next_rev(conn, slug):
    row = conn.execute("SELECT revisions FROM wiki_pages WHERE slug=?", (slug,)).fetchone()
    return (row[0] + 1) if row else 1


def _status_of(req, default="stable"):
    s = str(req.get("status") or default).strip()
    return s if s in STATUSES else default


# ── 操作实现 ──────────────────────────────────────────────────────────────

def op_create(conn, req):
    slug = str(req.get("slug") or "").strip()
    family = str(req.get("familyPath") or "").strip().strip("/")
    title = str(req.get("title") or "").strip()
    intro = str(req.get("intro") or "").strip()
    content = str(req.get("content") or "")
    executor, resolved, source = attribution(req)
    status = _status_of(req)
    now = int(time.time() * 1000)
    if not slug or "/" in slug:
        return {"ok": False, "error": "slug 必填且不含 /（家族归属用 familyPath 表达）"}
    if not title:
        return {"ok": False, "error": "title 必填"}
    dup = conn.execute("SELECT 1 FROM wiki_pages WHERE slug=? OR full_path=?",
                       (slug, full_of(family, slug))).fetchone()
    if dup:
        return {"ok": False, "error": f"slug 或全路径已存在: {slug}"}
    # 家族规则 v0.2（银杏审读①定稿）：familyPath == slug → 根条目（full = slug）；
    # 否则 familyPath 必须命中某已存在条目的 full_path（= 父 family_path + '/' + 父 slug）
    is_root = (family == slug)
    if not is_root:
        parent = conn.execute("SELECT 1 FROM wiki_pages WHERE full_path = ? LIMIT 1",
                              (family,)).fetchone()
        if not parent:
            return {"ok": False, "error": f"父条目不存在（familyPath 未命中任何条目全路径）: {family}。"
                    f"根条目请令 familyPath == slug"}
    full = full_of(family, slug)
    conn.execute(
        "INSERT INTO wiki_pages(slug, family_path, full_path, title, intro, content, status, revisions, created_at, updated_at)"
        " VALUES(?,?,?,?,?,?, ?, 1, ?, ?)",
        (slug, family, full, title, intro, content, status, now, now))
    log_revision(conn, slug, 1, now, executor, "create", annotate_fallback(intro or title, resolved), content,
                 executor_resolved=resolved, source_contributor=source)
    conn.commit()
    return {"ok": True, "slug": slug, "familyPath": family, "fullPath": full,
            "isRoot": is_root, "rev": 1,
            "executor": executor, "executorResolved": resolved, "sourceContributor": source or None}


def op_update(conn, req):
    slug = str(req.get("slug") or "").strip()
    row = conn.execute(
        "SELECT content, intro, title, status, revisions, updated_at, family_path, full_path"
        " FROM wiki_pages WHERE slug=?", (slug,)).fetchone()
    if not row:
        return {"ok": False, "error": "条目不存在: " + slug}
    old_content, old_intro, old_title, old_status, old_revs, old_updated, old_family, old_full = row
    if req.get("familyPath") is not None:
        return {"ok": False, "error": "改挂家族请用 op=move（会连子树一起迁移并逐条留账）；update 只改内容/元数据"}
    new_content = str(req["content"]) if req.get("content") is not None else old_content
    new_intro = str(req["intro"]) if req.get("intro") is not None else old_intro
    new_title = str(req["title"]) if req.get("title") is not None else old_title
    new_status = str(req.get("status") or "").strip()
    new_status = new_status if new_status in STATUSES else old_status
    executor, resolved, source = attribution(req)
    summary = annotate_fallback(str(req.get("summary") or "").strip(), resolved)
    now = int(time.time() * 1000)
    unchanged = (new_content == old_content and new_intro == old_intro
                 and new_title == old_title and new_status == old_status)
    # force（〈升格流落树约定〉规则 6）：内容未变也强制落一条修订——用于归因/元数据更正
    # 留痕（「存疑只标注不删撤」需要能留下更正的痕；unchanged 短路会把这条路堵死——
    # 观澜 10-03 现状梳理 #4）。检查点级联自身有"内容没变不重复入槽"守卫，不会灌槽。
    if unchanged and not req.get("force"):
        return {"ok": True, "slug": slug, "unchanged": True,
                "executor": executor, "executorResolved": resolved, "sourceContributor": source or None}
    # ① 梯度稀释检查点：旧正文送入时间稀释槽位（级联保留）
    on_update_cascade(conn, slug, old_content, old_updated, now)
    new_revs = old_revs + 1
    conn.execute(
        "UPDATE wiki_pages SET content=?, intro=?, title=?, status=?, revisions=?, updated_at=? WHERE slug=?",
        (new_content, new_intro, new_title, new_status, new_revs, now, slug))
    log_revision(conn, slug, new_revs, now, executor, "update", summary, new_content,
                 executor_resolved=resolved, source_contributor=source)
    conn.commit()
    return {"ok": True, "slug": slug, "rev": new_revs,
            "executor": executor, "executorResolved": resolved, "sourceContributor": source or None}


def op_get(conn, req):
    slug = str(req.get("slug") or "").strip()
    row = conn.execute(
        "SELECT slug, family_path, full_path, title, intro, content, status, revisions, created_at, updated_at"
        " FROM wiki_pages WHERE slug=?", (slug,)).fetchone()
    if not row:
        return {"ok": False, "error": "条目不存在: " + slug}
    my_full = row[2]
    children = conn.execute(
        "SELECT slug, family_path, title FROM wiki_pages WHERE family_path = ? AND slug != ?",
        (my_full, slug)).fetchall()
    cps = conn.execute(
        "SELECT slot, time FROM wiki_checkpoints WHERE slug=? ORDER BY slot", (slug,)).fetchall()
    rev_opt = [c for c, _ in REVISION_OPT_COLUMNS if c in revision_columns(conn)]
    rev_names = ["rev", "time", "contributor", "action", "summary"] + rev_opt
    revs = conn.execute(
        "SELECT " + ", ".join(rev_names) + " FROM wiki_revisions WHERE slug=? ORDER BY rev DESC LIMIT 20",
        (slug,)).fetchall()
    return {"ok": True, "page": {
        "slug": slug, "familyPath": row[1], "fullPath": my_full,
        "title": row[3], "intro": row[4], "content": row[5],
        "status": row[6], "revisions": row[7], "createdAt": row[8], "updatedAt": row[9],
        "children": [{"slug": s, "familyPath": f, "title": t} for s, f, t in children],
        "checkpoints": [{"slot": s, "time": t} for s, t in cps],
        "recentRevisions": [dict(zip(rev_names, r)) for r in revs],
        # 溯源日记：把正文里 `D0029(编辑)` 这类**散文引用**解析成可点的坐标（协议 §7 #20 同族教训：
        # 引用必须带足坐标——日记号跨工作区重号，光有 D 号定位不到唯一一篇）
        "diaryRefs": diary_refs_of(conn, row[5]),
    }}


def op_list(conn, req):
    prefix = str(req.get("familyPrefix") or "").strip().strip("/")
    if prefix:
        rows = conn.execute(
            "SELECT slug, family_path, full_path, title, intro, status, revisions, updated_at"
            " FROM wiki_pages WHERE full_path=? OR full_path LIKE ? ORDER BY full_path",
            (prefix, prefix + "/%")).fetchall()
    else:
        rows = conn.execute(
            "SELECT slug, family_path, full_path, title, intro, status, revisions, updated_at"
            " FROM wiki_pages ORDER BY family_path, slug").fetchall()
    return {"ok": True, "count": len(rows), "entries": [
        {"slug": r[0], "familyPath": r[1], "fullPath": r[2], "title": r[3], "intro": r[4],
         "status": r[5], "revisions": r[6], "updatedAt": r[7]} for r in rows]}


def op_tree(conn, req):
    """森林视图：层级由 full_path 前缀链推导 + 孤儿识别（银杏审读④）。
    孤儿 = 家族路径的父链断裂（parent 条目不存在）——治理时一眼看到断链。"""
    rows = conn.execute(
        "SELECT slug, family_path, full_path, title, intro, status, revisions, updated_at"
        " FROM wiki_pages ORDER BY full_path").fetchall()
    entries = []
    byfull = {}
    for slug, fp, full, title, intro, status, revs, upd in rows:
        e = {"slug": slug, "familyPath": fp, "fullPath": full, "title": title, "intro": intro,
             "status": status, "revisions": revs, "updatedAt": upd, "children": []}
        entries.append(e)
        byfull[full] = e
    roots, orphans = [], []
    for e in entries:
        parent = byfull.get(e["familyPath"])
        if parent is not None and parent is not e:
            parent["children"].append({"slug": e["slug"], "fullPath": e["fullPath"],
                                       "title": e["title"]})
        elif e["familyPath"] == e["slug"]:
            roots.append(e)
        else:
            orphans.append(e)
    return {"ok": True, "count": len(entries),
            "roots": [r["slug"] for r in roots],
            "orphans": [o["slug"] for o in orphans],
            "entries": entries}


def op_move(conn, req):
    """改挂家族（银杏审读②：move 必须逐条留账——修订记录是五要件之一）。
    受影响集 = 自身（full_path == 自身全路径）+ 后代（full_path LIKE 自身全路径/%）。
    目标家族须已存在（full_path 命中），否则会产生孤儿——拒绝。"""
    slug = str(req.get("slug") or "").strip()
    newfp = str(req.get("newFamilyPath") or "").strip().strip("/")
    executor, resolved, source = attribution(req)
    now = int(time.time() * 1000)
    if not slug or not newfp:
        return {"ok": False, "error": "slug 与 newFamilyPath 必填"}
    row = conn.execute("SELECT family_path, full_path FROM wiki_pages WHERE slug=?", (slug,)).fetchone()
    if not row:
        return {"ok": False, "error": "条目不存在: " + slug}
    old_family, old_full = row
    if newfp == old_family:
        return {"ok": True, "slug": slug, "unchanged": True}
    # 目标家族必须已存在（防孤儿）
    target = conn.execute("SELECT 1 FROM wiki_pages WHERE full_path = ? LIMIT 1", (newfp,)).fetchone()
    if not target:
        return {"ok": False, "error": f"目标家族不存在（防孤儿拒绝）: {newfp}"}
    old_prefix = old_full + "/"
    if newfp == old_full:
        return {"ok": False, "error": "不能把条目挂到它自己下面: " + newfp}
    # 受影响集严格按**本函数文档**的口径：自身（full_path == 自身全路径）+ 后代（前缀匹配）。
    # 2026-10-01 守夜人修：原谓词用的是 `family_path=? OR full_path LIKE ?`，与文档不符，后果是
    #   ① 把「父条目」与「兄弟」一并卷进来（改挂子条目会连坐）；
    #   ② 自身那条的全路径被算成 newfp，撞 wiki_pages.full_path 唯一约束 → 任何 move 都必然抛
    #      IntegrityError、工具只回「无输出」。取证见 _tmp 证据（改动前备份与本文件同样复现）。
    affected = conn.execute(
        "SELECT slug, family_path, full_path FROM wiki_pages WHERE full_path = ? OR full_path LIKE ? ORDER BY full_path",
        (old_full, old_prefix + "%")).fetchall()
    # 平移基线：老全路径 old_full ↔ 新全路径 base_new（= 新父 + '/' + 自己）。
    # ⚠ 后代必须相对 base_new 平移，不能相对 newfp——否则「子条目带着孙条目改挂」时
    #   孙会被压到新父下面、与子平级（守夜人第一版修法就栽在这，被自建用例抓出）。
    base_new = full_of(newfp, slug)
    try:
        for mslug, mfp, mfull in affected:
            new_full = base_new + mfull[len(old_full):]
            new_family = newfp if mfull == old_full else new_full.rsplit("/", 1)[0]
            rev = next_rev(conn, mslug)
            conn.execute(
                "UPDATE wiki_pages SET family_path=?, full_path=?, revisions=?, updated_at=? WHERE slug=?",
                (new_family, new_full, rev, now, mslug))
            log_revision(conn, mslug, rev, now, executor, "move",
                         annotate_fallback(f"家族改挂：{mfp} → {new_family}", resolved), "",
                         executor_resolved=resolved, source_contributor=source)
        conn.commit()
    except sqlite3.IntegrityError as e:
        conn.rollback()                    # 不留半截改挂（父/子路径不一致会造孤儿）
        return {"ok": False, "error": "改挂失败（全路径冲突，已回滚）: %s" % e}
    return {"ok": True, "slug": slug, "moved": len(affected),
            "executor": executor, "executorResolved": resolved, "sourceContributor": source or None}


def op_rollback(conn, req):
    slug = str(req.get("slug") or "").strip()
    executor, resolved, source = attribution(req)
    now = int(time.time() * 1000)
    # 审读⑥：slot 编号随保留规则重排不稳定——按 time 定位（slot 仅展示序号）
    t = req.get("time")
    snap = None
    if t is not None:
        t = int(t)
        row = conn.execute("SELECT content FROM wiki_checkpoints WHERE slug=? AND time=?",
                           (slug, t)).fetchone()
        if row:
            snap = (t, row[0])
    if snap is None:
        allc = conn.execute("SELECT time, content FROM wiki_checkpoints WHERE slug=? ORDER BY time DESC",
                            (slug,)).fetchall()
        if not allc:
            return {"ok": False, "error": "无检查点可回滚"}
        snap = allc[0]
    snap_time, snap_content = snap
    old = conn.execute("SELECT content, updated_at FROM wiki_pages WHERE slug=?", (slug,)).fetchone()
    if not old:
        return {"ok": False, "error": "条目不存在"}
    on_update_cascade(conn, slug, old[0], old[1], now)
    rev = next_rev(conn, slug)
    conn.execute(
        "UPDATE wiki_pages SET content=?, revisions=?, updated_at=? WHERE slug=?",
        (snap_content, rev, now, slug))
    log_revision(conn, slug, rev, now, executor, "rollback",
                 annotate_fallback(f"回滚到检查点（原时间 {snap_time}）", resolved), snap_content,
                 executor_resolved=resolved, source_contributor=source)
    conn.commit()
    return {"ok": True, "slug": slug, "rev": rev, "restoredFromTime": snap_time,
            "executor": executor, "executorResolved": resolved, "sourceContributor": source or None}



VEC_CACHE_FILE = os.path.join(os.path.expanduser("~/.dsh/liubian"), "wiki_vectors.json")

# 语义索引排除前缀（运维参数，须带时点入契约 —— 协议 §9 #25「过期值 = 事故配方」）：
#   `日记/`（2026-10-06 含笑加，管理员「旧日记做成条目」导入所必需）
#   理由：逐篇日记条目共 10338 条，若都建简介向量 → wiki_vectors.json 约 225MB，
#     而每次语义检索都要全量 parse 该文件；且 184 条精炼条目会被原料淹掉。
#   代价（显式登记）：日记**不参与语义召回**，只能用字面（find keyword，含正文）与树浏览。
#   恢复路径：想让日记进语义索引，就把本元组清空 —— 但先解决"每次检索全量 parse"的实现问题。
VECTOR_EXCLUDE_PREFIXES = ("日记/",)


def _load_vec_cache():
    try:
        with open(VEC_CACHE_FILE, encoding="utf-8") as f:
            return json.loads(f.read())
    except Exception:
        return {}


def _save_vec_cache(cache):
    os.makedirs(os.path.dirname(VEC_CACHE_FILE), exist_ok=True)
    tmp = VEC_CACHE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f)
    os.replace(tmp, VEC_CACHE_FILE)


def _embed_batch(texts):
    """批量嵌入（契约 §2.2：单批 ≤64、按 index 排序取回）。"""
    import urllib.request
    out = []
    for i in range(0, len(texts), 64):
        chunk = texts[i:i + 64]
        payload = json.dumps({"model": "qwen3-emb", "input": [t[:4000] for t in chunk]}).encode("utf-8")
        rq = urllib.request.Request(
            "http://127.0.0.1:8082/v1/embeddings", data=payload,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(rq, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        for d in sorted(data["data"], key=lambda x: x["index"]):
            out.append(d["embedding"])
    return out


def _vec_rows(conn):
    """参与**语义索引**的条目行。家族可声明排除前缀（见 VECTOR_EXCLUDE_PREFIXES）。"""
    where, params = "", []
    if VECTOR_EXCLUDE_PREFIXES:
        where = " WHERE " + " AND ".join(["full_path NOT LIKE ?"] * len(VECTOR_EXCLUDE_PREFIXES))
        params = [p + "%" for p in VECTOR_EXCLUDE_PREFIXES]
    return conn.execute(
        "SELECT slug, title, intro, content, status, revisions, updated_at, family_path, full_path"
        " FROM wiki_pages" + where + " ORDER BY full_path", params).fetchall()


def _intro_vectors(conn):
    """参与语义索引的条目简介向量：按 (slug, intro哈希) 命中持久缓存；缺失/变更的批量补嵌（一次 HTTP）。

    ⚠ 排除前缀（VECTOR_EXCLUDE_PREFIXES）内的条目**不建向量**：
      旧日记归档（10338 篇）若逐篇建简介向量，`wiki_vectors.json` 会从 4MB 涨到约 225MB，
      而本函数每次检索都要把整个 JSON 读进来 parse —— 语义检索会直接不可用；
      更要紧的是 184 条精炼条目会被一万条原料从语义榜上淹掉（决议点到过的现症）。
      日记因此只走**字面**（`find` 的 keyword 一路覆盖正文）与树浏览。
      这是**显式降级**：损失＝日记不参与语义召回；调用方要能知道（见 op_find 的返回与契约记录）。"""
    rows = _vec_rows(conn)
    cache = _load_vec_cache()
    need = []
    for r in rows:
        text = r["intro"] or r["title"] or ""
        h = hashlib.md5(text.encode("utf-8")).hexdigest()
        c = cache.get(r["slug"])
        if not c or c.get("h") != h:
            need.append((r["slug"], text, h))
    if need:
        vecs = _embed_batch([t for _, t, _ in need])
        for (slug, _, h), v in zip(need, vecs):
            cache[slug] = {"h": h, "vec": v}
        _save_vec_cache(cache)
    return rows, cache


def op_search(conn, req):
    """S4 分级向量检索：查询向量 vs 全部条目简介锚（向量持久缓存，批量补嵌）。

    返回 top-K 条目（命名字段：slug/title/family_path/full_path/intro/status/score）。"""
    qv = req.get("vec") or []
    top = max(1, int(req.get("top") or 10))
    if not qv or len(qv) < 64:
        return {"ok": False, "error": "vec 必填（查询向量，≥64 维）"}
    qv = [float(x) for x in qv]
    qn = sum(x * x for x in qv) ** 0.5
    if qn == 0:
        return {"ok": False, "error": "查询向量全零"}
    qv = [x / qn for x in qv]

    rows, cache = _intro_vectors(conn)
    scored = []
    for r in rows:
        c = cache.get(r["slug"])
        if not c:
            continue
        iv = c["vec"]
        ivn = sum(x * x for x in iv) ** 0.5
        if ivn == 0:
            continue
        iv = [x / ivn for x in iv]
        scored.append({
            "slug": r["slug"], "title": r["title"],
            "family_path": r["family_path"], "full_path": r["full_path"],
            "intro": r["intro"], "status": r["status"],
            "score": round(sum(a * b for a, b in zip(qv, iv)), 4),
        })
    scored.sort(key=lambda x: -x["score"])
    return {"ok": True, "total": len(scored), "results": scored[:top]}


# ── S5 文本进 / 结果出的分级检索（协议 §15 登记的落点：helper + 工具/服务面）─────────
# 与 op_search 的分工：op_search 吃**查询向量**（原始原语，服务面刻意不收——桩测钉住
#   `search 需要向量，不在服务面`）；op_find 吃**文本**，嵌入在提供方侧完成，
#   因此可以经服务面消费——消费方不必自带 8082 依赖，也不必读别人的向量缓存。
# 归属：记忆（dsh-liubian）。消费方：流变·记忆前台（dsh-liubian-memory）侧栏「流变wiki」。

def _cosine(a, b):
    na = sum(x * x for x in a) ** 0.5
    nb = sum(x * x for x in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return sum(x * y for x, y in zip(a, b)) / (na * nb)


def _snippet(row, needle, width=90):
    """命中处上下文摘要：优先正文，其次简介；都没有就回落到简介首段。"""
    for field in ("content", "intro"):
        text = str(row[field] or "")
        if not text:
            continue
        i = text.lower().find(needle)
        if i >= 0:
            a = max(0, i - width // 2)
            b = min(len(text), i + len(needle) + width // 2)
            seg = text[a:b].replace("\n", " ").replace("\r", " ")
            return ("…" if a > 0 else "") + seg + ("…" if b < len(text) else "")
    return str(row["intro"] or "")[:width].replace("\n", " ").replace("\r", " ")


# 字面命中的加成上限（家族日记检索同款口径：`综合分 = 语义余弦 + 0.5 × 命中标签数/5`）。
# 为什么不封顶到 1.0：余弦实测带宽很窄（0.50~0.70），+0.5 后大批条目一起顶到 1.0 →
#   排序退化成"按路径排"，而且【命中 1 个字段】与【命中 5 个字段】的条目分不出来。
# 现在：加成 = 0.5 × min(1, 命中字段数/5)，不封顶（最高 1.2）；同分再按原始余弦排。
KW_BONUS = 0.5


def op_find(conn, req):
    """mode：keyword（字面）/ semantic（语义）/ hybrid（融合，默认）。

    字面一路覆盖 title / intro / content / slug / full_path 五个字段——**含正文**，
    这是 op_search（只锚 intro 向量）覆盖不到的一半：查只在正文里出现的词是刚需。
    语义一路复用 op_search 的简介锚缓存与余弦，不另建索引（协议 §21 #40：不开第二通道）。
    降级（协议 §2 #6：显式且登记损失）：语义一路不可用时**不静默**——
      · mode=semantic → 直接报错（调用方要的就是语义，不能拿字面冒充）；
      · mode=hybrid   → 回落为纯字面，并在返回里带 degraded 说明损失了什么。

    过滤三件：`status`（多值）｜`familyPrefix`（只看某枝）｜`excludeFamilyPrefix`（不看某枝）。
    第三件是 2026-10-06 加日记归档族时补的：**排除必须在 top-N 之前生效**，
    否则「只看 wiki 不看日记」会被日记挤占名额、返回不足 N 条（客户端事后过滤就是二次事故）。
    """
    q = str(req.get("query") or "").strip()
    mode = str(req.get("mode") or "hybrid").strip().lower()
    if mode not in ("keyword", "semantic", "hybrid"):
        return {"ok": False, "error": "mode 只支持 keyword / semantic / hybrid，收到：" + mode}
    if not q:
        return {"ok": False, "error": "query 必填（要检索的文本）"}
    top = max(1, int(req.get("top") or 20))
    prefix = str(req.get("familyPrefix") or "").strip().strip("/")
    ex_prefix = str(req.get("excludeFamilyPrefix") or "").strip().strip("/")
    status = req.get("status")
    if isinstance(status, str):
        status = [s.strip() for s in status.split(",") if s.strip()]

    rows = conn.execute(
        "SELECT slug, family_path, full_path, title, intro, content, status, revisions, updated_at"
        " FROM wiki_pages ORDER BY full_path").fetchall()

    def in_prefix(fp, p):
        return bool(p) and (fp == p or fp.startswith(p + "/"))

    def keep(r):
        if status and r["status"] not in status:
            return False
        if prefix and not in_prefix(r["full_path"], prefix):
            return False
        if ex_prefix and in_prefix(r["full_path"], ex_prefix):
            return False
        return True

    rows = [r for r in rows if keep(r)]

    nq = q.lower()
    kw = {}
    for r in rows:
        fields = [label for field, label in
                  (("title", "标题"), ("intro", "简介"), ("content", "正文"),
                   ("slug", "slug"), ("full_path", "路径"))
                  if nq in str(r[field] or "").lower()]
        if fields:
            kw[r["slug"]] = {"fields": fields, "snippet": _snippet(r, nq)}

    sem = {}
    degraded = None
    if mode in ("semantic", "hybrid"):
        try:
            qv = _embed_batch([q])[0]
            _, cache = _intro_vectors(conn)
            for r in rows:
                c = cache.get(r["slug"])
                if c and c.get("vec"):
                    sem[r["slug"]] = _cosine(qv, c["vec"])
        except Exception as e:
            if mode == "semantic":
                return {"ok": False, "error": "语义检索不可用（嵌入服务 8082）：%s" % e}
            degraded = {"semantic": False, "reason": str(e)[:200],
                        "loss": "语义一路缺席，结果仅含字面命中（hybrid 已回落 keyword）"}

    results = []
    for r in rows:
        slug = r["slug"]
        in_kw = slug in kw
        in_sem = slug in sem
        if mode == "keyword" and not in_kw:
            continue
        if mode == "semantic" and not in_sem:
            continue
        # 三种模式各自干净，分数可解释（2026-10-06 自检抓出：初版 semantic 也吃了字面加成，
        #   表现为「余弦 0.4299 的条目被抬到 0.9299」——模式名与实际排序不符）：
        #   keyword  —— 按命中字段数（1 个 = 0.5，每多一个 +0.1，封顶 0.9）
        #   semantic —— 纯余弦，不加任何字面成分
        #   hybrid   —— 余弦 + 0.5×(命中字段数/5)，**不封顶**；同分按原始余弦排（见 KW_BONUS 注）
        cos = sem.get(slug, 0.0)
        sem_out = round(cos, 4) if in_sem else None
        if mode == "semantic":
            score = cos
            match = "semantic"
        elif mode == "keyword":
            score = min(0.9, 0.5 + 0.1 * (len(kw[slug]["fields"]) - 1))
            match = "keyword"
        else:
            score = cos
            match = "semantic"
            if in_kw:
                score = cos + KW_BONUS * min(1.0, len(kw[slug]["fields"]) / 5.0)
                match = "hybrid" if in_sem else "keyword"
        results.append({
            "slug": slug, "title": r["title"], "familyPath": r["family_path"],
            "fullPath": r["full_path"], "intro": r["intro"], "status": r["status"],
            "revisions": r["revisions"], "updatedAt": r["updated_at"],
            "score": round(score, 4),
            "semanticScore": sem_out,
            "match": match,
            "fields": (kw.get(slug) or {}).get("fields"),
            "snippet": (kw.get(slug) or {}).get("snippet"),
        })
    # 同分按原始余弦降序（不封顶后并列少，但短查询仍可能并列），最后才按路径。
    results.sort(key=lambda x: (-x["score"], -(x["semanticScore"] or 0.0), x["fullPath"]))
    res = {"ok": True, "query": q, "mode": mode, "total": len(results),
           "results": results[:top]}
    if prefix:
        res["familyPrefix"] = prefix
    if ex_prefix:
        # 排除是**调用方要求**的过滤，必须在返回里可见（否则"少了东西"看不出来）
        res["excludeFamilyPrefix"] = ex_prefix
    if degraded:
        res["degraded"] = degraded
    return res


# ── S6 日记挂树（旧日记 → wiki 树；管理员 2026-10-06 指令）────────────────────
# 背景：日记式记忆有 10338 篇躺在 diary_content 里，而 wiki 树上只看得见 184 个条目；
#   条目正文里早已在用 `D0029(编辑)` 的写法做溯源，但那是**散文引用**，点不开。
#   本组 op 把日记做成树上可浏览的枝，并把正文里的 D 号引用解析成真链接。
#
# ⚠ 日记号**跨工作区重号**（实测 D0001 出现在 19 个工作区）→ 一切以 (workspace, diary_id) 为键。
#   只用 `D0029` 一个号去定位是错的——与协议 §7 #20「池键＝会话哈希前 8 位」同族的
#   「引用必须带足坐标」教训。

DIARY_ID_RE = re.compile(r"D\d{3,5}")
DIARY_REF_RE = re.compile(r"(D\d{3,5})\s*[（(\[]([^）)\]]{1,40})[）)\]]")
DIARY_HDR_RE = {
    "time": re.compile(r"\*\*时间\*\*[:：]\s*(.+)"),
    "date": re.compile(r"\*\*日期\*\*[:：]\s*(.+)"),
    "tags": re.compile(r"\*\*标签\*\*[:：]\s*(.+)"),
}
DIARY_SUMMARY_RE = re.compile(r"^>\s*摘要[:：]\s*(.+)$", re.M)


def parse_diary(content):
    """从日记正文里抽元数据 —— **正文自描述**：头部有 时间/日期/标签，尾部有 摘要。
    因此列日记不必解析 `docs['index:<ws>']`（那一个键最大 3.2MB，逐次 parse 太贵）。"""
    text = str(content or "")
    meta = {"time": "", "date": "", "tags": [], "summary": "", "body": text}
    for key, rx in DIARY_HDR_RE.items():
        m = rx.search(text)
        if not m:
            continue
        val = m.group(1).strip()
        meta[key] = [t.strip() for t in val.split(",") if t.strip()] if key == "tags" else val
    ms = DIARY_SUMMARY_RE.search(text)
    if ms:
        meta["summary"] = ms.group(1).strip()
    lines = text.split("\n")
    try:
        start = next(i for i, ln in enumerate(lines) if ln.strip() == "---") + 1
    except StopIteration:
        start = 0
    body = []
    for ln in lines[start:]:
        if DIARY_SUMMARY_RE.match(ln):
            break
        body.append(ln)
    while body and body[-1].strip() in ("", "---"):
        body.pop()
    meta["body"] = "\n".join(body).strip()
    return meta


def op_diary_tree(conn, req):
    """日记枝一级：各工作区的日记数（树上显示 `工作区 (N)`）。"""
    rows = conn.execute(
        "SELECT workspace, count(*) n FROM diary_content GROUP BY workspace ORDER BY n DESC").fetchall()
    return {"ok": True, "total": sum(r["n"] for r in rows),
            "workspaces": [{"workspace": r["workspace"], "count": r["n"]} for r in rows]}


def op_diary_list(conn, req):
    """按工作区分页列日记；q = **正文全文**子串检索，tag = 标签子串（标签行也在正文里）。

    排序按日记号**数值**降序（新→旧）：D 号在工作区内单调递增，字符串排序会在 5 位数上翻车
    （`D9999` > `D10000`），故 CAST 成整数。
    """
    ws = str(req.get("workspace") or "").strip()
    q = str(req.get("q") or "").strip()
    tag = str(req.get("tag") or "").strip()
    limit = max(1, min(200, int(req.get("limit") or 30)))
    offset = max(0, int(req.get("offset") or 0))
    where, args = [], []
    if ws:
        where.append("workspace = ?"); args.append(ws)
    if q:
        where.append("content LIKE ?"); args.append("%" + q + "%")
    if tag:
        where.append("content LIKE ?"); args.append("%" + tag + "%")
    w = (" WHERE " + " AND ".join(where)) if where else ""
    total = conn.execute("SELECT count(*) c FROM diary_content" + w, args).fetchone()["c"]
    rows = conn.execute(
        "SELECT workspace, diary_id, content FROM diary_content" + w +
        " ORDER BY CAST(substr(diary_id, 2) AS INTEGER) DESC LIMIT ? OFFSET ?",
        args + [limit, offset]).fetchall()
    items = []
    for r in rows:
        m = parse_diary(r["content"])
        items.append({"workspace": r["workspace"], "id": r["diary_id"], "date": m["date"],
                      "time": m["time"], "tags": m["tags"], "summary": m["summary"],
                      "chars": len(r["content"] or "")})
    return {"ok": True, "total": total, "offset": offset, "limit": limit, "items": items}


def op_diary_get(conn, req):
    """单篇日记全文 + **反向引用**（哪些 wiki 条目正文提到它）。

    workspace 必填语义：只给 id 而该号跨工作区存在时**明确报错并回候选，不猜**
    （猜一个工作区就是取错人）。
    """
    did = str(req.get("id") or req.get("diaryId") or "").strip()
    ws = str(req.get("workspace") or "").strip()
    if not did:
        return {"ok": False, "error": "id 必填（如 D0029）"}
    if not ws:
        cand = conn.execute(
            "SELECT workspace, count(*) c FROM diary_content WHERE diary_id=?"
            " GROUP BY workspace ORDER BY c DESC", (did,)).fetchall()
        if len(cand) == 1:
            ws = cand[0]["workspace"]
        elif not cand:
            return {"ok": False, "error": "日记不存在: " + did}
        else:
            return {"ok": False, "needWorkspace": True,
                    "error": "日记号跨工作区重号，需指定 workspace（候选 %d 个）" % len(cand),
                    "candidates": [{"workspace": r["workspace"]} for r in cand]}
    row = conn.execute(
        "SELECT workspace, diary_id, content FROM diary_content WHERE workspace=? AND diary_id=?",
        (ws, did)).fetchone()
    if not row:
        return {"ok": False, "error": "日记不存在: %s@%s" % (did, ws)}
    meta = parse_diary(row["content"])
    refs = []
    # LIKE 只是**候选**召回（它会把 D0778 匹配进 D07781），逐条用带边界的正则复核：
    #   旧日记做成条目后，条目正文首行都是「来源：日记 D0778 @ 中枢」，这批条目也在这里被召回，
    #   不收紧边界就会出现"引用了 D0778"里混进 D07781 的假引用。
    boundary = re.compile(r"(?<![0-9A-Za-z])" + re.escape(did) + r"(?![0-9])")
    for r in conn.execute(
            "SELECT slug, full_path, title, content FROM wiki_pages WHERE content LIKE ?"
            " ORDER BY full_path LIMIT 200", ("%" + did + "%",)).fetchall():
        if not boundary.search(str(r["content"] or "")):
            continue
        refs.append({"slug": r["slug"], "fullPath": r["full_path"], "title": r["title"]})
        if len(refs) >= 50:
            break
    return {"ok": True, "diary": {
        "workspace": row["workspace"], "id": row["diary_id"],
        "date": meta["date"], "time": meta["time"], "tags": meta["tags"],
        "summary": meta["summary"], "body": meta["body"], "raw": row["content"],
        "chars": len(row["content"] or ""), "referencedBy": refs}}


def diary_refs_of(conn, content, limit=40):
    """条目正文 → 溯源日记：把 `D0029(编辑)` 这种写法解析成可点坐标。

    带工作区限定的引用按 (ws,id) 精确定位；裸 `D0029` 若在多个工作区都存在则**全部列出**
    （宁多勿错——猜一个工作区就是取错人）。

    🐞 2026-10-06 真机翻车与修法（如实留痕）：
      初版第二段写的是 `m.group(1)`，而 `DIARY_ID_RE = r"D\\d{3,5}"` **没有捕获组**
      → `IndexError: no such group`。后果：**凡正文里带 D 号的条目（实测 46 条）全部打不开**，
      界面报「wiki_store 输出非 JSON」（helper 抛栈、父进程只看到非 JSON 输出）。
      为什么单测没拦住：抽查只打到"正文里没有 D 号引用"的条目，那段代码根本没被执行——
      即「新加会遍历正文的代码，就必须拿全库当夹具跑一遍」。
      已补 `_dev/probe_all_get.py`（184 条逐条 op_get）作为这条的常设闸门。
    """
    text = str(content or "")
    pairs, seen, qualified = [], set(), set()
    for m in DIARY_REF_RE.finditer(text):
        did, ws = m.group(1), m.group(2).strip()
        k = (did, ws)
        if k in seen:
            continue
        seen.add(k); qualified.add(did); pairs.append(k)
    for m in DIARY_ID_RE.finditer(text):
        did = m.group(0)                     # ← 该正则无捕获组，只能取 group(0)
        if did in qualified:                 # 已按 (ws,id) 精确定位过，不再追加裸形式
            continue
        k = (did, "")
        if k in seen:
            continue
        seen.add(k); pairs.append(k)
    if not pairs:
        return []
    ids = sorted({p[0] for p in pairs})
    have = {}
    # 分批查：SQLite 的绑定变量数有上限（旧版 999），长条目可能引用上百个日记号
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        qs = ",".join("?" * len(chunk))
        for r in conn.execute(
                "SELECT workspace, diary_id FROM diary_content WHERE diary_id IN (%s)" % qs,
                chunk).fetchall():
            have.setdefault(r["diary_id"], []).append(r["workspace"])
    out = []
    for did, ws in pairs:
        wss = [ws] if (ws and ws in have.get(did, [])) else list(have.get(did, []))
        for w in wss:
            out.append({"id": did, "workspace": w, "qualified": bool(ws)})
        if len(out) >= limit:
            break
    return out[:limit]


OPS = {
    "create": op_create,
    "update": op_update,
    "get": op_get,
    "tree": op_tree,
    "list": op_list,
    "move": op_move,
    "rollback": op_rollback,
    "search": op_search,
    "find": op_find,
    "diary_tree": op_diary_tree,
    "diary_list": op_diary_list,
    "diary_get": op_diary_get,
}


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raw = sys.stdin.buffer.read().decode("utf-8", "replace")
    try:
        req = json.loads(raw or "{}")
    except Exception as e:
        out({"ok": False, "error": "bad json: %s" % e})
        return
    op = str(req.get("op") or "").strip()
    fn = OPS.get(op)
    if not fn:
        out({"ok": False, "error": f"未知 op: {op}（可选: {', '.join(sorted(OPS))}）"})
        return
    conn = connect()
    try:
        out(fn(conn, req))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
