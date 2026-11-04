# -*- coding: utf-8 -*-
"""脑图 · 树核（v1，原世界树 core；2026-11-04 改名迁移，op 协议不变）

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
import random
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
-- ── 脑图 v1（2026-11-04）：元记忆/脑区/指纹基建 ──
CREATE TABLE IF NOT EXISTS mm (
  mm_id  TEXT PRIMARY KEY,          -- {source}#s{i}
  event  TEXT NOT NULL,             -- 所属元事件（=entries.source）
  text   TEXT NOT NULL,
  region TEXT                       -- 脑区（吸引盆 attractor 的 mm_id）
);
CREATE INDEX IF NOT EXISTS idx_mm_event ON mm(event);
CREATE INDEX IF NOT EXISTS idx_mm_region ON mm(region);
CREATE TABLE IF NOT EXISTS mm_vecs (mm_id TEXT PRIMARY KEY, vec BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS mm_region (basin TEXT PRIMARY KEY, size INTEGER, rep TEXT);
CREATE TABLE IF NOT EXISTS mm_knn (mm_id TEXT PRIMARY KEY, nbrs TEXT);  -- JSON 数组
CREATE TABLE IF NOT EXISTS mm_link (a TEXT, b TEXT, cos REAL, PRIMARY KEY(a,b));  -- 睡眠近合并
CREATE TABLE IF NOT EXISTS entry_region (event TEXT PRIMARY KEY, basin TEXT, coverage REAL);
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


# ══════════════════ 脑图 v1：睡眠 / 脑区 / 元记忆 ══════════════════

def split_mm(text):
    """元记忆句拆（E6 口径）：行拆 → 。？！切分 → ≥6 字保留；事件内去重。"""
    sents, seen = [], set()
    for ln in str(text or "").split("\n"):
        buf = ""
        for ch in ln:
            buf += ch
            if ch in "。？！?!":
                s = buf.strip()
                if len(s) >= 6 and s not in seen:
                    seen.add(s); sents.append(s)
                buf = ""
        s = buf.strip()
        if len(s) >= 6 and s not in seen:
            seen.add(s); sents.append(s)
    return sents


def sleep_insert(db_path, source, text, embed_url=None):
    """脑图睡眠（v1 增量）：句拆→嵌入→全库 top-1 邻定盆（随邻盆，孤立自成盆）→
    cos≥0.90 近合并挂 mm_link→事件多数盆 entry_region。失败不抛（缺勤不阻塞插入）。"""
    try:
        sents = split_mm(text)
        if not sents:
            return {"ok": True, "mm": 0, "note": "无可拆句"}
        vecs = embed_texts(sents, url=embed_url or "http://127.0.0.1:8082/v1/embeddings")
        c = sqlite3.connect(db_path)
        new = []
        for i, (s, v) in enumerate(zip(sents, vecs)):
            mid = "%s#s%d" % (source, i)
            c.execute("INSERT OR REPLACE INTO mm(mm_id,event,text,region) VALUES(?,?,?,NULL)", (mid, source, s))
            c.execute("INSERT OR REPLACE INTO mm_vecs(mm_id,vec) VALUES(?,?)",
                      (mid, np.asarray(v, dtype=np.float32).tobytes()))
            new.append((mid, _norm(np.asarray(v, dtype=np.float32))))
        rows = c.execute("SELECT mm_id, vec FROM mm_vecs").fetchall()
        names = np.array([r[0] for r in rows])
        V = np.stack([np.frombuffer(r[1], np.float32) for r in rows]).astype(np.float32)
        Vn = V / np.maximum(np.linalg.norm(V, axis=1), 1e-8)[:, None]
        same_ev = np.array([n.split("#")[0] == source for n in names])
        links = 0
        for mid, qv in new:
            sims = Vn @ qv
            sims[names == mid] = -1.0
            sims[same_ev] = -1.0                     # 定盆排除同事件（内部睡眠语义）
            order = np.argsort(-sims)[:10]
            best = int(order[0]); bc = float(sims[best])
            region = None
            if bc > 0:
                row = c.execute("SELECT region FROM mm WHERE mm_id=?", (names[best],)).fetchone()
                if row and row[0]:
                    region = row[0]
                if bc >= 0.90:
                    a, b = sorted([mid, str(names[best])])
                    c.execute("INSERT OR IGNORE INTO mm_link(a,b,cos) VALUES(?,?,?)", (a, b, round(bc, 4)))
                    links += 1
            if region is None:
                region = mid                          # 孤立 → 自成新盆（attractor=自己）
            c.execute("UPDATE mm SET region=? WHERE mm_id=?", (region, mid))
            c.execute("INSERT OR REPLACE INTO mm_knn(mm_id,nbrs) VALUES(?,?)",
                      (mid, json.dumps([str(names[j]) for j in order])))
        from collections import Counter
        cnt = Counter(r[0] for r in c.execute("SELECT region FROM mm WHERE event=?", (source,)) if r[0])
        if cnt:
            b, n = cnt.most_common(1)[0]
            c.execute("INSERT OR REPLACE INTO entry_region(event,basin,coverage) VALUES(?,?,?)",
                      (source, b, round(n / sum(cnt.values()), 3)))
            touched = {r[0] for r in c.execute("SELECT region FROM mm WHERE event=?", (source,)) if r[0]}
            for bb in touched:
                c.execute("INSERT OR REPLACE INTO mm_region(basin,size,rep) VALUES(?,?,?)",
                          (bb, c.execute("SELECT COUNT(*) FROM mm WHERE region=?", (bb,)).fetchone()[0], bb))
        c.commit(); c.close()
        return {"ok": True, "mm": len(new), "links": links}
    except Exception as e:
        sys.stderr.write("[naotu] sleep_insert 失败（不阻塞插入）: %r\n" % (e,))
        return {"ok": False, "err": str(e)}


def region_build(db_path):
    """全量脑区重建：kNN 图 → top-1 指针追踪吸引盆 → mm.region / mm_knn / mm_region / entry_region。"""
    t0 = time.time()
    c = sqlite3.connect(db_path)
    rows = c.execute("SELECT mm_id, vec FROM mm_vecs").fetchall()
    if not rows:
        c.close(); return {"ok": True, "regions": 0, "secs": 0}
    names = [r[0] for r in rows]
    V = np.stack([np.frombuffer(r[1], np.float32) for r in rows]).astype(np.float32)
    Vn = V / np.maximum(np.linalg.norm(V, axis=1), 1e-8)[:, None]
    n = len(names); K = 10
    nbrs = np.zeros((n, K), dtype=np.int32)
    for s0 in range(0, n, 1024):
        e0 = min(s0 + 1024, n)
        sim = Vn[s0:e0] @ Vn.T
        for r in range(e0 - s0):
            sim[r, s0 + r] = -1.0
        nbrs[s0:e0] = np.argpartition(-sim, K, axis=1)[:, :K]
    nxt = nbrs[:, 0].astype(np.int64)                 # top-1 指针图
    basin = [None] * n
    for i in range(n):
        if basin[i] is not None:
            continue
        path, onpath, cur = [], set(), i
        while basin[cur] is None and cur not in onpath:
            onpath.add(cur); path.append(cur); cur = int(nxt[cur])
        b = basin[cur] if basin[cur] is not None else names[path[-1]]
        for p in path:
            basin[p] = b
    c.execute("UPDATE mm SET region=NULL")
    c.executemany("UPDATE mm SET region=? WHERE mm_id=?", ((basin[i], names[i]) for i in range(n)))
    c.executemany("INSERT OR REPLACE INTO mm_knn(mm_id,nbrs) VALUES(?,?)",
                  ((names[i], json.dumps([names[j] for j in nbrs[i]])) for i in range(n)))
    from collections import Counter
    sizes = Counter(basin)
    c.executemany("INSERT OR REPLACE INTO mm_region(basin,size,rep) VALUES(?,?,?)",
                  ((b, sz, b) for b, sz in sizes.items()))
    evs = {}
    for i in range(n):
        evs.setdefault(names[i].split("#")[0], []).append(basin[i])
    c.executemany("INSERT OR REPLACE INTO entry_region(event,basin,coverage) VALUES(?,?,?)",
                  ((e, cnt.most_common(1)[0][0], round(cnt.most_common(1)[0][1] / sum(cnt.values()), 3))
                   for e, cnt in ((e, Counter(v)) for e, v in evs.items())))
    c.commit(); c.close()
    return {"ok": True, "mm": n, "regions": len(sizes), "events_mapped": len(evs),
            "secs": round(time.time() - t0, 1)}


def mm_backfill(db_path, e6_path):
    """E6 资产回填：e6.db meta_memories/mm_vecs → 生产库（INSERT OR IGNORE，可重跑）。"""
    c = sqlite3.connect(db_path)
    c.execute("ATTACH DATABASE ? AS e6", (e6_path,))
    n1 = c.execute("SELECT COUNT(*) FROM e6.meta_memories").fetchone()[0]
    c.execute("INSERT OR IGNORE INTO mm(mm_id,event,text) "
              "SELECT mm_id, event_source, text FROM e6.meta_memories")
    c.execute("INSERT OR IGNORE INTO mm_vecs(mm_id,vec) "
              "SELECT source, vec FROM e6.mm_vecs")
    got1 = c.execute("SELECT COUNT(*) FROM mm").fetchone()[0]
    c.commit(); c.close()
    return {"ok": True, "e6_mm": n1, "now_mm": got1, "note": "回填后请跑 region_build"}


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
                _sleep = sleep_insert(db, source, text, embed_url=req.get("embedUrl"))
                t.flush()
                out = {"ok": True, "path": path, "entries": len(t.entries), "nodes": len(t.nodes),
                       "sleep": _sleep, "tags": [r[0] for r in conn_tags(db, source)]}
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
            # 血缘 B（2026-10-31 修分母 bug）：设计意图=候选tags∩会话tags/候选tags（该候选
            # 有多少比例的 tag 是本会话产出的=会话亲和度）。原实现误除以 len(_stagset)（整会话
            # tag 并集，大会话上千）→ B≈0.00x 纯噪声，血缘通道从未生效（E2 BB 实测 15 条同会话
            # 相关条零提升实证）。同会话候选 tags⊆会话并集 → B≈1；跨会话共享词表 → B=词表重叠率。
            _blood = (_cover(_tgset, _stagset) / max(1, len(_tgset))) if (_stagset and _tgset) else 0.0
            _total = round(_wS * _sem + _wK * _kw + _wB * _blood, 4)
            if _total > 0:
                _ranked.append({"source": _src, "ws": _ws, "head": _head,
                                "lead": (_body or "")[:40], "S": round(_sem, 3), "K": round(_kw, 3),
                                "B": round(_blood, 3), "total": _total})

        # ── 脑图 v1 附加层（2026-11-04）：R 指纹区通道 → S_mm 句级精修 → 下滑附加召回 ──
        # 指针：mm 表空（未回填/未睡眠）时整层跳过，race 行为=旧版逐位一致。
        try:
            _wR = float(req.get("wR") or 0.3)
            _rmode = str(req.get("regionMode") or "soft")
            _descent = req.get("descentOn", True) is not False
            _c2 = sqlite3.connect(db)
            _has_mm = _c2.execute("SELECT COUNT(*) FROM mm").fetchone()[0]
            if _has_mm:
                _regE = dict(_c2.execute("SELECT event, basin FROM entry_region").fetchall())
                _fp = {}
                if _sid:
                    _cnt = collections.Counter()
                    for (_b,) in _c2.execute(
                            "SELECT m.region FROM mm m WHERE m.event LIKE ? AND m.region IS NOT NULL",
                            (_sid + "/%",)):
                        _cnt[_b] += 1
                    if _cnt:
                        _ks = list(_cnt.keys())
                        _raw = np.array([_cnt[k] for k in _ks], dtype=float)
                        _pr = np.exp((_raw - _raw.max()) / 3.0)
                        _pr = _pr / _pr.sum()
                        _fp = {k: float(v) for k, v in zip(_ks, _pr) if v >= 0.05}
                for r in _ranked:
                    r["R"] = _fp.get(_regE.get(r["source"]) or "", 0.0)
                    r["total"] = round(_wS * r["S"] + _wK * r["K"] + _wB * r["B"] + _wR * r["R"], 4)
                if _rmode == "hard" and _fp:
                    _ranked = [r for r in _ranked if r["R"] > 0 or _regE.get(r["source"]) is None]
                # S_mm：top100 候选句级精修（元记忆双索引；默认关——E2D 实测两种口径均回退
                # [全量精修−7.1pt/低分带救援−4.8pt]，句级单句相似会挤掉真相关条目。opt-in。）
                if _q is not None and req.get("smmOn") is True:
                    for r in _ranked[:100]:
                        _best = -1.0
                        for (v2,) in _c2.execute(
                                "SELECT vec FROM mm_vecs WHERE mm_id IN (SELECT mm_id FROM mm WHERE event=?)",
                                (r["source"],)):
                            _cq = float(_q @ _norm(np.frombuffer(v2, np.float32)))
                            if _cq > _best:
                                _best = _cq
                        if _best > 0:
                            _smm = max(0.0, min(1.0, (_best - 0.30) / 0.40))
                            # 低分带救援（2026-11-04 E2D 实测回退 7.1pt 后收窄）：S_mm 只救
                            # S_entry<0.5 的词汇鸿沟条目（单句匹配强但全文向量失联），不抬
                            # 饱和带——饱和带排序=隐式族轮转机制，句级证据不得扰动。
                            if _smm > r["S"] and r["S"] < 0.5:
                                r["S"] = round(_smm, 3)
                                r["S"] = min(r["S"], 0.85)          # 救援上限：不得进饱和带
                                r["total"] = round(_wS * r["S"] + _wK * r["K"] + _wB * r["B"] + _wR * r["R"], 4)
                    _ranked.sort(key=lambda x: -x["total"])
                # 下滑附加召回：门控区（无 sid=全域随机）撒 16 种子贪心下滑→终点事件补尾部
                if _descent and _q is not None:
                    _rng = random.Random(20261104)
                    if _fp:
                        _pool = [r0[0] for r0 in _c2.execute(
                            "SELECT mm_id FROM mm WHERE region IN (%s)" % ",".join("?" * len(_fp)),
                            tuple(_fp.keys())).fetchall()]
                    else:
                        _pool = [r0[0] for r0 in _c2.execute(
                            "SELECT mm_id FROM mm_vecs ORDER BY RANDOM() LIMIT 200").fetchall()]
                    if _pool:
                        _seen_ev = {r["source"] for r in _ranked[:_want]}
                        _extra = {}
                        for _sd in _rng.sample(_pool, min(16, len(_pool))):
                            def _mv(m0):
                                _rw = _c2.execute("SELECT vec FROM mm_vecs WHERE mm_id=?", (m0,)).fetchone()
                                return _norm(np.frombuffer(_rw[0], np.float32)) if _rw else None
                            _cur = _sd; _cv = _mv(_cur)
                            if _cv is None:
                                continue
                            for _st in range(12):
                                _nb = _c2.execute("SELECT nbrs FROM mm_knn WHERE mm_id=?", (_cur,)).fetchone()
                                if not _nb:
                                    break
                                _bestm, _bestc = None, float(_cv @ _q)
                                for _m2 in json.loads(_nb[0]):
                                    _v3 = _mv(_m2)
                                    if _v3 is None:
                                        continue
                                    _c3 = float(_v3 @ _q)
                                    if _c3 > _bestc:
                                        _bestm, _bestc = _m2, _c3
                                if _bestm is None:
                                    break
                                _cur, _cv = _bestm, _mv(_bestm)
                            _ev4 = _c2.execute("SELECT event FROM mm WHERE mm_id=?", (_cur,)).fetchone()
                            if _ev4 and _ev4[0] not in _seen_ev:
                                _seen_ev.add(_ev4[0])
                                _extra[_ev4[0]] = _bestc if _bestm else float(_cv @ _q)
                        for _ev5, _c5 in sorted(_extra.items(), key=lambda kv: -kv[1])[:5]:
                            _row5 = next((r0 for r0 in _erows if r0[0] == _ev5), None)
                            if _row5:
                                _ranked.append({"source": _ev5, "ws": _row5[1], "head": _row5[2],
                                                "lead": (_row5[3] or "")[:40],
                                                "S": round(max(0.0, min(1.0, (_c5 - 0.30) / 0.40)), 3),
                                                "K": 0.0, "B": 0.0, "R": 0.0, "descent": True,
                                                "total": round(_c5, 4)})
            _c2.close()
        except Exception as _e:
            sys.stderr.write("[naotu] race 附加层失败（回退纯三通道）: %r\n" % (_e,))
        _ranked.sort(key=lambda x: -x["total"])
        out = {"ok": True, "mode": ("sem+kw+blood+naotu" if _vec else "kw+blood+naotu"),
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
    elif op == "graph_view":
        # v2 图架构·网络图数据（2026-10-30）：查询/种子来源 → kNN 图（TAU=0.65,E0定案）上
        # BFS 扩 hops 跳取子图，供前端力导向渲染。图现算不持久化（建图 0.5s，随插入自动更新无失效边）。
        import numpy as _np
        _sources = req.get("sources") or []
        _text = str(req.get("text") or "")
        _vecs = req.get("vecs")
        _hops = max(1, min(3, int(req.get("hops") or 2)))
        _cap = max(10, min(200, int(req.get("cap") or 60)))
        _knb, _tau = 10, 0.65
        conn = sqlite3.connect(db)
        srcs, vecs, heads = [], [], []
        for s, v, hd in conn.execute(
                "SELECT e.source, v.vec, e.head FROM entry_vecs v JOIN entries e ON e.source=v.source"):
            if v is None: continue
            srcs.append(s); vecs.append(_np.frombuffer(v, dtype=_np.float32)); heads.append(hd or "")
        conn.close()
        if not srcs:
            out = {"ok": False, "error": "库内无 fam 向量"}
        else:
            V = _np.stack(vecs); V = V / (_np.linalg.norm(V, axis=1, keepdims=True) + 1e-9)
            N = len(srcs)
            seed_ix = []
            ix_of = {s: i for i, s in enumerate(srcs)}
            for s in _sources[:16]:
                if s in ix_of: seed_ix.append(ix_of[s])
            qsim = None
            if _text and _vecs:
                qv = _np.array(_vecs, dtype=_np.float32); qv = qv / (_np.linalg.norm(qv) + 1e-9)
                qsim = V @ qv
                for i in _np.argsort(-qsim)[:8]:
                    if int(i) not in seed_ix: seed_ix.append(int(i))
            if not seed_ix:
                out = {"ok": False, "error": "无有效种子（sources 未命中且无查询向量）"}
            else:
                nbr = _np.zeros((N, _knb), dtype=_np.int32)
                wgt = _np.zeros((N, _knb), dtype=_np.float32)
                B = 512
                for st in range(0, N, B):
                    en = min(st + B, N)
                    S = V[st:en] @ V.T
                    idx = _np.argpartition(-S, _knb, axis=1)[:, :_knb]
                    for r in range(en - st):
                        cols = idx[r]; w = S[r, cols]; o = _np.argsort(-w)
                        nbr[st + r] = cols[o]; wgt[st + r] = w[o]
                und = [dict() for _ in range(N)]
                for i in range(N):
                    for j, w, kp in zip(nbr[i], wgt[i], (wgt[i] >= _tau).tolist()):
                        if not kp or j == i: continue
                        j = int(j)
                        if w > und[i].get(j, -1): und[i][j] = float(w)
                        if w > und[j].get(i, -1): und[j][i] = float(w)
                seen = set(seed_ix); frontier = list(seed_ix); edges = []
                for _step in range(_hops):
                    cand = []
                    for i in frontier:
                        for j, w in und[i].items():
                            if j not in seen: cand.append((-w, i, j))
                    cand.sort()
                    room = _cap - len(seen)
                    added = []
                    for negw, i, j in cand[:max(0, room * 3)]:
                        if j in seen or len(seen) >= _cap: continue
                        seen.add(j); added.append(j); edges.append((i, j, -negw))
                        if len(seen) >= _cap: break
                    if not added or len(seen) >= _cap: break
                    frontier = added
                seed_set = set(seed_ix)
                for i in seed_ix:
                    for j, w in und[i].items():
                        if j in seed_set and i < j: edges.append((i, j, w))
                order = sorted(seen)
                pos = {i: k for k, i in enumerate(order)}
                deg = {i: len(und[i]) for i in order}
                out = {"ok": True,
                       "nodes": [{"source": srcs[i], "head": heads[i][:60], "deg": deg[i],
                                  "seed": i in seed_set,
                                  "qsim": round(float(qsim[i]), 4) if qsim is not None else None}
                                 for i in order],
                       "edges": [[pos[a], pos[b], round(w, 4)] for a, b, w in edges if a in pos and b in pos],
                       "total": N}
    elif op == "vec_count":
        # v0.9.1：dream 缓存失效判据 —— entry_vecs 行数（条目数不变 → 簇划分稳定）
        conn = sqlite3.connect(db)
        (n,) = conn.execute("SELECT COUNT(*) FROM entry_vecs").fetchone()
        conn.close()
        out = {"ok": True, "count": int(n)}
    elif op == "dream":
        # v2 图架构·做梦（E0 移植，2026-10-30）：kNN 图 → 两段式种子（均匀测量+新鲜巩固）
        # → 贪心+概率步游走 → 盆合并成簇 → 路过计数（activation 做梦侧）+ 死节点候选。
        # 纯算法层不调 LLM 不写库；簇摘要/死节点三选留给上层管线。
        import random as _rd
        import numpy as _np
        _nd = max(1, min(50, int(req.get("n_dreams") or 10)))
        _seed_mult = max(1, min(16, int(req.get("seed_mult") or 4)))
        _tau = float(req.get("tau") or 0.65)
        _rd.seed(20261030)
        conn = sqlite3.connect(db)
        srcs, vecs, heads, times = [], [], [], []
        for s, v, hd, t in conn.execute(
                "SELECT e.source, v.vec, e.head, e.grew_at FROM entry_vecs v JOIN entries e ON e.source=v.source"):
            if v is None: continue
            srcs.append(s); vecs.append(_np.frombuffer(v, dtype=_np.float32)); heads.append(hd or ""); times.append(t or "")
        conn.close()
        if len(srcs) < 50:
            out = {"ok": False, "error": "成员过少（<50），不值得做梦"}
        else:
            V = _np.stack(vecs); V = V / (_np.linalg.norm(V, axis=1, keepdims=True) + 1e-9)
            N = len(srcs)
            _knb = 10
            nbr = _np.zeros((N, _knb), dtype=_np.int32); wgt = _np.zeros((N, _knb), dtype=_np.float32)
            B = 512
            for st in range(0, N, B):
                en = min(st + B, N)
                S = V[st:en] @ V.T
                idx = _np.argpartition(-S, _knb, axis=1)[:, :_knb]
                for r in range(en - st):
                    cols = idx[r]; w = S[r, cols]; o = _np.argsort(-w)
                    nbr[st + r] = cols[o]; wgt[st + r] = w[o]
            und = [dict() for _ in range(N)]
            for i in range(N):
                for j, w, kp in zip(nbr[i], wgt[i], (wgt[i] >= _tau).tolist()):
                    if not kp or j == i: continue
                    j = int(j)
                    if w > und[i].get(j, -1): und[i][j] = float(w)
                    if w > und[j].get(i, -1): und[j][i] = float(w)
            dens = _np.array([(sum(nb.values()) / len(nb)) if nb else 0.0 for nb in und], dtype=_np.float64)
            deg = _np.array([len(x) for x in und])
            iso = [i for i in range(N) if deg[i] == 0]
            order_time = sorted(range(N), key=lambda i: times[i])
            fresh = set(order_time[int(N * 0.9):])
            import math as _m
            n_seeds = round(_m.sqrt(N) * _seed_mult)
            visits = _np.zeros(N, dtype=_np.int64)
            visited_ever = _np.zeros(N, dtype=bool)
            all_paths = []
            MAX_STEPS, GREEDY_P = 8, 0.5
            def _pick(i, greedy):
                nb = und[i]
                if not nb: return None
                if greedy:
                    better = [(w, j) for j, w in nb.items() if dens[j] > dens[i]]
                    if not better: return None
                    better.sort(reverse=True)
                    return better[0][1]
                js, ws = zip(*nb.items())
                wsa = _np.array(ws); pr = wsa / wsa.sum()
                return int(_rd.choices(js, weights=pr, k=1)[0])
            for _d in range(_nd):
                n_fresh = int(n_seeds * 0.3)
                seeds = [_rd.randrange(N) for _ in range(n_seeds - n_fresh)]
                pool = list(fresh)
                seeds += [pool[_rd.randrange(len(pool))] for _ in range(n_fresh)] if pool else []
                for s in seeds:
                    path = [s]; cur = s
                    for _st in range(MAX_STEPS):
                        nxt = _pick(cur, _rd.random() < GREEDY_P)
                        if nxt is None: break
                        path.append(nxt); cur = nxt
                    for x in path: visits[x] += 1; visited_ever[x] = True
                    all_paths.append((path, path[-1]))
            from collections import defaultdict as _dd
            basins = _dd(set)
            for p, t in all_paths: basins[t] |= set(p)
            keys = list(basins.keys()); changed = True
            while changed:
                changed = False
                for a in range(len(keys)):
                    for b in range(a + 1, len(keys)):
                        ka, kb = keys[a], keys[b]
                        if ka not in basins or kb not in basins: continue
                        A, Bc = basins[ka], basins[kb]
                        inter = len(A & Bc)
                        if inter and inter / min(len(A), len(Bc)) > 0.5:
                            A |= Bc; del basins[kb]; changed = True; break
                    if changed: break
            big = sorted(basins.values(), key=len, reverse=True)
            never = [i for i in range(N) if not visited_ever[i] and deg[i] > 0]
            def _rep(m):
                return max(m, key=lambda x: visits[x])
            # v0.9.1：簇作为浏览分区 —— 前 120 簇带 id/成员，簇间边=跨簇 kNN 边计数
            TOPC = 120
            cid = {}
            clusters_out = []
            for ci, m in enumerate(big[:TOPC]):
                r = _rep(m)
                clusters_out.append({"id": ci, "size": len(m), "rep": srcs[r],
                                      "repHead": heads[r][:60],
                                      "visits": int(visits[r]),
                                      "members": [srcs[x] for x in sorted(m, key=lambda x: -visits[x])][:40]})
                for x in m: cid[x] = ci
            links = {}
            for i2 in range(N):
                if i2 not in cid: continue
                for j2 in und[i2]:
                    if j2 in cid and cid[i2] < cid[j2]:
                        key2 = (cid[i2], cid[j2])
                        rec = links.get(key2)
                        if rec is None: links[key2] = rec = [0, 0.0]
                        rec[0] += 1; rec[1] += float(und[i2][j2])
            cluster_links = [[a, b, c, round(s / c, 4)] for (a, b), (c, s) in
                             sorted(links.items(), key=lambda kv: -kv[1][0])[:180]]
            out = {"ok": True, "total": N, "n_dreams": _nd, "seedsPerDream": n_seeds,
                   "clusters": clusters_out,
                   "clusterLinks": cluster_links,
                   "nClusters": len(basins),
                   "visitsTop": [{"source": srcs[i], "visits": int(visits[i]), "head": heads[i][:60]}
                                 for i in _np.argsort(-visits)[:200] if visits[i] > 0],
                   "visitedRatio": round(float((visits > 0).mean()), 4),
                   "dead": {"isolated": len(iso), "zeroVisit": len(never),
                            "samples": [srcs[i] + "  " + heads[i][:40] for i in (iso[:25] + never[:25])]}}
    elif op == "mm_backfill":
        _lk = _lock_insert(db)
        try:
            out = mm_backfill(db, str(req.get("e6db") or r"E:\DSH_data\世界树\_dev\e6.db"))
        finally:
            _unlock_insert(_lk)
    elif op == "region_build":
        _lk = _lock_insert(db)
        try:
            out = region_build(db)
        finally:
            _unlock_insert(_lk)
    elif op == "mm_stats":
        _c3 = sqlite3.connect(db)
        out = {"ok": True,
               "mm": _c3.execute("SELECT COUNT(*) FROM mm").fetchone()[0],
               "regions": _c3.execute("SELECT COUNT(*) FROM mm_region").fetchone()[0],
               "entry_region": _c3.execute("SELECT COUNT(*) FROM entry_region").fetchone()[0],
               "links": _c3.execute("SELECT COUNT(*) FROM mm_link").fetchone()[0]}
        _c3.close()
    else:
        out = {"error": "未知 op：" + str(op)}
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    _cli()
