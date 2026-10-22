# -*- coding: utf-8 -*-
"""世界树 · 五档稀释检查点

管理员 2026-10-10 定纲（防记忆库丢失）：
  五档：1月+ / 7d+ / 24h+ / 6h+ / 1h+
  1月和 7d = **全量快照**（整库拷贝，直接恢复）
  24h / 6h / 1h = **增量**（相对 7d 基线的新增+削减部分）
  三条增量档各有两条恢复路径：依靠 1M 蓝本或 7D 蓝本

文件布局：
  checkpoints/
    full_1m_<ts>.db       全量快照（整库 .db 文件）
    full_7d_<ts>.db       全量快照
    incr_24h_<ts>.jsonl   增量日志（JSONL，逐条操作记录）
    incr_6h_<ts>.jsonl
    incr_1h_<ts>.jsonl

增量 JSONL 行格式：
  {"op":"ins","source":"...","node":N,"head":"...","body":"...","at":"..."}
  {"op":"del","source":"...","at":"..."}

用法（CLI）：
  python checkpoint.py snapshot           # 按时间触发应到的档位
  python checkpoint.py snapshot --force 1h # 强制打一档
  python checkpoint.py list               # 列出全部检查点
  python checkpoint.py restore <file>     # 从全量恢复
  python checkpoint.py restore <full> <incr1> [incr2 ...]  # 全量+增量恢复
"""
import argparse
import json
import os
import shutil
import sqlite3
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
DB = r"E:\DSH_data\世界树\data\worldtree.db"
CKPT_DIR = r"E:\DSH_data\世界树\checkpoints"

# 档位定义：名称 → 间隔秒数（触发条件：距上次该档检查点 ≥ 间隔）
TIERS = [
    ("1m",  30 * 86400),    # 1 月
    ("7d",   7 * 86400),    # 7 天
    ("24h",    24 * 3600),  # 24 小时
    ("6h",      6 * 3600),  # 6 小时
    ("1h",      1 * 3600),  # 1 小时
]
FULL_TIERS = {"1m", "7d"}
INCR_TIERS = {"24h", "6h", "1h"}


def _ts():
    return time.strftime("%Y%m%d_%H%M%S")


def _ckpt_meta():
    """读各档位上次检查点时间。"""
    meta_f = os.path.join(CKPT_DIR, "_meta.json")
    if os.path.exists(meta_f):
        return json.load(open(meta_f, encoding="utf-8"))
    return {}


def _save_meta(meta):
    os.makedirs(CKPT_DIR, exist_ok=True)
    json.dump(meta, open(os.path.join(CKPT_DIR, "_meta.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


# ── 全量快照 ────────────────────────────────────────────────────────────────
def snapshot_full(tier):
    """整库拷贝。"""
    os.makedirs(CKPT_DIR, exist_ok=True)
    dst = os.path.join(CKPT_DIR, "full_%s_%s.db" % (tier, _ts()))
    shutil.copy2(DB, dst)
    sz = os.path.getsize(dst)
    print("✓ 全量快照 [%s] → %s（%.1f MB）" % (tier, os.path.basename(dst), sz / 1048576))
    return dst


# ── 增量导出 ────────────────────────────────────────────────────────────────
def snapshot_incr(tier, since_ts):
    """导出自 since_ts 以来的新增+削减部分（JSONL）。
    新增 = entries 表新增行（source/at/head/body）
    削减 = uploads 表删除了但 entries 里没有的 source（简化：暂不追踪删除，
           因为世界树只增不删——清空重长走全量快照）"""
    os.makedirs(CKPT_DIR, exist_ok=True)
    dst = os.path.join(CKPT_DIR, "incr_%s_%s.jsonl" % (tier, _ts()))
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT source, ws, final_node_id, grew_at, head, body FROM entries"
        " WHERE grew_at >= ? ORDER BY grew_at", (since_ts,)).fetchall()
    conn.close()
    with open(dst, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps({"op": "ins", "source": r["source"], "at": r["grew_at"],
                                "head": r["head"], "body": (r["body"] or "")[:200]},
                               ensure_ascii=False) + "\n")
    n = len(rows)
    print("✓ 增量 [%s] → %s（%d 条新增）" % (tier, os.path.basename(dst), n))
    return dst


# ── 检查点触发 ──────────────────────────────────────────────────────────────
def do_snapshot(force_tier=None):
    meta = _ckpt_meta()
    now = time.time()
    for tier, interval in TIERS:
        if force_tier and tier != force_tier:
            continue
        last = meta.get(tier, 0)
        if now - last < interval and not (force_tier == tier):
            continue
        if tier in FULL_TIERS:
            snapshot_full(tier)
        else:
            # 增量：以 7d 基线时间为参照
            base_ts = meta.get("7d", "")
            base_dt = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(base_ts)) if base_ts else "2000-01-01T00:00:00"
            snapshot_incr(tier, base_dt)
        meta[tier] = now
        _save_meta(meta)
    if not force_tier:
        print("检查点周期完成")


# ── 恢复 ────────────────────────────────────────────────────────────────────
def do_restore(files):
    """从检查点文件恢复。全量 .db 直接覆盖；增量 .jsonl 逐条插入（幂等：INSERT OR IGNORE）。"""
    for fp in files:
        if not os.path.exists(fp):
            print("✗ 文件不存在：%s" % fp)
            return
    for fp in files:
        base = os.path.basename(fp)
        if base.endswith(".db"):
            print("恢复全量：%s → %s" % (base, DB))
            shutil.copy2(fp, DB)
            print("  ✓ 整库恢复完成（%.1f MB）" % (os.path.getsize(DB) / 1048576))
        elif base.endswith(".jsonl"):
            print("重放增量：%s" % base)
            conn = sqlite3.connect(DB)
            conn.execute("""CREATE TABLE IF NOT EXISTS entries (
                id INTEGER PRIMARY KEY, source TEXT NOT NULL, ws TEXT,
                final_node_id INTEGER NOT NULL, grew_at TEXT NOT NULL,
                head TEXT, body TEXT)""")
            n = 0
            for line in open(fp, encoding="utf-8"):
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                if rec.get("op") != "ins":
                    continue
                try:
                    conn.execute(
                        "INSERT OR IGNORE INTO entries(source,ws,final_node_id,grew_at,head,body)"
                        " VALUES(?,?,?,?,?,?)",
                        (rec["source"], "", 0, rec["at"], rec.get("head"), rec.get("body")))
                    n += 1
                except Exception:
                    pass
            conn.commit()
            print("  ✓ 重放 %d 条增量（实际新增以 OR IGNORE 去重为准）" % n)
            conn.close()
    print("恢复完成 ✓")


# ── 列表 ────────────────────────────────────────────────────────────────────
def do_list():
    if not os.path.isdir(CKPT_DIR):
        print("（无检查点目录）")
        return
    files = sorted(os.listdir(CKPT_DIR))
    if not files:
        print("（空）")
        return
    print("检查点清单：")
    for f in files:
        fp = os.path.join(CKPT_DIR, f)
        if os.path.isfile(fp):
            print("  %-40s %8.1f KB" % (f, os.path.getsize(fp) / 1024))


# ── 入口 ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="世界树 · 五档稀释检查点")
    sub = ap.add_subparsers(dest="cmd")
    sp = sub.add_parser("snapshot")
    sp.add_argument("--force", choices=[t[0] for t in TIERS], default=None)
    sub.add_parser("list")
    sr = sub.add_parser("restore")
    sr.add_argument("files", nargs="+")
    a = ap.parse_args()
    if a.cmd == "snapshot":
        do_snapshot(getattr(a, "force", None))
    elif a.cmd == "list":
        do_list()
    elif a.cmd == "restore":
        do_restore(a.files)
    else:
        ap.print_help()
