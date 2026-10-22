# dsh-worldtree 开发纪律（2026-10-10 会话日志损坏与启动失败事故总结）

## 事故一：package.json 的 dsh.client 声明（导致 DSH Desktop 启动失败）

2026-10-10 18:49–21:27 间多次 DSH Desktop 启动报
`renderer boot failed (plugins: dsh-session-pruner)` / `client-modules: dsh-worldtree declares dsh.client but exports no "./client" bundle`。

根因：**package.json 被改写时出现中间态**——`dsh.client` 声明已写入、但
`exports["./client"]` 尚未写入（或反之）。宿主的 client-modules 组装在启动时逐包校验，
凡声明 `dsh.client` 的包必须有 `exports["./client"]` 字符串导出；两者不一致即整个
client-modules 组合失败，所有带 web 客户端的插件连带点名。

**纪律：改本包 package.json 必须"一次写完整文件"**——先在内存里构造完整 JSON（含
dsh.client 块与 exports["./client"] 两个字段），再一次 WriteAllText 落盘
（UTF-8 无 BOM）。禁止分段编辑、禁止先写一半再补。写完后跑：

```
node -e "const p=require('./package.json');if(p.dsh.client&&!p.exports['./client']){console.error('BAD');process.exit(1)};console.log('OK')"
```

## 事故二：注入消息缺 source（导致会话日志损坏、历史打不开）

2026-10-10 seq 7255：注入的消息对象没有 `source` 字段，v4 会话格式冷读校验直接拒绝
（`format v4 message requires a producer-owned source kind`），该会话从此打不开。
已修（见 lib/impl.mjs 的 recall 构造，含事故留痕注释）。**任何写入会话的消息都必须带
四要件：id / role / content 数组 / source.kind（producer-owned，如
`plugin:dsh-worldtree`，禁止裸 `plugin` 或缺失）。**

## 事故三：P3 上行 v1 全局缓冲被多会话冲垮（2026-10-11 排障定案）

症状：上下文压缩后无审计、无日记、日志零条 P3 记录。实证：06:40 手动压缩时三个会话
消息交错，v1「全局单缓冲 + 会话切换即清空」被反复归零，compaction/end 时缓冲 ~600 字
< minChars(2000)，**静默返回**（该分支不打日志——两天的日志里一条 P3 都没有）。

教训与 v2 修法（lib/impl.mjs P3 v2 注释块）：
- **不要自己攒"被压缩内容"的缓冲**——`compaction/summary` 事件自带 `shadowedRange`
 （闭区间 surface seq），被遮蔽事件永久保留在会话日志里；用
 `session.snapshotEvents(start, end+1)` 同步取回，才是「被压缩的全部上下文」的权威来源。
- **后台链路禁止静默出口**：每个分支（跳过/失败/空结果）都必须打一行日志。
- 压缩提炼是 per-session 输入 + 全局串行队列（p3Queue/p3Busy），不再有跨会话状态。
- 离线单测：`_dev/test_p3_extract.mjs`（7 过）。

## 关联提醒

- 每轮注入走 pre-step 改写 decision 追加（当前实现正确），勿回退 agent.inject 路径。
- 检查表：~/.dsh/skills/dsh-plugin-checklist（§3.3.1 消息四要件、§3.4.00 禁用
  PowerShell 文本 cmdlet 改源码）。
