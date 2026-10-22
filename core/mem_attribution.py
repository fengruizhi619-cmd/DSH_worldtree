# -*- coding: utf-8 -*-
"""llama-server 内存增长归因实验
基线 → A: 20×64条等大批量 → B: 200×1条小请求 → C: 1×512条特大请求
每阶段后读 llama-server 私有提交，看增长归因到哪个模式。"""
import json, subprocess, sys, time, urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
URL = "http://127.0.0.1:8082/v1/embeddings"
PID = int(sys.argv[1]) if len(sys.argv) > 1 else 19828

def commit_mb():
    out = subprocess.run(
        ["C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "-NoProfile", "-Command",
         f"(Get-Process -Id {PID}).PrivateMemorySize64"],
        capture_output=True, text=True).stdout.strip()
    return int(out) / 1048576

def embed(texts):
    payload = json.dumps({"model": "x", "input": texts}).encode("utf-8")
    rq = urllib.request.Request(URL, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(rq, timeout=180) as resp:
        json.loads(resp.read())

def phase(name, fn):
    before = commit_mb()
    t0 = time.time()
    fn()
    time.sleep(2)
    after = commit_mb()
    print("%-28s 提交 %7.0f → %7.0f MB ｜ Δ %+7.0f MB ｜ 耗时 %4.0fs"
          % (name, before, after, after - before, time.time() - t0))

base_text = "这是一条用于内存归因实验的标准句子，包含足够的字符长度以贴近真实日记采样。"
texts64 = [base_text + str(i) for i in range(64)]

print("基线提交：%.0f MB（进程 PID %d）\n" % (commit_mb(), PID))

phase("A：20 × 64条等大批量", lambda: [embed(texts64) for _ in range(20)])
phase("A'：再 20 × 64条同批量", lambda: [embed(texts64) for _ in range(20)])
phase("B：200 × 1条小请求", lambda: [embed([base_text + str(i)]) for i in range(200)])
phase("C：1 × 512条特大请求", lambda: embed([base_text + str(i) for i in range(512)]))
phase("D：静置 10s 后复测", lambda: time.sleep(10))
print("\n判读：哪一段 Δ 显著为正，哪一种模式就是增长源；D 段回落 = 临时缓冲，不回落 = 滞留。")
