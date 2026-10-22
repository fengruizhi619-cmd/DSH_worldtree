# dsh-worldtree —— 世界树系统（记忆系统 v2）

> 独立分支，不属于流变系列。定纲（2026-10-10）：世界树系统就是记忆。

组织方式与记忆系统同构（树形家族、简介/正文、稳定标识），两处换发动机：
**人工挂载 → 自动生长**；**贡献者 + 修订记录 → 生长记录**。

## 组成
- 树核：`core/worldtree.py`（Python + SQLite，纯标准库，层进生长）
- 树库：`data/worldtree.db`（路径经设置配置，随 WT_DB 传给树核）
- 编码：内置向量化服务——llama-server · Qwen3-Embedding-0.6B Q4_K_M @ 8082，插件自动探活 / 接管 / 拉起 / 看门狗（llama-server 可执行与 GGUF 模型路径在配置中指定）

## 工具面
- `_dsh_external_worldtree`：status / search / locate / insert / node / stats / uploads
- `_dsh_external_dsh_liubian_embed`（沿用家族旧名）：status / ensure / stop / restart —— 8082 向量服务管理

## 上行（自动记忆）
新记忆不再送审：P3 蒸馏管线（会话压缩块 → 分片 LLM 提炼 → 入树）与便签出稿 → 编码 → 上树，全链自动。

## 手写 wiki 路径（CLI）
手写策展通道保留但不在智能体工具面暴露——只走本 CLI：

```
python helper/wiki_cli.py tree
python helper/wiki_cli.py get   --slug 流变系统
python helper/wiki_cli.py find  --query 世界树 --mode hybrid
python helper/wiki_cli.py create --slug X --title T --intro I --family F --content-file C.txt
python helper/wiki_cli.py update --slug X --summary S --content-file C.txt
python helper/wiki_cli.py move   --slug X --to 新家族
python helper/wiki_cli.py rollback --slug X --slot 2
```

写操作落 wiki 库 liubian.db（LU_DB 指定，单写者纪律见协议 §6；该库不含于本仓库，需自备或自 v1 迁移）。
自动上传（编码上树）走工具面 insert / 便签上行，与手写通道相互独立。
