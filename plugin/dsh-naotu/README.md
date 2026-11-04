# dsh-naotu —— 脑图（记忆系统 v2）

> 独立分支，不属于流变系列。定纲（2026-10-10）：脑图就是记忆。
> 2026-11-04 由「世界树系统」改名并升级 v1 机制（元记忆 / 脑区 / 记忆指纹 / 睡眠）。

组织方式与记忆系统同构（家族、简介/正文、稳定标识），两处换发动机：
**人工挂载 → 自动生长**；**贡献者 + 修订记录 → 生长记录**。

## 组成
- 树核：`core/naotu.py`（Python + SQLite，纯标准库；v1 起内含元记忆/脑区表）
- 树库：`data/worldtree.db`（路径经设置配置，随 WT_DB 传给树核；文件名沿用旧名，无需迁移）
- 编码：内置向量化服务——llama-server · Qwen3-Embedding-0.6B Q4_K_M @ 8082，插件自动探活 / 接管 / 拉起 / 看门狗（llama-server 可执行与 GGUF 模型路径在配置中指定）

## v1 机制（2026-11-04）
- **元记忆**：事件入库时按句切分为 `mm`（句级检索单位），带上下文向量与 kNN 边。
- **脑区**：全库 kNN 吸引盆聚类（`mm_region` / `entry_region`），事件归属多数盆。
- **记忆指纹**：会话内元记忆的脑区贡献 softmax（温度 3、阈值 0.05），供 race 的 R 通道使用（`sid` 传入即生效）。
- **睡眠**：入库即组织——句拆 → 嵌入 → 定盆 → 近邻（cos≥0.90）挂链，不产生"孤立"才合并。
- race 总分 = S（语义）+ K（标签/词面）+ B（血缘）+ R（脑区指纹），权重可配（默认 1.0 / 0.7 / 0.3 / 0.3）。
  句级精修 S_mm 默认关闭（实测头部落精度，opt-in）。

## 工具面
- `_dsh_external_dsh_naotu`：status / search / locate / insert / node / stats / uploads
- `_dsh_external_dsh_liubian_embed`（沿用家族旧名）：status / ensure / stop / restart —— 8082 向量服务管理

## 上行（自动记忆）
新记忆不再送审：P3 蒸馏管线（会话压缩块 → 分片 LLM 提炼 → 入树）与便签出稿 → 编码 → 上树，全链自动。

## 手写 wiki 路径（CLI）
手写策展通道保留但不在智能体工具面暴露——只走本 CLI：

```
python helper/wiki_cli.py tree
python helper/wiki_cli.py get   --slug 流变系统
python helper/wiki_cli.py find  --query 脑图 --mode hybrid
python helper/wiki_cli.py create --slug X --title T --intro I --family F --content-file C.txt
python helper/wiki_cli.py update --slug X --summary S --content-file C.txt
python helper/wiki_cli.py move   --slug X --to 新家族
python helper/wiki_cli.py rollback --slug X --slot 2
```

写操作落 wiki 库 liubian.db（LU_DB 指定，单写者纪律见协议 §6；该库不含于本仓库，需自备或自 v1 迁移）。
自动上传（编码上树）走工具面 insert / 便签上行，与手写通道相互独立。

## 注入格式说明
注入块仍用 `<worldtree …>…</worldtree>` 外层标签（历史会话日志回放依赖此标记，勿改）。
