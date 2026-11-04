# -*- coding: utf-8 -*-
"""兼容 shim：旧路径 core/worldtree.py → core/naotu.py

2026-11-04 项目改名「世界树 → 脑图」（插件 dsh-worldtree → dsh-naotu）。
树核实体已迁至 core/naotu.py；保留本文件仅为兼容尚未迁移的调用方
（历史脚本、旧测试、外部工具）。op 协议与行为一律以 naotu.py 为准。
"""
import os
import runpy

_target = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'naotu.py')
runpy.run_path(_target, run_name='__main__')
