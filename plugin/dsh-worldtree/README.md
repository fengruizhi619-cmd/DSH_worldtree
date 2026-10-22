# dsh-worldtree —— 世界树系统（记忆系统 v2）

> 独立分支，不属于流变系列。定纲（管理员 2026-10-10）：世界树系统就是记忆。

组织方式与记忆系统同构（树形家族、简介/正文、稳定标识），两处换发动机：
**人工挂载 → 自动生长**；**贡献者 + 修订记录 → 生长记录**。

## 组成
- 树核：`E:\DSH_data\世界树\core\worldtree.py`（Python + SQLite，层进生长）
- 树库：`E:\DSH_data\世界树\data\worldtree.db`
- 编码：内置 dsh-liubian-memory 的向量化服务（Qwen3-Emb Q4_K_M @ 8082）

## 工具
`_dsh_external_worldtree`：status / search / locate / insert / node / stats

## 上行
新记忆不再送审（原银杏路径已关）：便签出稿 → 编码 → 上树。
## 手写 wiki 路径（CLI，管理员 2026-10-10 裁定）

手写策展通道**保留但不在智能体工具面暴露**——只走本 CLI：

```
python helper/wiki_cli.py tree
python helper/wiki_cli.py get   --slug 流变系统
python helper/wiki_cli.py find  --query 世界树 --mode hybrid
python helper/wiki_cli.py create --slug X --title T --intro I --family F --content-file C.txt
python helper/wiki_cli.py update --slug X --summary S --content-file C.txt
python helper/wiki_cli.py move   --slug X --to 新家族
python helper/wiki_cli.py rollback --slug X --slot 2
```

写操作落 liubian.db（LU_DB 指向，单写者纪律见协议 §6）。
自动上传（编码上树）走工具面 insert / 便签上行，与手写通道相互独立。