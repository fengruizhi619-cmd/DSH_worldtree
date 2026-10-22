# -*- coding: utf-8 -*-
"""世界树 · 树核（v1）

世界树系统 = 记忆系统 v2（管理员 2026-10-10 定纲）：
  组织方式与记忆系统同构（树形家族、简介/正文、稳定标识）；
  两处换发动机：人工挂载 → **自动生长**；贡献者 + 修订记录 → **生长记录**。

生长规则（10,338 篇真实日记实测标定，见 docs/世界树_生长实验报告_v1.md）：
  · 特征：每篇日记/便签按句切分均匀采 5 样 → **5 个内容向量**（Qwen3-Emb Q4_K_M，1024 维，归一化）
  · 层进门槛：第 k 层需 **≥k 个内容向量命中**（余弦距离 ≤ th=0.45）
  · 根层判距：用**全文向量**（修法 b 实测最优：巨型入口根消失，第一层成为领域层）
  · 形态：twig（某层找不到合格节点 → 本层开新枝装着它）——每篇一节点 = 主题地址
  · 顺序：按时间序插入（增量生长对顺序敏感，时序即规则）
  · 家族向量：查询向量，入数后按落枝分配，不参与判位

存储：SQLite（nodes / entries / growth_log），向量 f32 BLOB；
      全树常驻内存（numpy 矩阵），flush() 批量落盘——10,337 节点 ≈ 42MB，无压力。
生长记录：growth_log 记每一次 发芽/并枝 的 {node, at, event, source}——
      原「贡献者 + 修订记录」合并体：树的历史就是生长史。
"""
import collections
import datetime
import json
import os
import sqlite3
import sys
import time

import numpy as np

MAX_LEVEL = 5            # 5 个内容向量 → 树深封顶 5 层
SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
  id         INTEGER PRIMARY KEY,
  parent_id  INTEGER,
  level      INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  vec        BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,
  ws            TEXT,
  final_node_id INTEGER NOT NULL,
  grew_at       TEXT NOT NULL,
  head          TEXT,
  body          TEXT
);
CREATE TABLE IF NOT EXISTS memberships (
  entry_id INTEGER NOT NULL,
  node_id  INTEGER NOT NULL,
  level    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS growth_log (
  id       INTEGER PRIMARY KEY,
  node_id  INTEGER NOT NULL,
  at       TEXT NOT NULL,
  event    TEXT NOT NULL,
  detail   TEXT
);
CREATE TABLE IF NOT EXISTS tags (
  source TEXT NOT NULL,
  tag    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE TABLE IF NOT EXISTS uploads (
  id      INTEGER PRIMARY KEY,
  session TEXT NOT NULL,
  at      TEXT NOT NULL,
  count   INTEGER NOT NULL,
  sources TEXT,
  note    TEXT
);
CREATE TABLE IF NOT EXISTS entry_vecs (
  source TEXT PRIMARY KEY,
  vec    BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memberships_node ON memberships(node_id);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
"""


def _now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def _norm(v):
    a = np.asarray(v, dtype=np.float32)
    return a / (np.linalg.norm(a) + 1e-12)


def _norm_rows(M):
    a = np.asarray(M, dtype=np.float32)
    return a / (np.linalg.norm(a, axis=1, keepdims=True) + 1e-12)


class WorldTree:
    """世界树（内存态 + SQLite 落盘）。构造即加载；insert 改内存；flush() 落盘。"""

    def __init__(self, db_path, th=0.45, l1_use_fam=True, l1_need=1, attach="twig", log=None):
        self.db_path = db_path
        self.th = float(th)
        self.l1_use_fam = bool(l1_use_fam)
        self.l1_need = max(1, int(l1_need))
        self.attach = attach                  # 'twig'（现制）｜ 'member'（实验对照，已排除）
        self.log = log
        self.nodes = []        # {id, parent, level, kind, V, entries:[], created_at}
        self.entries = []      # {id, node_id, source, ws, grew_at}
        self.growth = []       # {id, node_id, at, event, detail}
        self._children = {}    # parent_id -> [node]（内存索引，随建随更）
        self._dirty = False
        self._load()

    # ── 加载 / 落盘 ────────────────────────────────────────────────────────
    def _load(self):
        if not os.path.exists(self.db_path):
            return
        conn = sqlite3.connect(self.db_path)
        # 空壳文件（历史上 connect 副作用建出的 0 表库）按全新处理
        try:
            has = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes'").fetchone()
        except Exception:
            has = None
        if not has:
            conn.close()
            return
        conn.row_factory = sqlite3.Row
        for r in conn.execute("SELECT id,parent_id,level,kind,vec,created_at FROM nodes ORDER BY id"):
            nd = {"id": r["id"], "parent": r["parent_id"], "level": r["level"],
                  "kind": r["kind"], "V": np.frombuffer(r["vec"], dtype=np.float32),
                  "entries": [], "created_at": r["created_at"]}
            self.nodes.append(nd)
            if nd["parent"] is not None:
                self._children.setdefault(nd["parent"], []).append(nd)
        byid = {n["id"]: n for n in self.nodes}
        for r in conn.execute("SELECT id,source,ws,final_node_id,grew_at,head,body FROM entries ORDER BY id"):
            e = {"id": r["id"], "final_node": r["final_node_id"], "source": r["source"],
                 "ws": r["ws"], "grew_at": r["grew_at"], "path": [],
                 "head": r["head"], "body": r["body"]}
            self.entries.append(e)
        # 2026-10-11 读侧去重：历史脏数据（flush 漏删时期写入的重复行）不得再堆进
        # path/node.entries——否则下一轮 flush 又把重复写回去（指数放大链的另一半）。
        seen_m = set()
        for r in conn.execute("SELECT entry_id,node_id,level FROM memberships ORDER BY entry_id, level"):
            key = (r["entry_id"], r["node_id"])
            if key in seen_m:
                continue
            seen_m.add(key)
            e = next((x for x in self.entries if x["id"] == r["entry_id"]), None)
            nd = byid.get(r["node_id"])
            if e and nd is not None:
                e["path"].append({"node_id": r["node_id"], "level": r["level"]})
                nd["entries"].append(e)
        for r in conn.execute("SELECT id,node_id,at,event,detail FROM growth_log ORDER BY id"):
            self.growth.append(dict(r))
        conn.close()

    def flush(self):
        d = os.path.dirname(self.db_path)
        if d:
            os.makedirs(d, exist_ok=True)
        conn = sqlite3.connect(self.db_path)
        conn.executescript(SCHEMA)
        conn.execute("DELETE FROM nodes")
        conn.execute("DELETE FROM entries")
        conn.execute("DELETE FROM growth_log")
        # 2026-10-11 血案修复：memberships 也必须清——漏了这行导致每次 flush 全量追加，
        # 叠加 _load 重复堆积，14 次插入把表撑到 3690 万行 / 库 988MB（2^n 翻倍放大）。
        conn.execute("DELETE FROM memberships")
        conn.executemany(
            "INSERT INTO nodes(id,parent_id,level,kind,vec,created_at) VALUES(?,?,?,?,?,?)",
            [(n["id"], n["parent"], n["level"], n["kind"],
              np.asarray(n["V"], dtype=np.float32).tobytes(), n["created_at"]) for n in self.nodes])
        conn.executemany(
            "INSERT INTO entries(id,source,ws,final_node_id,grew_at,head,body) VALUES(?,?,?,?,?,?,?)",
            [(e["id"], e["source"], e["ws"], e["final_node"], e["grew_at"], e.get("head"), e.get("body")) for e in self.entries])
        mrows = []
        for e in self.entries:
            for p in e.get("path", []):
                mrows.append((e["id"], p["node_id"], p["level"]))
        conn.executemany(
            "INSERT INTO memberships(entry_id,node_id,level) VALUES(?,?,?)", mrows)
        conn.executemany(
            "INSERT INTO growth_log(id,node_id,at,event,detail) VALUES(?,?,?,?,?)",
            [(g["id"], g["node_id"], g["at"], g["event"], g.get("detail", "")) for g in self.growth])
        conn.commit()
        conn.close()
        self._dirty = False
        return True

    # ── 内部：层内选节点 ───────────────────────────────────────────────────
    def _pick(self, nodes, dM, dF, level):
        """在 level 层的节点列表里选合格者：第 k 层需 ≥k 个内容向量命中；
        根层（level==1）在 l1_use_fam 时改用全文向量判距。返回 (node, 命中数, 距离和)。"""
        best, best_m, best_dist = None, 0, None
        if level == 1 and self.l1_use_fam and dF is not None:
            cand = []
            for nd in nodes:
                dist = 1.0 - float(dF @ nd["V"])
                if dist <= self.th:
                    cand.append((dist, nd))
            if cand:
                cand.sort(key=lambda x: x[0])
                best, best_m, best_dist = cand[0][1], 1, cand[0][0]
            return best, best_m, best_dist
        need = level if level > 1 else self.l1_need
        for nd in nodes:
            dists = 1.0 - dM @ nd["V"]             # (k,)
            m = int((dists <= self.th).sum())
            sd = float(dists.sum())
            if m >= need and (m > best_m or (m == best_m and (best_dist is None or sd < best_dist))):
                best, best_m, best_dist = nd, m, sd
        return best, best_m, best_dist

    def _children_of(self, node):
        return self._children.get(node["id"], [])

    def _new_node(self, level, parent, V0, at, source):
        nd = {"id": (max((n["id"] for n in self.nodes), default=0)) + 1,
              "parent": parent["id"] if parent is not None else None,
              "level": level, "kind": "root" if level == 1 else "twig",
              "V": V0, "entries": [], "created_at": at}
        self.nodes.append(nd)
        if parent is not None:
            self._children.setdefault(parent["id"], []).append(nd)
        self.growth.append({"id": len(self.growth) + 1, "node_id": nd["id"], "at": at,
                            "event": "sprout", "detail": source})
        return nd

    # ── 生长（编码上树）────────────────────────────────────────────────────
    def insert(self, source, ws, content_vecs, fam_vec=None, at=None, head=None, body=None):
        """编码上树。content_vecs: 5×D 内容向量；fam_vec: 全文向量（根层判距）。
        source: 便签坐标/日记坐标。head/body: 条目正文（清空重长后正文落库——
        视图/词云/检索都靠它）。返回落点地址 [(level, node_id), ...]。"""
        at = at or _now()
        dM = _norm_rows(content_vecs)                      # (5,1024)
        dF = _norm(fam_vec) if fam_vec is not None else None
        entry = {"id": len(self.entries) + 1, "final_node": None,
                 "source": source, "ws": ws, "grew_at": at, "path": [],
                 "head": head, "body": body}
        path = []
        nodes, level, parent = self.nodes, 1, None
        while True:
            best, _, _ = self._pick(nodes, dM, dF, level)
            if best is None:
                if self.attach == "member" and level > 1 and parent is not None:
                    parent["entries"].append(entry)        # 实验对照口径（已排除，保留开关）
                    entry["final_node"] = parent["id"]
                    entry.setdefault("path", []).append({"node_id": parent["id"], "level": level})
                    self.growth.append({"id": len(self.growth) + 1, "node_id": parent["id"],
                                        "at": at, "event": "join", "detail": source})
                    self._dirty = True
                    return path
                nd = self._new_node(level, parent, (dF if (level == 1 and self.l1_use_fam) else dM[0]).copy(),
                                    at, source)
                nd["entries"].append(entry)
                entry["final_node"] = nd["id"]
                entry.setdefault("path", []).append({"node_id": nd["id"], "level": level})
                self.entries.append(entry)
                self.growth.append({"id": len(self.growth) + 1, "node_id": nd["id"],
                                    "at": at, "event": "sprout-join", "detail": source})
                self._dirty = True
                path.append((level, nd["id"]))
                return path
            best["entries"].append(entry)
            entry.setdefault("path", []).append({"node_id": best["id"], "level": level})
            path.append((level, best["id"]))
            if level >= MAX_LEVEL:
                entry["final_node"] = best["id"]
                # 2026-10-12 血案修复：合并路径漏挂 self.entries——条目不进内存列表，
                # flush 全量重写时直接蒸发（昨日 16af7c33 批 -5、ASR 批 -6 实证）。
                self.entries.append(entry)
                self.growth.append({"id": len(self.growth) + 1, "node_id": best["id"],
                                    "at": at, "event": "join", "detail": source})
                self._dirty = True
                return path
            level += 1
            nodes = self._children_of(best)
            parent = best

    # ── 查询 / 定位 / 近邻 ─────────────────────────────────────────────────
    def locate(self, content_vecs, fam_vec=None):
        """给内容向量（+可选全文向量），返回它**应有的树地址**（不改树）。
        用途：查询定位、复算（"这篇日记若今天上树会长在哪"）。"""
        dM = _norm_rows(content_vecs)
        dF = _norm(fam_vec) if fam_vec is not None else None
        path = []
        nodes, level = self.nodes, 1
        while True:
            best, _, _ = self._pick(nodes, dM, dF, level)
            if best is None:
                return path
            path.append({"level": level, "node_id": best["id"], "entries": len(best["entries"])})
            nodes = self._children_of(best)
            level += 1

    def neighbors(self, node_id, k=8):
        """同枝近邻：该节点及父/子节点的成员坐标。"""
        byid = {n["id"]: n for n in self.nodes}
        nd = byid.get(node_id)
        if nd is None:
            return []
        out, seen = [], set()
        def _add(entries, via):
            for e in entries:
                src = e["source"]
                if src in seen:            # 同 source 经 self/child/parent 多路出现只留一路
                    continue
                seen.add(src)
                out.append({"source": src, "ws": e["ws"], "grew_at": e["grew_at"], "via": via,
                            "head": e.get("head"), "body": e.get("body")})
        _add(nd["entries"], "self")
        for ch in self._children_of(nd):
            _add(ch["entries"], "child")
        if nd.get("parent") is not None and nd["parent"] in byid:
            _add(byid[nd["parent"]]["entries"], "parent")
        return out[:k]

    def subtree(self, node_id):
        byid = {n["id"]: n for n in self.nodes}

        def rec(nid):
            nd = byid.get(nid)
            if nd is None:
                return None
            return {"id": nd["id"], "level": nd["level"], "kind": nd["kind"],
                    "entries": [e["source"] for e in nd["entries"]],
                    "children": [rec(c["id"]) for c in self._children_of(nd)]}
        return rec(node_id)

    def stats(self):
        by_level = collections.Counter()
        pur = collections.defaultdict(list)
        ws_seen = set()
        depth = []
        children_of = collections.defaultdict(list)
        for n in self.nodes:
            if n["parent"] is not None:
                children_of[n["parent"]].append(n)
        for n in self.nodes:
            by_level[n["level"]] += 1
            wss = [e["ws"] for e in n["entries"] if e["ws"]]
            if wss:
                cc = collections.Counter(wss)
                pur[n["level"]].append(max(cc.values()) / sum(cc.values()))
                ws_seen.update(wss)
            if not children_of[n["id"]]:
                depth.append(n["level"])
        import statistics
        return {
            "entries": len(self.entries),
            "nodes": len(self.nodes),
            "by_level": dict(sorted(by_level.items())),
            "max_depth": max(depth) if depth else 0,
            "leaves": len(depth),
            "purity_by_level": {lv: round(float(statistics.mean(v)), 3) for lv, v in sorted(pur.items())},
            "workspaces": len(ws_seen),
            "growth_events": len(self.growth),
        }

    def sources(self):
        return [e["source"] for e in self.entries]


# ── 特征 ────────────────────────────────────────────────────────────────────
import re as _re
import urllib.request as _urlreq

SENT_SPLIT = _re.compile(r"[。！？!?；;\n]+")


def sample_sentences(text, k=5):
    """按句切分后均匀采 k 样（世界树特征的标准切分，单一来源）。"""
    sents = [s.strip() for s in SENT_SPLIT.split(text or "") if len(s.strip()) >= 6]
    if not sents:
        return []
    if len(sents) <= k:
        return sents
    idx = sorted({round(i * (len(sents) - 1) / (k - 1)) for i in range(k)})
    return [sents[i] for i in idx]


def embed_texts(texts, url="http://127.0.0.1:8082/v1/embeddings", batch=64):
    """调内置向量服务（dsh-liubian-memory 的 Q4_K_M @8082）。

    ⚠ 形状归一（2026-10-10 根因实验）：llama.cpp 计算缓冲池按请求形状保留缓冲且不释放——
    批量形状五花八门会让私有提交单调上涨（实测 1×512 条 +950MB；同形重复 40 次 +1MB）。
    每批补齐到固定 64 条（复用末条填充），全库请求形状唯一 → 缓冲只分配一次。"""
    texts = list(texts)
    if not texts:
        return []
    out = []
    for i in range(0, len(texts), batch):
        chunk = texts[i:i + batch]
        if len(chunk) < batch:
            chunk = chunk + [chunk[-1]] * (batch - len(chunk))
        payload = json.dumps({"model": "qwen3-emb", "input": chunk}).encode("utf-8")
        rq = _urlreq.Request(url, data=payload, headers={"Content-Type": "application/json"})
        with _urlreq.urlopen(rq, timeout=180) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        vs = [d["embedding"] for d in sorted(data["data"], key=lambda x: x["index"])]
        out.extend(vs[:min(batch, len(texts) - i)])
    return out


# ── 上行台账（记忆上传记录；管理员 2026-10-10：UI 盘点用）──────────────────
def record_upload(db, session, count, sources=None, note=None, at=None):
    """记一笔上传批次：哪个对话（哈希/池键）、什么时候、产出了多少条。"""
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE IF NOT EXISTS uploads (id INTEGER PRIMARY KEY, session TEXT NOT NULL,"
                 " at TEXT NOT NULL, count INTEGER NOT NULL, sources TEXT, note TEXT)")
    conn.execute("INSERT INTO uploads(session,at,count,sources,note) VALUES(?,?,?,?,?)",
                 (session, at or _now(), int(count),
                  json.dumps(sources or [], ensure_ascii=False) if sources else None, note))
    conn.commit()
    rid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.close()
    return rid


def list_uploads(db, limit=500):
    """按时间倒序列出上传批次（盘点视图的数据源）。"""
    conn = sqlite3.connect(db)
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS uploads (id INTEGER PRIMARY KEY, session TEXT NOT NULL,"
                     " at TEXT NOT NULL, count INTEGER NOT NULL, sources TEXT, note TEXT)")
        rows = conn.execute("SELECT id, session, at, count, sources, note FROM uploads"
                            " ORDER BY at DESC, id DESC LIMIT ?", (int(limit),)).fetchall()
        total = conn.execute("SELECT COALESCE(SUM(count),0) FROM uploads").fetchone()[0]
        return {"ok": True, "total": int(total), "batches": [
            {"id": r[0], "session": r[1], "at": r[2], "count": r[3],
             "sources": json.loads(r[4]) if r[4] else [], "note": r[5]} for r in rows]}
    finally:
        conn.close()



def _snippets_for(sources):
    """近邻内容摘要（liubian.db ro 直连，§14 已申报形态）：wiki:slug → intro；
    <ws>/<id> → 日记头几行。注入块靠它从"坐标"变"可读内容"。"""
    out = {}
    try:
        conn = sqlite3.connect("file:%s?mode=ro" % r"E:\DSH_data\.memory_registry\liubian.db", uri=True)
    except Exception:
        return out
    for s in sources:
        try:
            if s.startswith("wiki:"):
                row = conn.execute("SELECT intro FROM wiki_pages WHERE slug=?", (s[5:],)).fetchone()
                if row and row[0]:
                    out[s] = str(row[0]).strip().replace("\n", " ")[:80]
            else:
                ws, _, did = s.partition("/")
                row = conn.execute("SELECT content FROM diary_content WHERE workspace=? AND diary_id=?",
                                   (ws, did)).fetchone()
                if row and row[0]:
                    heads = [x.strip() for x in str(row[0]).split("\n") if x.strip()][:3]
                    out[s] = "／".join(heads)[:80]
        except Exception:
            continue
    conn.close()
    return out


# ── 关键词系统（管理员 2026-10-10：切词→高频/已有词为标签→词云→筛选）────────
STOPWORDS = set("""的了我是在有和就不人都一个上也这到说要会能没很被让把它给而以之于其中或但
因此所以如果因为可以这个那个什么怎么如何我们你们他们她它们自己还又再 just ok go do the and for you with this that"""
.split())


def _cut_tokens(text):
    """切词：字符 n-gram（CJK 2–4 字滑窗）+ ASCII 词，滤停用词/标点/数字。
    2026-10-12 用户裁定移除 jieba（每次 insert 白付 ~1s 加载 + 数百 MB 内存）。
    返回「token 序列」（重复保留）——compute_tags 靠重复次数计频，不能去重。"""
    text = text or ""
    out = []
    # ASCII 词（含 snake/case 连字），滤纯数字与停用词
    for w in _re.findall(r"[A-Za-z][A-Za-z0-9_+-]+", text):
        if len(w) >= 2 and w.lower() not in STOPWORDS and not w.isdigit():
            out.append(w)
    # CJK 连续段 → 2–4 字滑窗 n-gram；首尾含停用字的 gram 丢弃；逐位置产出（序列语义）
    for run in _re.findall(r"[\u4e00-\u9fff]{2,}", text):
        L = len(run)
        for n in (2, 3, 4):
            for i in range(L - n + 1):
                g = run[i:i + n]
                if g[0] in STOPWORDS or g[-1] in STOPWORDS:
                    continue
                out.append(g)
    return out


def compute_tags(text, vocab=None, topn=8, cooccur=None):
    """n-gram 共现打标（2026-10-12 去 jieba 版）。
    词源 = _cut_tokens 的 n-gram 序列；计分 = 频次 × 词长 × vocab 加成；
    贪心选择 + 包含抑制（短碎片是已选更长标签的子串则淘汰，防"人工/智能/工智"碎片洪灾）。"""
    import collections as _c
    words = _cut_tokens(text)
    if not words:
        return []
    cnt = _c.Counter(words)
    vocab = set(vocab or [])

    cands = {}
    for tok, n in cnt.items():
        base = 3 if tok in vocab else 1
        s = base * n * min(len(tok), 8)
        if s >= 6:
            cands[tok] = s
    if cooccur:   # 全局共现合并对：频次加权入候选
        for i in range(len(words) - 1):
            a, b = words[i], words[i + 1]
            pair = tuple(sorted((a, b)))
            freq = cooccur.get(pair, 0)
            if freq >= 3:
                tag = a + b if not (a[-1].isascii() and b[0].isascii()) else a + " " + b
                if tag not in cands or cands[tag] < freq * 2:
                    cands[tag] = freq * 2

    tags = []
    for tok, s in sorted(cands.items(), key=lambda kv: (-kv[1], -len(kv[0]), kv[0])):
        if any(tok in t2 for t2 in tags):
            continue                                    # 是已选更长标签的子串 → 噪声
        tags = [t2 for t2 in tags if not (t2 in tok and len(t2) < len(tok))]
        tags.append(tok)
        if len(tags) >= topn:
            break
    return tags[:topn]


def build_cooccur(texts, topn=500):
    """全局相邻共现表：Counter{(tokA, tokB): freq}——跨条目累计，频次加权。"""
    import collections as _c
    co = _c.Counter()
    for text in texts:
        words = _cut_tokens(text)
        for i in range(len(words) - 1):
            pair = tuple(sorted((words[i], words[i + 1])))
            co[pair] += 1
    return _c.Counter({k: v for k, v in co.items() if v >= 2})


def tag_vocab(db):
    conn = sqlite3.connect(db)
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS tags (source TEXT NOT NULL, tag TEXT NOT NULL)")
        conn.commit()
        return {r[0] for r in conn.execute("SELECT DISTINCT tag FROM tags")}
    finally:
        conn.close()


def store_tags(db, source, tags):
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE IF NOT EXISTS tags (source TEXT NOT NULL, tag TEXT NOT NULL)")
    conn.execute("DELETE FROM tags WHERE source=?", (source,))
    conn.executemany("INSERT INTO tags(source,tag) VALUES(?,?)", [(source, t) for t in tags])
    conn.commit()
    conn.close()


def conn_tags(db, source):
    conn = sqlite3.connect(db)
    try:
        return conn.execute("SELECT tag FROM tags WHERE source=?", (source,)).fetchall()
    finally:
        conn.close()


def op_entry_tags(db, source):
    """条目标签 + 联想词（共现词云数据）。旧日记/ wiki 条目懒计算并缓存。"""
    if not source:
        return {"ok": False, "error": "source 必填"}
    have = [r[0] for r in conn_tags(db, source)]
    if not have:
        text = ""
        try:
            conn = sqlite3.connect("file:%s?mode=ro" % r"E:\DSH_data\.memory_registry\liubian.db", uri=True)
            if source.startswith("wiki:"):
                row = conn.execute("SELECT intro||char(10)||content FROM wiki_pages WHERE slug=?",
                                   (source[5:],)).fetchone()
            else:
                ws, _, did = source.partition("/")
                row = conn.execute("SELECT content FROM diary_content WHERE workspace=? AND diary_id=?",
                                   (ws, did)).fetchone()
            conn.close()
            text = (row[0] or "") if row else ""
        except Exception:
            text = ""
        if not text:
            return {"ok": True, "tags": [], "associated": []}
        have = compute_tags(text, tag_vocab(db))
        store_tags(db, source, have)
    conn = sqlite3.connect(db)
    ph = ",".join("?" * len(have)) if have else "''"
    rows = conn.execute(
        "SELECT tag, COUNT(DISTINCT source) c FROM tags WHERE tag NOT IN (%s)"
        " AND source IN (SELECT DISTINCT source FROM tags WHERE tag IN (%s))"
        " GROUP BY tag ORDER BY c DESC LIMIT 12" % (ph, ph), have + have).fetchall()
    conn.close()
    return {"ok": True, "tags": have,
            "associated": [{"tag": r[0], "count": r[1]} for r in rows]}


def op_wt_tree(t):
    """世界树 → wiki 树形状投影（slug=wt-<祖先id链>；根 familyPath==slug）。"""
    import collections as _c
    byid = {n["id"]: n for n in t.nodes}
    kids = _c.defaultdict(list)
    for n in t.nodes:
        kids[n.get("parent")].append(n)

    def path_ids(nd):
        ids, cur = [], nd
        while cur is not None:
            ids.append(cur["id"])
            cur = byid.get(cur.get("parent"))
        return list(reversed(ids))

    byid = {n["id"]: n for n in t.nodes}
    entries = []
    for nd in t.nodes:
        ids = path_ids(nd)
        is_leaf = not kids.get(nd["id"])
        # 管理员 2026-10-10：单成员 wiki 叶子 → 直接呈现为真实条目（点开即全文），
        # 不再生成"节点页"（合成内容页=污染）。只有内部/多成员节点保留结构展示。
        if is_leaf and len(nd["entries"]) == 1 and nd["entries"][0]["source"].startswith("wiki:"):
            e0 = nd["entries"][0]
            slug = e0["source"][5:]
            fam = ("wt-" + "-".join(map(str, ids[:-1]))) if len(ids) > 1 else slug
            head = (e0.get("head") or "").strip()
            entries.append({
                "slug": slug, "familyPath": fam, "fullPath": slug,
                "title": (head[:56] or slug),
                "intro": head[:200],
                "status": "stable", "revisions": 1,
                "updatedAt": e0["grew_at"],
                "children": []})
            continue
        slug = "wt-" + "-".join(map(str, ids))
        fam = ("wt-" + "-".join(map(str, ids[:-1]))) if len(ids) > 1 else slug
        heads = [(e.get("head") or e["source"])[:40] for e in nd["entries"][:3]]
        entries.append({
            "slug": slug, "familyPath": fam, "fullPath": slug,
            "title": "L%d · %d条" % (nd["level"], len(nd["entries"])),
            "intro": "；".join(heads)[:200],
            "status": "stable", "revisions": len(nd["entries"]),
            "updatedAt": max((e["grew_at"] for e in nd["entries"]), default=""),
            "children": []})
    roots = [e for e in entries if e["familyPath"] == e["slug"]]
    return {"ok": True, "count": len(entries),
            "roots": [r["slug"] for r in roots], "orphans": [], "entries": entries}


def _lock_insert(db):
    """insert 跨进程锁：O_CREAT|O_EXCL 抢锁文件（内容=本进程 PID），120s 超时视为陈锁接管。"""
    lock = db + ".insert.lock"
    deadline = time.time() + 120
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            if os.environ.get("WT_LOCK_DEBUG"):
                sys.stderr.write("[lock] acquired pid=%d t=%.3f\n" % (os.getpid(), time.time() % 1000))
            return lock
        except FileExistsError:
            if os.environ.get("WT_LOCK_DEBUG"):
                sys.stderr.write("[lock] busy pid=%d t=%.3f\n" % (os.getpid(), time.time() % 1000))
            if time.time() > deadline:
                try:
                    os.unlink(lock)
                except OSError:
                    pass
                deadline = time.time() + 120
            time.sleep(0.15)


def _unlock_insert(path):
    """释放锁：先校验持有者是自己（PID 匹配）才删——
    防 A 的延迟 unlink 删掉 B 刚建的锁（2026-10-12 双持有实证：40ms 交错即丢条目）。"""
    try:
        owner = ""
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                owner = f.read().strip()
        if owner == str(os.getpid()):
            os.unlink(path)
        elif os.environ.get("WT_LOCK_DEBUG"):
            sys.stderr.write("[lock] skip-unlink pid=%d owner=%s\n" % (os.getpid(), owner))
    except OSError:
        pass


def _cli():
    import sys
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raw = b""
    if "--req-file" in sys.argv:
        raw = open(sys.argv[sys.argv.index("--req-file") + 1], "rb").read()
    elif not sys.stdin.isatty():
        raw = sys.stdin.buffer.read()          # ⚠ 必须按字节读（§3.4.0 症状 A）
    req = json.loads(raw.decode("utf-8") or "{}") if raw else {}
    op = req.get("op", "stats")
    db = os.environ.get("WT_DB", r"E:\DSH_data\世界树\data\worldtree.db")
    # 清空重长（2026-10-10）：库不存在 = 全新世界，自动创建，不再要求迁移。
    # 启动即幂等建全表——空库上调 tag_table/tag_filter 等只读 op 不再炸 no such table。
    _c0 = sqlite3.connect(db)
    _c0.executescript(SCHEMA)
    _c0.commit()
    _c0.close()
    t = WorldTree(db)
    if op == "stats":
        out = t.stats()
    elif op == "locate":
        v = req.get("vecs")
        out = {"path": t.locate([v] if v and not isinstance(v[0], list) else v)}
    elif op == "node":
        byid = {n["id"]: n for n in t.nodes}
        nd = byid.get(int(req.get("node_id", 0)))
        if nd is None:
            out = {"error": "节点不存在"}
        else:
            nb = t.neighbors(nd["id"], k=8)
            sn = _snippets_for([x["source"] for x in nb])
            for x in nb:
                if x["source"] in sn:
                    x["snippet"] = sn[x["source"]]
            out = {"id": nd["id"], "level": nd["level"], "kind": nd["kind"],
                   "entry_count": len(nd["entries"]),
                   "sources": [e["source"] for e in nd["entries"]],
                   "neighbors": nb}
    elif op == "insert":
        # 跨进程插入锁（2026-10-12 对账实证）：insert 是 load→flush 全量重写架构，
        # 两个进程交错 flush 会把对方刚插入的条目抹掉（昨日 -11 条）。锁内重载树，
        # 保证看到的是前一个插入者提交后的最新状态。
        _lk = _lock_insert(db)
        try:
            t = WorldTree(db)
            text = str(req.get("text", ""))
            source = str(req.get("source") or ("adhoc/" + _now()))
            if not text.strip():
                out = {"error": "text 为空"}
            else:
                sents = sample_sentences(text, 5) or [text[:200]]
                fam = req.get("fam")
                if fam is None:
                    fam = embed_texts([text[:4000]])[0]
                # 采样句批量嵌入
                vecs = embed_texts(sents)
                path = t.insert(source=source, ws=req.get("ws"), content_vecs=vecs, fam_vec=fam,
                                head=text[:120], body=text)
                store_tags(db, source, compute_tags(text, tag_vocab(db)))
                # 条目向量自缓存（2026-10-12 三通道赛马）：全文向量入 entry_vecs，S 分数据源
                _ce = sqlite3.connect(db)
                _ce.execute("INSERT OR REPLACE INTO entry_vecs(source,vec) VALUES(?,?)",
                            (source, np.asarray(fam, dtype=np.float32).tobytes()))
                _ce.commit()
                _ce.close()
                t.flush()
                out = {"ok": True, "path": path, "entries": len(t.entries), "nodes": len(t.nodes),
                       "tags": [r[0] for r in conn_tags(db, source)]}
        finally:
            _unlock_insert(_lk)
    elif op == "uploads":
        out = list_uploads(db, limit=int(req.get("limit") or 500))
    elif op == "record_upload":
        rid = record_upload(db, str(req.get("session") or "unknown"), int(req.get("count") or 0),
                            sources=req.get("sources"), note=req.get("note"), at=req.get("at"))
        out = {"ok": True, "id": rid}
    elif op == "exists":
        # 断点续传去重（2026-10-11）：崩溃重启后判断 source 是否已上树，防重复插入
        _src = str(req.get("source") or "")
        _ce = sqlite3.connect(db)
        _row = _ce.execute("SELECT 1 FROM entries WHERE source=? LIMIT 1", (_src,)).fetchone()
        _ce.close()
        out = {"ok": True, "source": _src, "exists": _row is not None}
    elif op == "race":
        # 赛马检索 v2（2026-10-12 管理员定案：基因作为专门检索通道，三通道归一化计分）：
        #   语义 S = clamp((cos−0.30)/0.40, 0, 1) —— 与当前提问的相关度
        #   关键词 K = max(标签重合率, 词面命中)   —— 词面/标签证据
        #   血缘 B = 候选tags ∩ 本会话产出tags / 候选tags —— 会话基因通道（自偏好=对话连续性）
        #   总分 = wS×S + wK×K + wB×B（默认 1.0/0.7/0.3，可配）→ 池赛马、当轮直注、周期末补回共用
        # vec 缺席（8082 降级）→ S=0，K/B 仍工作，检索不断供（老契约）。
        _vec = req.get("vecs")
        _text = str(req.get("text") or "")
        _sid = str(req.get("sid") or "")
        _want = max(5, min(500, int(req.get("want") or 50)))
        _wS = float(req.get("wS") or 1.0)
        _wK = float(req.get("wK") or 0.7)
        _wB = float(req.get("wB") or 0.3)
        _vocab = tag_vocab(db)
        _qtags = set(compute_tags(_text, _vocab))
        if not _qtags and _text.strip():
            # 短查询兜底（2026-10-17 词组化迁移配套）：compute_tags 是长文档频次口径，
            # 短查询频次全 1 过不了门槛 → 词表最大匹配（贪心最长优先，整段吃掉长词组）
            _i = 0
            _txt = _text
            while _i < len(_txt):
                _matched = False
                for _L in range(min(12, len(_txt) - _i), 1, -1):
                    _g = _txt[_i:_i + _L]
                    if _g in _vocab:
                        _qtags.add(_g)
                        _i += _L
                        _matched = True
                        break
                if not _matched:
                    _i += 1
        _qtagset = set(_qtags)
        _q2 = set(g for g in _qtags if len(g) >= 2)
        _ranked = []
        _stagset = set()
        conn = sqlite3.connect(db)
        if _sid:
            for (tg,) in conn.execute("SELECT DISTINCT tag FROM tags WHERE source LIKE ?", (_sid + "/%",)):
                _stagset.add(tg)
        _erows = conn.execute("SELECT source, ws, head, body FROM entries").fetchall()
        _tmap = {}
        for _s, _tg in conn.execute("SELECT source, tag FROM tags"):
            _tmap.setdefault(_s, set()).add(_tg)
        _vrows = {}
        if _vec:
            _vrows = {r[0]: np.frombuffer(r[1], dtype=np.float32)
                      for r in conn.execute("SELECT source, vec FROM entry_vecs")}
        conn.close()
        _q = _norm(np.array(_vec, dtype=np.float32)) if _vec else None

        def _cover(shorts, longs):
            # 子串感知覆盖：short 直接命中，或被某个 long 包含（2026-10-17 词组化迁移配套——
            # 查询侧 2-4 字 gram 要能被 人工智能算法精英大赛 这类长词组覆盖，K/B 不断链）
            n = 0
            for s in shorts:
                if s in longs:
                    n += 1
                    continue
                hit = False
                for l in longs:
                    if s in l:
                        hit = True
                        break
                if hit:
                    n += 1
            return n

        for _r in _erows:
            _src, _ws, _head, _body = _r[0], _r[1], _r[2], _r[3]
            _hay = (_head or "") + "\n" + (_body or "")
            _tgset = _tmap.get(_src) or set()
            _tagr = (_cover(_qtagset, _tgset) / len(_qtagset)) if _qtagset else 0.0
            _kw = max(_tagr, 1.0 if any((g in _hay) for g in _q2) else 0.0)
            _sem = 0.0
            if _q is not None:
                _v = _vrows.get(_src)
                if _v is not None:
                    _cos = max(0.0, min(1.0, float(_q @ _norm(_v))))
                    _sem = max(0.0, min(1.0, (_cos - 0.30) / 0.40))
            _blood = (_cover(_tgset, _stagset) / len(_stagset)) if _stagset else 0.0
            _total = round(_wS * _sem + _wK * _kw + _wB * _blood, 4)
            if _total > 0:
                _ranked.append({"source": _src, "ws": _ws, "head": _head,
                                "lead": (_body or "")[:40], "S": round(_sem, 3), "K": round(_kw, 3),
                                "B": round(_blood, 3), "total": _total})
        _ranked.sort(key=lambda x: -x["total"])
        out = {"ok": True, "mode": ("sem+kw+blood" if _vec else "kw+blood"),
               "ranked": _ranked[:_want], "qtags": sorted(_qtags),
               "weights": {"S": _wS, "K": _wK, "B": _wB}}
    elif op == "vec_cache_set":
        # 条目向量缓存（注入池余弦表的数据源）：批量 upsert
        _items = req.get("items") or []
        conn = sqlite3.connect(db)
        for it in _items:
            if it.get("source") and it.get("vec"):
                conn.execute("INSERT OR REPLACE INTO entry_vecs(source,vec) VALUES(?,?)",
                             (it["source"], np.asarray(it["vec"], dtype=np.float32).tobytes()))
        conn.commit()
        conn.close()
        out = {"ok": True, "cached": len(_items)}
    elif op == "bodies":
        # 批量取正文（注入池整头整正文口径）
        _srcs = [s for s in (req.get("sources") or []) if s]
        conn = sqlite3.connect(db)
        _bodies = {}
        for s in _srcs:
            r = conn.execute("SELECT body FROM entries WHERE source=?", (s,)).fetchone()
            _bodies[s] = (r[0] if r and r[0] else "")
        conn.close()
        out = {"ok": True, "bodies": _bodies}
    elif op == "wt_tree":
        out = op_wt_tree(t)
    elif op == "tag_table":
        conn = sqlite3.connect(db)
        rows = conn.execute("SELECT tag, COUNT(DISTINCT source) c FROM tags GROUP BY tag ORDER BY c DESC LIMIT ?",
                             (int(req.get("limit") or 100),)).fetchall()
        conn.close()
        out = {"ok": True, "tags": [{"tag": r[0], "count": r[1]} for r in rows]}
    elif op == "tag_filter":
        wanted = [x.strip() for x in str(req.get("tags") or "").split(",") if x.strip()]
        if not wanted:
            out = {"ok": True, "hits": []}
        else:
            conn = sqlite3.connect(db)
            ph = ",".join("?" * len(wanted))
            rows = conn.execute(
                "SELECT e.source, e.ws, e.head FROM entries e WHERE e.source IN ("
                " SELECT source FROM tags WHERE tag IN (%s) GROUP BY source HAVING COUNT(DISTINCT tag)=%d)"
                " ORDER BY e.grew_at DESC LIMIT ?" % (ph, len(wanted)),
                wanted + [int(req.get("limit") or 50)]).fetchall()
            conn.close()
            out = {"ok": True, "hits": [{"source": r[0], "ws": r[1], "snippet": (r[2] or "")[:80]} for r in rows]}
    elif op == "entry_get":
        # 单条记忆详情（tag 筛选命中点开用）：source 精确取正文 + tags
        _src = str(req.get("source") or "").strip()
        if not _src:
            out = {"ok": False, "error": "op=entry_get 需要 source"}
        else:
            conn = sqlite3.connect(db)
            r = conn.execute("SELECT source, ws, head, body, grew_at FROM entries WHERE source=?", (_src,)).fetchone()
            if not r:
                conn.close()
                out = {"ok": False, "error": "条目不存在: " + _src}
            else:
                _tags = [t[0] for t in conn.execute(
                    "SELECT tag FROM tags WHERE source=? ORDER BY tag", (_src,)).fetchall()]
                conn.close()
                out = {"ok": True, "entry": {"source": r[0], "ws": r[1], "head": r[2],
                                             "body": r[3], "grewAt": r[4], "tags": _tags}}
    elif op == "entry_tags":
        out = op_entry_tags(db, str(req.get("source") or ""))
    elif op == "bili_blocks":
        # P3·bili 通道（2026-10-19 双轨定案）：bili（billion-context 代理层）在上下文
        # 视图压缩会话（不动物理日志），blocks 表记账每个压缩块的 ref 区间。新 active 块
        # = 一段内容刚被压出视图 → 提炼上树。本 op 只读（WAL 并发读安全，mode=ro），
        # 绝不写 bili 库。after=水位（created_at，含），prefix=会话键前 8 位。
        _bdb = str(req.get("db") or r"C:\Users\Feng\.local\share\billion-context\sessions\index.db")
        _pfx = str(req.get("prefix") or "")
        _after = int(req.get("after") or 0)
        if not _pfx:
            out = {"ok": False, "error": "prefix 必填（会话键前 8 位）"}
        elif not os.path.exists(_bdb):
            out = {"ok": False, "missing": True, "error": "bili 库不存在（billion-context 未启用？）"}
        else:
            try:
                con = sqlite3.connect("file:" + _bdb.replace("?", "%3f") + "?mode=ro", uri=True, timeout=5)
                rows = con.execute(
                    "SELECT block_id, session_id, start_ref, end_ref, created_at, payload_json"
                    " FROM blocks WHERE active=1 AND created_at>=?"
                    " AND (session_id LIKE ? OR session_id LIKE ?)"
                    " ORDER BY created_at",
                    (_after, "session-" + _pfx + "%", _pfx + "%")).fetchall()
                con.close()
                blocks = []
                for bid, sid, r0, r1, at, pj in rows:
                    summary, topic = "", ""
                    try:
                        p = json.loads(pj or "{}")
                        summary = str(p.get("summary") or "")
                        topic = str(p.get("topic") or "")
                    except Exception:
                        pass
                    blocks.append({"block_id": bid, "session_id": sid, "start_ref": int(r0),
                                   "end_ref": int(r1), "created_at": int(at),
                                   "summary": summary, "topic": topic})
                out = {"ok": True, "blocks": blocks}
            except Exception as e:
                out = {"ok": False, "error": "bili 读失败：" + str(e)[:200]}
    elif op == "bili_users":
        # bili 块区间取材：user/assistant 的 text 正文（content 表 wire JSON 的 text 字段）。
        # kind 限定 text（reasoning/tool-call/tool-result 不取），按 seq 升序。
        _bdb = str(req.get("db") or r"C:\Users\Feng\.local\share\billion-context\sessions\index.db")
        _bsid = str(req.get("session_id") or "")
        _r0, _r1 = int(req.get("from_ref") or 0), int(req.get("to_ref") or 0)
        if not _bsid:
            out = {"ok": False, "error": "session_id 必填"}
        elif not os.path.exists(_bdb):
            out = {"ok": False, "missing": True, "error": "bili 库不存在（billion-context 未启用？）"}
        else:
            try:
                con = sqlite3.connect("file:" + _bdb.replace("?", "%3f") + "?mode=ro", uri=True, timeout=5)
                rows = con.execute(
                    "SELECT m.role, m.seq, c.bytes FROM messages m"
                    " JOIN content c ON c.hash=m.content_hash"
                    " WHERE m.session_id=? AND m.ref_num BETWEEN ? AND ?"
                    " AND m.kind='text' AND m.role IN ('user','assistant') ORDER BY m.seq",
                    (_bsid, _r0, _r1)).fetchall()
                con.close()
                texts = []
                for role, seq, b in rows:
                    try:
                        j = json.loads((bytes(b).decode("utf-8", "replace") if b is not None else "") or "{}")
                        txt = str(j.get("text") or "").strip()
                    except Exception:
                        txt = ""
                    if txt:
                        texts.append({"role": str(role), "seq": int(seq), "text": txt})
                out = {"ok": True, "texts": texts}
            except Exception as e:
                out = {"ok": False, "error": "bili 读失败：" + str(e)[:200]}
    else:
        out = {"error": "未知 op：" + str(op)}
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    _cli()
