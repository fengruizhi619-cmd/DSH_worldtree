# -*- coding: utf-8 -*-
"""世界树 · 手写 wiki CLI（管理员 2026-10-10 裁定：手写路径保留，但不在智能体工具面暴露）

用法（LU_DB 自动指向记忆库；本 CLI 是手写策展的唯一通道，工具面不提供）：
  python wiki_cli.py tree
  python wiki_cli.py get   --slug 流变系统
  python wiki_cli.py find  --query 世界树 --mode hybrid --top 5
  python wiki_cli.py create --slug X --title T --intro I --family F --content-file C.txt
  python wiki_cli.py update --slug X [--title T] [--intro I] [--summary S] [--content-file C.txt]
  python wiki_cli.py move   --slug X --to 新家族路径
  python wiki_cli.py rollback --slug X --slot 2
  python wiki_cli.py list [--family F] | diary_tree | diary_list --workspace W | diary_get --id D0029

写入落 liubian.db（ wiki_pages/revisions/checkpoints），单写者纪律见协议 §6。
"""
import argparse
import json
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.join(HERE, "wiki_store.py")
LU_DB = os.environ.get("LU_DB", r"E:\DSH_data\.memory_registry\liubian.db")


def call_store(req):
    env = dict(os.environ)
    env["LU_DB"] = LU_DB
    r = subprocess.run([sys.executable, STORE], input=json.dumps(req).encode("utf-8"),
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, env=env)
    try:
        return json.loads(r.stdout.decode("utf-8"))
    except Exception:
        return {"ok": False, "error": "非 JSON 输出：" + r.stdout.decode("utf-8", "replace")[:200]
                + " ｜ stderr：" + r.stderr.decode("utf-8", "replace")[:200]}


def main():
    ap = argparse.ArgumentParser(description="世界树 · 手写 wiki CLI（策展通道，工具面不暴露）")
    sub = ap.add_subparsers(dest="op", required=True)
    for name in ("tree", "diary_tree"):
        sub.add_parser(name)
    p = sub.add_parser("get"); p.add_argument("--slug", required=True)
    p = sub.add_parser("find"); p.add_argument("--query", required=True)
    p.add_argument("--mode", default="hybrid", choices=["keyword", "semantic", "hybrid"])
    p.add_argument("--top", type=int, default=20)
    p.add_argument("--family-prefix", dest="familyPrefix", default="")
    p = sub.add_parser("list"); p.add_argument("--family", default="")
    p = sub.add_parser("diary_list"); p.add_argument("--workspace", default="")
    p.add_argument("--q", default=""); p.add_argument("--limit", type=int, default=30)
    p = sub.add_parser("diary_get"); p.add_argument("--id", required=True); p.add_argument("--workspace", default="")
    p = sub.add_parser("create")
    p.add_argument("--slug", required=True); p.add_argument("--title", required=True)
    p.add_argument("--intro", default=""); p.add_argument("--family", required=True, dest="familyPath")
    p.add_argument("--content-file", required=True, help="正文文件（长文本不走命令行，检查表 §3.4.2）")
    p.add_argument("--status", default="draft")
    p = sub.add_parser("update")
    p.add_argument("--slug", required=True)
    p.add_argument("--title", default=""); p.add_argument("--intro", default="")
    p.add_argument("--summary", default=""); p.add_argument("--content-file", default="")
    p.add_argument("--status", default="")
    p = sub.add_parser("move"); p.add_argument("--slug", required=True)
    p.add_argument("--to", required=True, dest="newFamilyPath")
    p = sub.add_parser("rollback"); p.add_argument("--slug", required=True); p.add_argument("--slot", type=int, required=True)
    a = ap.parse_args()

    req = {"op": a.op}
    content = ""
    if getattr(a, "content_file", ""):
        content = open(a.content_file, encoding="utf-8").read()
    for k, v in vars(a).items():
        if k in ("op", "content_file") or v in ("", None):
            continue
        req[k] = v
    if content:
        req["content"] = content
    out = call_store(req)
    print(json.dumps(out, ensure_ascii=False, indent=1, default=str))
    return 0 if out.get("ok", True) else 1


if __name__ == "__main__":
    sys.exit(main())
