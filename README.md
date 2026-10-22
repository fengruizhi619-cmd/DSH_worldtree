# dsh-worldtree —— 世界树：DSH 记忆系统 v2

> 独立分支，不属于流变系列。接替 [DSH_liubian_memory](https://github.com/fengruizhi619-cmd/DSH_liubian_memory)（v1，已转档案仓）。

DeepSeek Harness（DSH）的长期记忆系统第二代插件。与 v1 同构（树形家族、简介/正文、稳定标识），两处换发动机：**人工挂载 → 向量主题树自动生长**；**贡献者+修订记录 → 生长记录**。

## 组成

- `plugin/dsh-worldtree/` —— DSH 插件本体
  - `lib/impl.mjs` 主体：P3 蒸馏管线 / 注入池两级赛马 / bili 双轨捕获 / HTTP 服务
  - `lib/client.js` 管理面板（检索 / 上传 / 记录 / 设置）
  - `helper/wiki_store.py` wiki 条目存取
- `core/` —— 树核（Python + SQLite，纯标准库）
  - `worldtree.py` 层进生长 / 检索 / ops CLI
  - `checkpoint.py` 五档稀释检查点
  - `mem_attribution.py` 记忆归因

## 安装

插件按 `../../core/` 相对路径引用树核，需保持本仓库目录布局：clone 后把 `plugin/dsh-worldtree/` 装配进 DSH 插件目录体系，`core/` 留在同级相对位置。数据落 `<仓库>/data/worldtree.db`（首次运行自动建表）。

## 依赖

- 本地向量服务（Qwen3-Embedding，端口 8082）：插件自动探活接管；不可用时关键词/基因通道优雅降级
- DSH Desktop 运行环境（cordis 4 / dsh-tools）

## 主要机制

- **P3 管线**：监听会话压缩事件 → 区间直读 → 分片 LLM 提炼 → 入树（exists 去重 / 失败落盘续传 / 看门狗防挂起）
- **注入池两级赛马**：预热池（每轮检索入池打批次、加热）→ 结算晋预备池 → 周期末保留前 50% 整头补回 + 命中补漏；防重复注入三层闸（生命周期 / 上下文短锚 / 晋升去重）
- **三通道赛马**：语义余弦 S + 关键词 K + 会话基因 B，归一化加权求和
- **bili 双轨**：自托管 billion-context 压缩块作为第二捕获源，基因指纹防双轨重复蒸馏
