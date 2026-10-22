/**
 * dsh-worldtree —— 实现（世界树系统 · 记忆系统 v2）
 *
 * 职责（2026-10-10 定纲）：世界树系统就是记忆。组织方式与记忆系统同构，
 * 两处换发动机：人工挂载 → 自动生长；贡献者 + 修订记录 → 生长记录。
 *
 * 本插件是树的服务面：
 *   · 树核 = Python（E:\DSH_data\世界树\core\worldtree.py，SQLite 存储）
 *   · 编码 = 内置 dsh-liubian-memory 的向量化服务（Q4_K_M @ 8082）
 *   · 本插件经 stdin 字节流 JSON 协议调用树核（检查表 §3.4.0：stdin 按字节读、
 *     execFile 显式关 stdin；>20KB 走 --file 临时文件通道）
 */
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

export const PLUGIN_VERSION = '0.8.2'
export const TOOL_NAME = '_dsh_external_worldtree'

const HOME = process.env.USERPROFILE || process.env.HOME || 'C:/Users/Feng'
export const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh')

const DEFAULTS = {
  /** 树核 Python */
  pyExe: 'E:/python/python.exe',
  corePy: 'E:/DSH_data/世界树/core/worldtree.py',
  /** 树库 */
  dbPath: 'E:/DSH_data/世界树/data/worldtree.db',
  /** 编码服务（内置 dsh-liubian-memory 提供） */
  embedUrl: 'http://127.0.0.1:8082',
  /** wiki_store 副本（流变wiki UI 后端，ro 直连 liubian.db） */
  helperPy: 'E:/DSH_data/世界树/plugin/dsh-worldtree/helper/wiki_store.py',
  helperCwd: 'E:/DSH_data/世界树/plugin/dsh-worldtree/helper',
  /** 记忆库（helper ro 直连） */
  luDb: 'E:/DSH_data/.memory_registry/liubian.db',
  /** 每轮记忆注入（v1：树定位取材） */
  injectEnabled: true,
  injectTop: 3,
  injectMinChars: 8,
  injectTimeoutMs: 8000,
  /** 注入正文上限/条（防极端长文；8000≈insert 上限=事实上的全文） */
  injectBodyMax: 8000,
  /** P3 上行：压缩触发式提炼（管理员定纲：上下文被压缩 → 全部送提炼 → 不限篇数 → 编码上树） */
  p3Enabled: true,
  p3MinChars: 2000,
  p3ChunkChars: 40000,        // 分片提炼：单片上下文上限（防输出截断丢批）
  p3TotalChars: 330000,       // 单次压缩提炼的总字数上限。2026-10-12 按历史 4 次压缩的
                              // 未截断需求均值定（59.9万/31.6万/36.1万/2.8万 → 33 万）；
                              // 截断保新弃旧；可被设置界面/配置文件覆盖
  /** 记忆注入池（2026-10-12 老机制移植：两级赛马，参数=老系统实测最优点） */
  injectPool: true,
  injectPrefetchTop: 10,      // 每轮融合检索 top-N 入预热池
  injectCycleRounds: 3,       // 预热池批次寿命（轮）：满龄结算，热度前 settleTop 晋预备池
  injectSettleTop: 3,         // 每批结算晋级数
  injectKeepFrac: 0.5,        // 周期末预备池保留比例（按周期平均余弦的相对名次）
  injectMissTop: 3,           // 时机②每轮最多补漏条数
  injectRefillTop: 6,         // 周期末补回条数上限（2026-10-12：27 条全文污染后定预算制）
  injectRefillChars: 10000,   // 周期末补回字数预算
  /** 检查点调度器（2026-10-11）：五档稀释检查点周期触发 */
  ckptEnabled: true,
  ckptPy: 'E:/DSH_data/世界树/core/checkpoint.py',
  ckptIntervalMs: 600000,     // 10 分钟一查（checkpoint.py 自判 1m/7d/24h/6h/1h 档位）
  /** P3·bili 通道（2026-10-19 双轨定案）：bili（billion-context 代理层）在上下文视图
   * 压缩会话（不动物理日志），blocks 表记账压缩块 ref 区间。新 active 块 = 一段内容
   * 刚被压出视图 → 与 DSH 压缩通道（compaction/summary）同等地位送提炼上树。
   * bili 压得更频繁粒度更细 = 主通道；DSH 通道保留兜底。 */
  p3BiliEnabled: true,
  p3BiliDb: 'C:/Users/Feng/.local/share/billion-context/sessions/index.db',
  p3BiliSummaryDirect: true,  // 块摘要直采（选项 A）：压缩块自带高质量摘要 ≥100 字零 LLM 直接上树
  /** 提炼 API（设置界面写；留空用家族配置/缺省） */
  llmUrl: '',
  llmKey: '',
  llmModel: '',
  /** 单次 helper 调用超时 */
  helperTimeoutMs: 60000,
  /** 长文本走临时文件的阈值（检查表 §3.4.2：命令行 32KB 上限） */
  fileChannelBytes: 20000,
}

/* ── 配置（检查表 §3.2.3：不指望宿主注入默认值；读文件剥 BOM §3.4.1）── */
export function configFile() {
  return join(DSH_HOME, 'worldtree', 'config.json')
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {}
  } catch {
    return {}
  }
}

export function resolveConfig(input = {}) {
  const merged = { ...DEFAULTS, ...readJson(configFile()) }
  const src = input && typeof input === 'object' ? input : {}
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || v === null || v === '') continue
    merged[k] = v
  }
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = merged[k]
    if (typeof def === 'boolean' && typeof v === 'string') merged[k] = v.trim().toLowerCase() !== 'false'
    if (typeof def === 'number' && typeof v === 'string' && v.trim() !== '') {
      const n = Number(v)
      if (Number.isFinite(n)) merged[k] = n
    }
  }
  return merged
}

/* ── 树核调用（Python helper，stdin 字节流）── */

function callCore(cfg, req) {
  return new Promise((resolve) => {
    const body = JSON.stringify(req)
    const useFile = body.length > (cfg.fileChannelBytes || 20000)
    let tmp = null
    const args = [cfg.corePy]
    if (useFile) {
      tmp = join(mkdtempSync(join(tmpdir(), 'wt-')), 'req.json')
      writeFileSync(tmp, body, 'utf8')
      args.push('--req-file', tmp)
    }
    const child = execFile(cfg.pyExe, args, {
      env: { ...process.env, WT_DB: cfg.dbPath },   // ⚠ CLI 靠 WT_DB 定库——不传则无视 cfg.dbPath（实测踩过）
      cwd: existsSync(cfg.corePy) ? join(cfg.corePy, '..') : undefined,
      timeout: cfg.helperTimeoutMs || 60000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout) => {
      if (tmp) { try { rmSync(tmp, { force: true }) } catch { /* 尽力清理 */ } }
      if (err && !stdout) {
        resolve({ ok: false, error: (err && err.message) || String(err) })
        return
      }
      try {
        resolve({ ok: true, data: JSON.parse(String(stdout || '{}')) })
      } catch (e) {
        resolve({ ok: false, error: '树核输出解析失败：' + String(e).slice(0, 120) + '｜stdout 头 200：' + String(stdout || '').slice(0, 200) })
      }
    })
    // 检查表 §3.4.0 症状 B：不关 stdin，helper 的 buffer.read() 永远不返回
    if (child.stdin) {
      if (!useFile) child.stdin.end(body, 'utf8')
      else child.stdin.end()
    }
  })
}

/** 编码：调内置向量服务（dsh-liubian-memory 提供，Q4_K_M @ 8082）。 */
async function embed(cfg, texts) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 60000)
  try {
    const res = await fetch(new URL('/v1/embeddings', cfg.embedUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-emb', input: texts }),
      signal: ctl.signal,
    })
    if (!res.ok) return { ok: false, error: 'embed HTTP ' + res.status }
    const data = await res.json()
    return { ok: true, vectors: data.data.map((d) => d.embedding) }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/* ── 流变wiki UI（收编自 dsh-liubian-memory，2026-10-10）──────────────────
 * client.js 原样搬入（UI 零改动）；路由 /api/liubian-wiki 同名同 7 op，
 * 后端 = 本地 helper 副本 wiki_store.py（ro 直连 liubian.db，§14 已申报形态）。
 * 旧记忆插件关停后，本插件是 UI 与数据的唯一属主——响应形状与旧服务逐字一致。
 */
export const PANEL_ID = 'liubianwiki'
export const ROUTE_PATH = '/api/liubian-wiki'
export const CONTRACT_VERSION = '1.0'
const WIKI_OPS = ['health', 'tree', 'get', 'find', 'diary_tree', 'diary_list', 'diary_get', 'uploads', 'wt_tree', 'tag_table', 'tag_filter', 'entry_tags', 'entry_get', 'insert', 'p3_status', 'settings_get', 'settings_save']

function wikiSendJson(res, status, obj) {
  try {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(obj))
  } catch { /* 连接已断 */ }
}

function wikiReadBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) raw = raw.slice(0, 1e6) })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

function wikiCallHelper(cfg, op, req = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ op, ...req })
    const child = execFile(cfg.pyExe, [cfg.helperPy], {
      env: { ...process.env, LU_DB: cfg.luDb },
      cwd: cfg.helperCwd || undefined,
      timeout: cfg.helperTimeoutMs || 60000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout) => {
      if (err && !stdout) {
        resolve({ ok: false, error: 'wiki_store 执行失败：' + ((err && err.message) || String(err)).slice(0, 200) })
        return
      }
      try {
        resolve(JSON.parse(String(stdout || '{}')))
      } catch (e) {
        resolve({ ok: false, error: 'wiki_store 输出非 JSON：' + String(e).slice(0, 100) })
      }
    })
    // 检查表 §3.4.0 症状 B：显式关 stdin，否则 helper 的 buffer.read() 永不返回
    if (child.stdin) child.stdin.end(body, 'utf8')
  })
}

function wikiMountPanelRoutes(ctx, cfg) {
  ctx.effect(() => {
    let disposed = false
    let timer = null
    let off = null
    let attempts = 0
    let prevOff = null
    const log = ctx.logger
    const tryMount = () => {
      if (disposed) return
      attempts += 1
      const webServer = (ctx.reflect && typeof ctx.reflect.get === 'function')
        ? ctx.reflect.get('webServer', false)
        : ctx.webServer
      if (!webServer || typeof webServer.register !== 'function') {
        if (attempts < 8) timer = setTimeout(tryMount, 2000)
        else log?.warn?.(`[dsh-worldtree] webServer 重试 ${attempts} 次仍不可得，${ROUTE_PATH} 放弃挂载（重启/重载后恢复）`)
        return
      }
      if (typeof prevOff === 'function') {
        try { prevOff() } catch { /* 上一代可能已自行释放 */ }
        prevOff = null
      }
      try {
        off = webServer.register({
          kind: 'exact',
          path: ROUTE_PATH,
          async handler(req, res) {
            try {
              const url = new URL(req.url, 'http://local')
              let params = Object.fromEntries(url.searchParams.entries())
              let op = String(params.op || 'health').trim()
              if (req.method === 'POST') {
                const body = await wikiReadBody(req)
                params = { ...params, ...(body || {}) }
                op = String(params.op || op).trim()
              }
              if (!WIKI_OPS.includes(op)) {
                wikiSendJson(res, 400, { ok: false, error: `未知 op：${op}（可选 ${WIKI_OPS.join(' / ')}）` })
                return
              }
              if (op === 'health') {
                wikiSendJson(res, 200, {
                  ok: true, plugin: 'dsh-worldtree', version: PLUGIN_VERSION, contract: CONTRACT_VERSION,
                  service: { name: 'worldtree-wiki-store', state: 'ok', version: PLUGIN_VERSION, hasFind: true, error: null },
                })
                return
              }
              if (op === 'get') {
                const slug = String(params.slug || '').trim()
                if (!slug) { wikiSendJson(res, 400, { ok: false, error: 'op=get 需要 slug' }); return }
                // 世界树内部节点：纯导航列表（成员可点击；不再生成合成内容页——管理员 2026-10-10）
                if (slug.startsWith('wt-')) {
                  const nid = Number(slug.split('-').pop())
                  const r = await callCore(cfg, { op: 'node', node_id: nid })
                  if (!r.ok) { wikiSendJson(res, 404, { ok: false, error: r.error }); return }
                  const d = r.data
                  const children = (d.neighbors || [])
                    .filter((x) => x.source.indexOf('wiki:') === 0)
                    .map((x) => ({ slug: x.source.slice(5), familyPath: slug,
                                   title: (x.snippet || x.source).slice(0, 56) }))
                  wikiSendJson(res, 200, { ok: true, page: {
                    slug: slug, familyPath: slug, fullPath: slug,
                    title: 'L' + (d.level || '?') + ' 节点 ' + (d.id || '') + '（' + (d.entry_count || 0) + ' 条）',
                    intro: '结构节点：点击成员查看全文', content: '',
                    status: 'stable', revisions: 0, createdAt: '', updatedAt: '',
                    children: children, checkpoints: [], recentRevisions: [], diaryRefs: [],
                  } })
                  return
                }
                wikiSendJson(res, 200, await wikiCallHelper(cfg, 'get', { slug }))
                return
              }
              if (op === 'diary_tree') {
                wikiSendJson(res, 200, await wikiCallHelper(cfg, 'diary_tree', {}))
                return
              }
              if (op === 'diary_list') {
                const dreq = {}
                if (params.workspace) dreq.workspace = String(params.workspace)
                if (params.q) dreq.q = String(params.q)
                if (params.tag) dreq.tag = String(params.tag)
                if (params.limit) dreq.limit = Math.min(200, Math.max(1, Number(params.limit) || 30))
                if (params.offset) dreq.offset = Math.max(0, Number(params.offset) || 0)
                wikiSendJson(res, 200, await wikiCallHelper(cfg, 'diary_list', dreq))
                return
              }
              if (op === 'diary_get') {
                const id = String(params.id || '').trim()
                if (!id) { wikiSendJson(res, 400, { ok: false, error: 'op=diary_get 需要 id（如 D0029）' }); return }
                const dreq = { id }
                if (params.workspace) dreq.workspace = String(params.workspace)
                const out = await wikiCallHelper(cfg, 'diary_get', dreq)
                wikiSendJson(res, out.ok ? 200 : (out.needWorkspace ? 409 : 404), out)
                return
              }
              // ── 世界树与关键词（数据在 worldtree.db，走树核）──
              if (op === 'settings_get') {
                let file = {}
                try { file = JSON.parse(readFileSync(configFile(), 'utf8').replace(/^\uFEFF/, '')) || {} } catch { }
                let url = '', model = '', keyTail = ''
                try {
                  const lb = JSON.parse(readFileSync(join(DSH_HOME, 'liubian', 'config.json'), 'utf8').replace(/^\uFEFF/, '')) || {}
                  if (lb.llmApiUrl) url = lb.llmApiUrl
                  if (lb.llmModel) model = lb.llmModel
                  if (lb.llmApiKey) keyTail = String(lb.llmApiKey).slice(-4)
                } catch { }
                if (file.llmUrl) url = file.llmUrl
                if (file.llmModel) model = file.llmModel
                if (file.llmKey) keyTail = String(file.llmKey).slice(-4)
                wikiSendJson(res, 200, { ok: true, settings: {
                  llmUrl: url || 'https://api.deepseek.com/chat/completions',
                  llmModel: model || 'deepseek-flash',
                  llmKeyTail: keyTail,
                  p3MinChars: file.p3MinChars != null ? file.p3MinChars : DEFAULTS.p3MinChars,
                  p3ChunkChars: file.p3ChunkChars != null ? file.p3ChunkChars : DEFAULTS.p3ChunkChars,
                  p3MaxTokens: file.p3MaxTokens != null ? file.p3MaxTokens : DEFAULTS.p3MaxTokens,
                  p3TotalChars: file.p3TotalChars != null ? file.p3TotalChars : DEFAULTS.p3TotalChars,
                  injectTop: file.injectTop != null ? file.injectTop : DEFAULTS.injectTop,
                  injectBodyMax: file.injectBodyMax != null ? file.injectBodyMax : DEFAULTS.injectBodyMax,
                  ckptEnabled: file.ckptEnabled != null ? file.ckptEnabled : DEFAULTS.ckptEnabled,
                  ckptIntervalMs: file.ckptIntervalMs != null ? file.ckptIntervalMs : DEFAULTS.ckptIntervalMs,
                  injectPool: file.injectPool != null ? file.injectPool : DEFAULTS.injectPool,
                  injectPrefetchTop: file.injectPrefetchTop != null ? file.injectPrefetchTop : DEFAULTS.injectPrefetchTop,
                  injectCycleRounds: file.injectCycleRounds != null ? file.injectCycleRounds : DEFAULTS.injectCycleRounds,
                  injectSettleTop: file.injectSettleTop != null ? file.injectSettleTop : DEFAULTS.injectSettleTop,
                  injectKeepFrac: file.injectKeepFrac != null ? file.injectKeepFrac : DEFAULTS.injectKeepFrac,
                  injectMissTop: file.injectMissTop != null ? file.injectMissTop : DEFAULTS.injectMissTop,
                  p3BiliEnabled: file.p3BiliEnabled != null ? file.p3BiliEnabled : DEFAULTS.p3BiliEnabled,
                  p3BiliSummaryDirect: file.p3BiliSummaryDirect != null ? file.p3BiliSummaryDirect : DEFAULTS.p3BiliSummaryDirect,
                  p3BiliDb: file.p3BiliDb || DEFAULTS.p3BiliDb,
                } })
                return
              }
              if (op === 'settings_save') {
                const patch = {}
                for (const k of ['llmUrl', 'llmModel', 'llmKey']) {
                  const v = String(params[k] || '').trim()
                  if (v) patch[k] = v                     // 空=不改（key 留空保持现状）
                }
                for (const k of ['p3MinChars', 'p3ChunkChars', 'p3MaxTokens', 'p3TotalChars', 'injectTop', 'injectBodyMax', 'ckptIntervalMs', 'injectPrefetchTop', 'injectCycleRounds', 'injectSettleTop', 'injectMissTop']) {
                  if (params[k] !== undefined && params[k] !== '') {
                    const n = Number(params[k])
                    if (Number.isFinite(n) && n > 0) patch[k] = n
                  }
                }
                if (params.ckptEnabled !== undefined && params.ckptEnabled !== '') {
                  patch.ckptEnabled = (params.ckptEnabled === true || params.ckptEnabled === 'true')
                }
                if (params.injectPool !== undefined && params.injectPool !== '') {
                  patch.injectPool = (params.injectPool === true || params.injectPool === 'true')
                }
                if (params.injectKeepFrac !== undefined && params.injectKeepFrac !== '') {
                  const f = Number(params.injectKeepFrac)
                  if (Number.isFinite(f) && f > 0 && f <= 1) patch.injectKeepFrac = f
                }
                if (params.p3BiliEnabled !== undefined && params.p3BiliEnabled !== '') {
                  patch.p3BiliEnabled = (params.p3BiliEnabled === true || params.p3BiliEnabled === 'true')
                }
                if (params.p3BiliSummaryDirect !== undefined && params.p3BiliSummaryDirect !== '') {
                  patch.p3BiliSummaryDirect = (params.p3BiliSummaryDirect === true || params.p3BiliSummaryDirect === 'true')
                }
                if (String(params.p3BiliDb || '').trim()) patch.p3BiliDb = String(params.p3BiliDb).trim()
                let cur = {}
                try { cur = JSON.parse(readFileSync(configFile(), 'utf8').replace(/^\uFEFF/, '')) || {} } catch { }
                const next = { ...cur, ...patch }
                mkdirSync(dirname(configFile()), { recursive: true })
                writeFileSync(configFile(), JSON.stringify(next, null, 2) + '\n', 'utf8')
                ctx.logger?.info?.('[dsh-worldtree] 设置已保存：' + Object.keys(patch).join(','))
                wikiSendJson(res, 200, { ok: true, saved: Object.keys(patch) })
                return
              }
              if (op === 'insert') {
                const text = String(params.text || '').trim()
                if (!text) { wikiSendJson(res, 400, { ok: false, error: 'op=insert 需要 text' }); return }
                const r = await callCore(cfg, { op: 'insert',
                  source: String(params.source || '').trim() || ('upload/' + new Date().toISOString().slice(0, 19)),
                  ws: String(params.ws || 'upload'), text })
                wikiSendJson(res, r.ok ? 200 : 503, r.ok ? r.data : { ok: false, error: r.error })
                return
              }
              if (op === 'wt_tree' || op === 'tag_table' || op === 'tag_filter' || op === 'entry_tags' || op === 'entry_get') {
                const req3 = {}
                if (params.tags) req3.tags = String(params.tags)
                if (params.source) req3.source = String(params.source)
                if (params.limit) req3.limit = Number(params.limit)
                const r = await callCore(cfg, { op, ...req3 })
                wikiSendJson(res, r.ok ? 200 : 503, r.ok ? r.data : { ok: false, error: r.error })
                return
              }
              if (op === 'tree') {
                wikiSendJson(res, 200, await wikiCallHelper(cfg, 'tree', {}))
                return
              }
              if (op === 'p3_status') {
                // P3 管线实时状态（记录视图进度条数据源）：作业阶段/片与条目进度 + 最近压缩检测
                wikiSendJson(res, 200, {
                  ok: true, busy: p3Busy,
                  jobs: p3Jobs.map((j) => ({
                    sid: j.sid, phase: j.phase || (j.distilled ? 'insert' : 'distill'),
                    batch: j.batch || 0, queuedAt: j.queuedAt,
                    range: j.range || '', segs: j.segs || 0, chars: j.chars || 0,
                    slicesDone: j.slicesDone || 0, slicesTotal: j.slicesTotal || 0,
                    insertDone: j.insertDone || 0,
                    insertTotal: j.insertTotal || (j.distilled ? j.distilled.length : 0),
                  })),
                  recent: p3Recent,
                })
                return
              }
              if (op === 'uploads') {
                // 上行台账在世界树库（worldtree.db），走树核而非 wiki_store
                const r = await callCore(cfg, { op: 'uploads', limit: Math.min(1000, Math.max(1, Number(params.limit) || 500)) })
                wikiSendJson(res, r.ok ? 200 : 503, r.ok ? r.data : { ok: false, error: r.error })
                return
              }
              if (op !== 'find') { wikiSendJson(res, 400, { ok: false, error: `op=${op} 未实现` }); return }
              const query = String(params.query || '').trim()
              if (!query) { wikiSendJson(res, 400, { ok: false, error: 'op=find 需要 query' }); return }
              const mode = String(params.mode || 'hybrid').trim()
              if (!['keyword', 'semantic', 'hybrid'].includes(mode)) {
                wikiSendJson(res, 400, { ok: false, error: `mode 只支持 keyword / semantic / hybrid，收到：${mode}` })
                return
              }
              const req2 = { query, mode, top: Math.min(200, Math.max(1, Number(params.top) || 30)) }
              if (params.status) req2.status = String(params.status)
              if (params.familyPrefix) req2.familyPrefix = String(params.familyPrefix)
              wikiSendJson(res, 200, await wikiCallHelper(cfg, 'find', req2))
            } catch (err) {
              wikiSendJson(res, 500, { ok: false, error: (err && err.message) || String(err) })
            }
          },
        })
      } catch (err) {
        const msg = (err && err.message) || String(err)
        if (attempts < 8) {
          log?.warn?.(`[dsh-worldtree] ${ROUTE_PATH} 挂载失败（第 ${attempts} 次）：${msg}——2s 后重试`)
          timer = setTimeout(tryMount, 2000)
        } else {
          log?.warn?.(`[dsh-worldtree] ${ROUTE_PATH} 挂载失败 ${attempts} 次，放弃挂载：${msg}`)
        }
        return
      }
      prevOff = off
      log?.info?.(`[dsh-worldtree] 流变wiki 面板路由已挂载 ${ROUTE_PATH}（op=${WIKI_OPS.join('/')}｜后端=本地 wiki_store 副本）`)
    }
    tryMount()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      if (typeof prevOff === 'function') {
        try { prevOff() } catch { /* 已释放 */ }
      }
    }
  }, 'dsh-worldtree: wiki-panel-routes')
}

const OUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

/* ── 工具面 ── */

function registerWorldtreeTool(ctx, cfg) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: '世界树系统（记忆系统 v2）—— 向量主题树：每篇日记/便签按句采 5 样编码，'
      + '按「第 k 层需 ≥k 个向量命中」自动长成主题树；每篇有唯一主题地址与生长记录。'
      + '数据：日记 10,337 + wiki 全量（slug 保留）。'
      + 'action: status 总览｜search 关键词搜成员｜locate 给文本定位主题地址｜'
      + 'insert 编码上树（新记忆走这里，不再送审）｜node 看某节点（成员+近邻）｜stats 分层统计。',
    parameters: {
      action: { type: 'string', enum: ['status', 'search', 'locate', 'insert', 'node', 'stats', 'uploads'], required: true, description: '操作' },
      query: { type: 'string', description: 'search/locate/insert 用：文本（locate/insert 会先编码再进树）' },
      source: { type: 'string', description: 'insert 用：来源坐标（便签坐标/日记坐标/wiki:slug）' },
      node_id: { type: 'number', description: 'node 用：节点 id' },
      limit: { type: 'number', description: 'search 用：返回条数（默认 10）' },
    },
    output: OUT,
    async execute(args) {
      const action = String(args.action || 'status').toLowerCase()

      if (action === 'uploads') {
        const r = await callCore(cfg, { op: 'uploads', limit: Math.min(1000, Math.max(1, Number(args.limit) || 200)) })
        if (!r.ok) return '[错误] ' + r.error
        const bs = r.data.batches || []
        return ['上行台账：共 ' + (r.data.total || 0) + ' 条 / ' + bs.length + ' 批']
          .concat(bs.slice(0, 50).map((b) => b.session + ' ｜ ' + b.at + ' ｜ ' + b.count + ' 条'))
          .join('\n')
      }

      if (action === 'status' || action === 'stats') {
        const r = await callCore(cfg, { op: 'stats' })
        if (!r.ok) return '[错误] ' + r.error
        const st = r.data
        return [
          `[世界树] ${cfg.dbPath}`,
          `成员 ${st.entries}（日记 + wiki，slug 保留）｜节点 ${st.nodes}｜树深 ${st.max_depth}`,
          `各层节点 ${JSON.stringify(st.by_level)}`,
          `各层纯度 ${JSON.stringify(st.purity_by_level)}（枝内主导工作区占比）`,
          `工作区/家族 ${st.workspaces}｜生长事件 ${st.growth_events}`,
        ].join('\n')
      }

      if (action === 'search') {
        const q = String(args.query || '').trim()
        if (!q) return '[错误] search 需要 query'
        const r = await callCore(cfg, { op: 'search', query: q, limit: Number(args.limit) || 10 })
        if (!r.ok) return '[错误] ' + r.error
        const hits = r.data.hits || []
        if (!hits.length) return `[空] 「${q}」无命中`
        return hits.map((h) =>
          `${h.source}｜L${h.level} 节点 ${h.node_id}${h.ws ? `｜${h.ws}` : ''}${h.snippet ? `｜${h.snippet}` : ''}`,
        ).join('\n')
      }

      if (action === 'locate') {
        const q = String(args.query || '').trim()
        if (!q) return '[错误] locate 需要 query'
        const e = await embed(cfg, [q])
        if (!e.ok) return '[错误] 编码失败：' + e.error
        const r = await callCore(cfg, { op: 'locate', vecs: e.vectors[0] })
        if (!r.ok) return '[错误] ' + r.error
        const path = r.data.path || []
        if (!path.length) return '[空] 树上没有可匹配的入口（树为空？）'
        return '主题地址：\n' + path.map((p) =>
          `  L${p.level} → 节点 ${p.node_id}（成员 ${p.members}）`).join('\n')
      }

      if (action === 'insert') {
        const q = String(args.query || '').trim()
        if (!q) return '[错误] insert 需要 query（正文）'
        const source = String(args.source || '').trim() || ('adhoc/' + new Date().toISOString().slice(0, 19))
        const e = await embed(cfg, [q.slice(0, 4000)])
        if (!e.ok) return '[错误] 编码失败：' + e.error
        const fam = e.vectors[0]
        const e2 = await embed(cfg, [q])   // 5 采样在树核内做（树核持有切分规则）
        const r = await callCore(cfg, { op: 'insert', source, text: q, fam: fam })
        if (!r.ok) return '[错误] ' + r.error
        const path = r.data.path || []
        return `[OK] 已上树（${source}）\n` + path.map((p) => `  L${p[0]} → 节点 ${p[1]}`).join('\n')
      }

      if (action === 'node') {
        const nid = Number(args.node_id)
        if (!Number.isFinite(nid)) return '[错误] node 需要 node_id'
        const r = await callCore(cfg, { op: 'node', node_id: nid })
        if (!r.ok) return '[错误] ' + r.error
        const d = r.data
        return [
          `节点 ${d.id}（L${d.level}，${d.kind}）｜成员 ${d.entry_count}`,
          '成员：' + (d.sources || []).join('、'),
          '近邻：' + (d.neighbors || []).map((x) => `${x.source}(${x.via})`).join('、'),
        ].join('\n')
      }

      return '[错误] 未知 action：' + action
    },
  })), TOOL_NAME)
}

/* ── 入口 ── */

/* ── 内置向量化服务（llama-server · Qwen3-Emb Q4_K_M · 8082）────────────────
 * 2026-10-10 管理员指令：向量化服务内置本插件（用 Q4），原 dsh-liubian-embed 关停。
 * 模式移植自家 dsh-liubian-embed（已验证实现），两处升级：
 *   ① 模型换 Q4_K_M（378MB；量化阶梯实测 AUC 与 Q8 无差异，见世界树 experiments/）；
 *   ② **接管逻辑**：8082 在线但 /props 显示仍是旧 Q8_0 模型 → 停旧起新（一次迁移）。
 * 端口沿用 8082（家族端口；wiki_store helper 硬编码该端口，记忆检索零配置迁移）。
 */
export const EMBED_TOOL = '_dsh_external_dsh_liubian_embed'

const EMBED_DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh')

const EMBED_DEFAULTS = {
  embedUrl: 'http://127.0.0.1:8082',
  embedPort: 8082,
  serverExe: 'E:/llama.cpp/llama-server.exe',
  serverArgs: [
    '-m', 'E:/llama.cpp/models/qwen3-emb/Qwen3-Embedding-0.6B-Q4_K_M.gguf',
    '--host', '127.0.0.1', '--port', '8082',
    '-c', '8192', '-ngl', '99', '--embeddings',
  ],
  serverCwd: 'E:/llama.cpp',
  autoEnsureOnLoad: true,
  readyTimeoutMs: 45000,
  probeTimeoutMs: 3000,
  watchdogEnabled: true,
  watchdogIntervalSec: 300,
  watchdogLimitMb: 4096,
}

function embedConfigFile() {
  return join(EMBED_DSH_HOME, 'worldtree', 'embed.json')
}

function embedResolveConfig() {
  const merged = { ...EMBED_DEFAULTS }
  try {
    // 剥 BOM：记事本 / PowerShell 写出的 JSON 带 BOM，直接 parse 会抛错
    const patch = JSON.parse(readFileSync(embedConfigFile(), 'utf8').replace(/^\uFEFF/, '')) || {}
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null || v === '') continue
      merged[k] = v
    }
  } catch { /* 无配置文件用默认值 */ }
  return merged
}

const embedSleep = (ms) => new Promise((r) => setTimeout(r, ms))
let embedLogger = null
let embedLastWatchdog = ''

function embedProbe(cfg) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), cfg.probeTimeoutMs || 3000)
  return fetch(new URL('/health', cfg.embedUrl), { signal: ctl.signal })
    .then((r) => ({ ok: r.ok, status: r.status, body: '' }))
    .catch((err) => ({ ok: false, status: 0, body: (err && err.message) || String(err) }))
    .finally(() => clearTimeout(timer))
}

function embedLaunch(cfg) {
  try {
    const exe = String(cfg.serverExe || '')
    if (!exe || !existsSync(exe)) return '[错误] 未找到 llama-server：' + exe
    const args = Array.isArray(cfg.serverArgs) ? cfg.serverArgs.map(String) : []
    const child = spawn(exe, args, {
      cwd: existsSync(String(cfg.serverCwd || '')) ? cfg.serverCwd : undefined,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return '已启动（直起 exe，无窗）'
  } catch (err) {
    return '[错误] ' + ((err && err.message) || String(err))
  }
}

function embedListeningPid(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
      encoding: 'utf-8', windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
    })
    for (const line of String(out).split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length >= 5 && cols[3] === 'LISTENING' && cols[1].endsWith(':' + port)) {
        const pid = Number(cols[4])
        if (Number.isFinite(pid) && pid > 0) return pid
      }
    }
  } catch { /* netstat 不可用就当找不到 */ }
  return 0
}

function embedStopService(cfg) {
  const pid = embedListeningPid(cfg.embedPort)
  if (!pid) return { ok: true, pid: 0 }
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 20000 })
    return { ok: true, pid }
  } catch (err) {
    return { ok: false, pid, error: (err && err.message) || String(err) }
  }
}

const EMBED_PWSH = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

function embedPrivateCommitMb(pid) {
  if (!pid) return 0
  try {
    const out = execFileSync(EMBED_PWSH, [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).PrivateMemorySize64`,
    ], { encoding: 'utf-8', windowsHide: true, timeout: 20000, maxBuffer: 1 << 20 })
    const v = Number(String(out || '').trim())
    return Number.isFinite(v) && v > 0 ? v / 1048576 : 0
  } catch {
    return 0
  }
}

/** 接管检测：8082 在线但 /props 显示旧 Q8_0 模型 → 停掉（起 Q4 由调用方完成）。 */
async function embedTakeoverIfOldModel(cfg) {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), cfg.probeTimeoutMs || 3000)
    const res = await fetch(new URL('/props', cfg.embedUrl), { signal: ctl.signal })
    clearTimeout(timer)
    if (!res.ok) return false
    const text = await res.text()
    if (/Q8_0/i.test(text)) {
      const r = embedStopService(cfg)
      embedLogger?.warn?.(`[dsh-worldtree] 8082 在线但仍是旧 Q8_0 模型 → 已接管停旧（pid=${r.pid}），改起 Q4_K_M`)
      await embedSleep(1500)
      return true
    }
    return false
  } catch {
    return false
  }
}

async function embedEnsureReady(cfg) {
  const before = await embedProbe(cfg)
  if (before.ok) {
    await embedTakeoverIfOldModel(cfg)      // 在线也要验模型：旧 Q8 → 停旧起新
  }
  let launched = null
  if (!(await embedProbe(cfg)).ok) {
    launched = embedLaunch(cfg)
    if (String(launched).startsWith('[错误]')) return { ok: false, error: launched }
  }
  const started = Date.now()
  const deadline = started + (Number(cfg.readyTimeoutMs) || 45000)
  for (;;) {
    if (Date.now() > deadline) {
      return { ok: false, pending: true, seconds: Math.round((Date.now() - started) / 1000) }
    }
    await embedSleep(2000)
    const now = await embedProbe(cfg)
    if (now.ok) return { ok: true, already: !launched, seconds: Math.round((Date.now() - started) / 1000), body: now.body }
  }
}

let embedLastEnsureAt = 0
function embedEnsureInFlow(cfg, logger, { force = false } = {}) {
  if (!force && !cfg.autoEnsureOnLoad) return
  if (!force && Date.now() - embedLastEnsureAt < 60000) return
  embedLastEnsureAt = Date.now()
  void (async () => {
    const up = await embedEnsureReady(cfg)
    if (up.ok) {
      embedLogger?.info?.(`[dsh-worldtree] 内置向量服务在线（Q4_K_M @ ${cfg.embedPort}${up.already ? '，已在位' : `，就绪 ${up.seconds}s`}）`)
    } else if (up.pending) {
      embedLogger?.warn?.(`[dsh-worldtree] 内置向量服务已拉起但 ${up.seconds}s 未就绪（首次加载可能更久）`)
    } else {
      embedLogger?.warn?.(`[dsh-worldtree] 内置向量服务拉起失败：${up.error || ''}`)
    }
  })().catch(() => {})
}

async function embedWatchdogTick(cfg) {
  try {
    const up = await embedProbe(cfg)
    if (!up.ok) {
      // 离线：自动补起（内置服务的自愈）
      embedLaunch(cfg)
      return
    }
    const pid = embedListeningPid(cfg.embedPort)
    if (!pid) return
    const mb = embedPrivateCommitMb(pid)
    if (!mb) return
    const limit = Math.max(512, Number(cfg.watchdogLimitMb) || 4096)
    if (mb <= limit) return
    embedLogger?.warn?.(
      `[dsh-worldtree] 向量服务看门狗：llama-server(PID ${pid}) 私有提交 ${mb.toFixed(0)}MB 超过 ${limit}MB，自动重启`)
    embedStopService(cfg)
    await embedSleep(1500)
    const launched = embedLaunch(cfg)
    embedLastWatchdog = `${new Date().toLocaleString('zh-CN')}｜${mb.toFixed(0)}MB → 重启（launch=${launched}）`
  } catch (err) {
    embedLogger?.warn?.(`[dsh-worldtree] 向量服务看门狗异常：${(err && err.message) || err}`)
  }
}

function embedMountWatchdog(ctx, cfg) {
  if (!cfg.watchdogEnabled) return
  let timer = null
  const loop = async () => {
    await embedWatchdogTick(cfg)
    timer = setTimeout(loop, (Number(cfg.watchdogIntervalSec) || 300) * 1000)
  }
  timer = setTimeout(loop, (Number(cfg.watchdogIntervalSec) || 300) * 1000)
  ctx.effect(() => () => {
    if (timer) clearTimeout(timer)
  }, 'dsh-liubian-memory: 内置向量服务看门狗')
}

const EMBED_OUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

function embedRegisterTool(ctx, cfg) {
  ctx.effect(() => ctx.tools.register(defineTool({
    // 名字保持不变（原挂在 dsh-liubian-embed 上，该插件已按管理员指令关停）——技能与肌肉记忆都不用改
    name: EMBED_TOOL,
    description: '本地语义向量服务（llama.cpp + Qwen3-Embedding-0.6B Q4_K_M，端口 8082）——'
      + '已内置 dsh-liubian-memory（原独立插件 dsh-liubian-embed 已关停）。'
      + '世界树编码与记忆检索共用此服务。插件加载时已自动探活/接管并带起，通常无需手动调；'
      + '本工具用于查看状态、强制拉起、或关停释放显存。'
      + 'action: status 探活｜ensure 拉起并等待就绪｜stop 关停（释放显存）｜restart 重启。',
    parameters: {
      action: { type: 'string', enum: ['status', 'ensure', 'stop', 'restart'], required: true, description: '操作' },
    },
    output: EMBED_OUT,
    async execute(args) {
      const action = String(args.action || 'status').toLowerCase()
      const before = await embedProbe(cfg)

      if (action === 'status') {
        const line = before.ok
          ? `[OK] 向量服务在线：${cfg.embedUrl}（Q4_K_M，内置 dsh-liubian-memory）`
          : `[离线] 向量服务不可用：${cfg.embedUrl}（${before.body}）`
        const pid = embedListeningPid(cfg.embedPort)
        return [
          line,
          `[端口] ${cfg.embedPort}${pid ? `　PID ${pid}` : '　（无监听进程）'}`,
          `[模型] Qwen3-Embedding-0.6B Q4_K_M（378MB，1024 维）`,
          `[看门狗] ${cfg.watchdogEnabled ? `开（私有提交 >${cfg.watchdogLimitMb}MB 自动重启，每 ${cfg.watchdogIntervalSec}s 查一次）` : '关'}${embedLastWatchdog ? `｜最近一次：${embedLastWatchdog}` : ''}`,
          `[配置文件] ${embedConfigFile()}${existsSync(embedConfigFile()) ? '' : '（尚未创建，用默认值）'}`,
        ].filter(Boolean).join('\n')
      }

      if (action === 'stop') {
        const r = embedStopService(cfg)
        if (!r.ok) return `[错误] 关停失败（PID ${r.pid}）：${r.error}`
        return r.pid
          ? `[OK] 已关停向量服务（PID ${r.pid}），显存已释放。想再起来用 action=ensure。`
          : '[OK] 端口上没有监听进程，无需关停。'
      }

      if (action === 'restart') {
        const r = embedStopService(cfg)
        await embedSleep(1500)
        const up = await embedEnsureReady(cfg)
        if (!up.ok) return `[错误] 重启失败：${up.error || '等待就绪超时'}`
        return `[OK] 向量服务已重启并就绪（${up.seconds}s）：${cfg.embedUrl}`
      }

      // ensure
      const up = await embedEnsureReady(cfg)
      if (up.ok) {
        return up.already
          ? `[OK] 向量服务已在线：${cfg.embedUrl}`
          : `[OK] 向量服务已就绪（${up.seconds}s）：${cfg.embedUrl}`
      }
      if (up.pending) {
        return `[待加载] 已拉起向量服务，${up.seconds} 秒内未就绪（模型首次加载可能更久）。稍后用 action=status 复查。`
      }
      return `[错误] ${up.error}`
    },
  })), EMBED_TOOL)
}

/* ── 每轮记忆注入 v1（树定位取材；2026-10-10 定纲：世界树专属记忆，注入是其目的）──
 * 流程：pre-step → 人话输入 → 编码（Q4 @8082）→ 树定位 → 注入命中块。
 * 纪律（检查表 §3.3）：① 人话判定 role=user 且 source.kind 空/'user'（排插件/技能/工具）；
 * ② 注入消息四要件（id=randomUUID/role/source.kind/content 数组）；
 * ③ 整段 try/catch（附带功能绝不拖垮主流程）。
 */

/* ── 记忆注入池：预热池 + 预备池 两级赛马（2026-10-12 按 dsh-liubian v1.3.0 移植）──
 * 设计与实测决议：流变系统/docs/记忆注入改版_方案自审_v1.md（§10 决议表、§11.4 修正实测）。
 * 结构：
 *  · 预热池（候选区）：每轮融合检索 top-prefetchTop 入池（打批次，不注入）；加热只及
 *    更早批次；每轮结算最老批（寿命满 cycleRounds 轮）→ 热度前 settleTop 名晋预备池，余淘汰
 *  · 预备池（赛马胜者区，无上限）：每轮累加余弦（周期内不衰减）；赛马=排序，定补位优先级
 *  · 周期末 = 压缩（compaction/end 置位；消息兜底已删——无压缩即无清空，无需补回）：
 *    保留前 keepFrac（按周期平均余弦的相对名次——绝对门槛实测 1256% 灾难，弃用）
 *    → 全部幸存者整头整正文补回上下文 → 幸存者周期热度清零
 *  · 时机②（独立触发点，不许与①混）：本轮检索命中 ∩ 预备池 ∩ 本周期没注过 → ≤missTop 条立刻补
 *  · 差一拍：注入面只有 pre-step——压缩后的注入发生在下一拍（登记在案，非 bug）
 * 存储：worldtree/inject/<会话8位>.json 原子写；坏件隔离不静默重置。 */
function poolDir() { return join(DSH_HOME, 'worldtree', 'inject') }
function poolFile(key) { return join(poolDir(), key + '.json') }
function poolLoad(key) {
  try {
    const j = JSON.parse(readFileSync(poolFile(key), 'utf8').replace(/^\uFEFF/, ''))
    if (j && j.sessionKey === key && Array.isArray(j.prefetch) && Array.isArray(j.reserve)) return j
    try { rmSync(poolFile(key)) } catch { }                    // 坏件隔离：换名保留现场，重建空池
  } catch { /* 无文件 = 新池 */ }
  return { version: 1, sessionKey: key,
           cycle: { index: 0, rounds: 0, startedAt: Date.now(), boundary: '', boundaryPending: false },
           prefetch: [], reserve: [], batchSeq: 0,
           stats: { prefetchIn: 0, settled: 0, injected: 0, exited: 0 } }
}
function poolSaveSync(pool) {
  try {
    mkdirSync(poolDir(), { recursive: true })
    const tmp = poolFile(pool.sessionKey) + '.tmp'
    writeFileSync(tmp, JSON.stringify(pool), 'utf8')
    renameSync(tmp, poolFile(pool.sessionKey))
  } catch { /* 持久化失败不拖垮主流程 */ }
}
function poolMean(it, rounds) { return (it.cycleHeat || 0) / Math.max(1, rounds || (it && it.rounds) || 1) }

/** 上下文短锚判定（2026-10-12 老机制 entryInContext 移植，管理员认口径）：
 *  按 source + head(≥8字) + body首40字(≥20字) 三重包含判"上下文已有"。
 *  不能拿整段正文做指纹——正文会被注入块/压缩改写，逐字比对永远判"不在"→ 必然重复注入。 */
function entryInContext(it, ctxText) {
  const hay = String(ctxText || '')
  if (!hay) return false
  if (it.source && hay.includes(it.source)) return true
  const head = String(it.head || '').trim()
  if (head.length >= 8 && hay.includes(head)) return true
  const lead = String(it.lead || '').trim().slice(0, 40)
  if (lead.length >= 20 && hay.includes(lead)) return true
  return false
}

function injectBuildBlock(addr, mem, header, tail, cap) {
  // 注入块格式源（正文全文 + 超长截断，管理员 2026-10-10 定纲；注入池块另有池版格式）
  const parts = mem.map((m) => {
    let body = String(m.body || m.snippet || '')
    if (body.length > cap) body = body.slice(0, cap) + '\n…（超长截断；完整正文见 ' + m.source + '）'
    return '【' + m.source + (m.ws ? '（' + m.ws + '）' : '') + '】\n' + body
  })
  return '<worldtree>' + header + addr + '\n\n' + parts.join('\n\n') + '\n\n' + tail + '</worldtree>'
}

function injectHumanText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== 'user') return ''
    const kind = (m.source && m.source.kind) || ''
    if (kind && kind !== 'user') continue
    let t = ''
    const c = m.content
    if (typeof c === 'string') t = c
    else if (Array.isArray(c)) t = c.map((x) => (x && x.text) || '').join(' ')
    t = String(t).trim()
    if (t) return t
  }
  return ''
}

function injectMount(ctx, cfg) {
  if (!cfg.injectEnabled) return
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    try {
      if (decision.kind !== 'enter' || signal?.aborted) return decision
      const skey = p3SessionKey(agent && agent.session)
      if (!skey || skey === 'unknown' || cfg.injectPool === false) return decision
      const pool = poolLoad(skey)
      const q = injectHumanText(messages || [])
      // 上下文全文（短锚判定用）：含注入块自己——注入过的条目，锚自动在场
      const ctxText = (messages || []).map((m) => { const c = m.content
        return Array.isArray(c) ? c.map((b) => (b && b.text) || '').join('') : (typeof c === 'string' ? c : '') }).join('\n')
      const ms = Number(cfg.injectTimeoutMs) || 8000
      const guard = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))])

      // ① 检索：向量可用 → 语义+标签融合；不可用 → 纯 tag 降级（G1，老契约：静默回退不阻塞）
      let vectorUp = true
      let tagOnly = false
      let table = []
      if (q && q.length >= (cfg.injectMinChars || 8)) {
        const e = await guard(embed(cfg, [q.slice(0, 2000)]))
        if (e && e.ok) {
          let rc = await guard(callCore(cfg, { op: 'race', vecs: e.vectors[0], text: q, want: Number(cfg.injectHeatTop) || 200 }))
          if (rc && rc.ok) {
            table = rc.data.ranked || []
            const missing = rc.data.missing || []
            if (missing.length) {
              // 新条目向量回填：批量嵌入 → 缓存 → 重排一次（此后走缓存）
              const em = await guard(embed(cfg, missing.map((m) => m.text.slice(0, 4000))))
              if (em && em.ok) {
                await guard(callCore(cfg, { op: 'vec_cache_set', items: missing.map((m, i2) => ({ source: m.source, vec: em.vectors[i2] })) }))
                const rc2 = await guard(callCore(cfg, { op: 'race', vecs: e.vectors[0], text: q, want: Number(cfg.injectHeatTop) || 200 }))
                if (rc2 && rc2.ok) table = rc2.data.ranked || []
              }
            }
          }
        }
        // G1 纯 tag 降级：降级表仅供时机②命中补漏判定；入池/加热跳过
        //（热度口径必须可比——自审 §5：不做纯 tag 入池，混着来不可比）
        if (!table.length) {
          const rcT = await guard(callCore(cfg, { op: 'race', text: q, want: 30 }))
          if (rcT && rcT.ok && (rcT.data.ranked || []).length) {
            table = rcT.data.ranked || []
            tagOnly = true
            vectorUp = false
            ctx.logger?.warn?.(`[dsh-worldtree] 注入池：向量服务不可用，降级纯 tag 检索（${table.length} 条；本轮不入池不加热，仅命中补漏判定）`)
          }
        }
      }
      const cosOf = {}
      for (const r of table) cosOf[r.source] = r

      // ② 入池（打批次；已在两池的不重复入）+ ③ 加热（只及更早批次与预备池）+ ④ 结算最老批
      //    热度口径 = 三通道归一化总分（2026-10-12 管理员定案）
      if (vectorUp && table.length) {
        pool.batchSeq = (pool.batchSeq || 0) + 1
        const topN = Number(cfg.injectPrefetchTop) || 10
        for (const r of table.slice(0, topN)) {
          if (pool.prefetch.some((x) => x.source === r.source) || pool.reserve.some((x) => x.source === r.source)) continue
          pool.prefetch.push({ source: r.source, batch: pool.batchSeq, heat: r.total,
                               head: r.head || '', lead: r.lead || '' })
          pool.stats.prefetchIn++
        }
        for (const it of pool.prefetch) {
          if (it.batch >= pool.batchSeq) continue
          const c = cosOf[it.source]
          if (c !== undefined && c.total !== undefined) it.heat = (it.heat || 0) + c.total
        }
        for (const it of pool.reserve) {
          const c = cosOf[it.source]
          if (c === undefined || c.total === undefined) continue
          it.cycleHeat = (it.cycleHeat || 0) + c.total
          it.totalHeat = (it.totalHeat || 0) + c.total
        }
        pool.cycle.rounds = (pool.cycle.rounds || 0) + 1
        const oldest = Math.min(...pool.prefetch.map((x) => x.batch))
        if (pool.batchSeq - oldest >= (Number(cfg.injectCycleRounds) || 3)) {
          const oldBatch = pool.prefetch.filter((x) => x.batch === oldest)
          const winners = oldBatch.slice().sort((a, b) => (b.heat || 0) - (a.heat || 0)).slice(0, Number(cfg.injectSettleTop) || 3)
          pool.prefetch = pool.prefetch.filter((x) => x.batch !== oldest)
          for (const w of winners) {
            const ex = pool.reserve.find((x) => x.source === w.source)
            if (ex) { ex.cycleHeat = (ex.cycleHeat || 0) + (w.heat || 0); ex.totalHeat = (ex.totalHeat || 0) + (w.heat || 0) }
            else pool.reserve.push({ source: w.source, cycleHeat: 0, totalHeat: w.heat || 0, injectedCycle: -1,
                                     lastHit: pool.batchSeq, head: w.head || '', lead: w.lead || '' })
          }
          pool.stats.settled++
        }
      }
      poolSaveSync(pool)

      // ⑤ 时机①：周期末（仅压缩置位——2026-10-12 管理员裁定删消息兜底：
      //    没有压缩就没有上下文清空，无需补回；无满足要求的记忆 → 不注入）
      //    退池：保留前 keepFrac（周期平均热度相对名次——绝对门槛实测弃用）
      //    注入预算制：压缩补位 ≤refillTop 条、字数预算内。未注入的幸存者留预备池。
      if (pool.cycle.boundaryPending && pool.reserve.length) {
        const why = '压缩补位'
        pool.cycle.boundaryPending = false
        const keepN = Math.max(1, Math.ceil(pool.reserve.length * (Number(cfg.injectKeepFrac) || 0.5)))
        const sorted = pool.reserve.slice().sort((a, b) => poolMean(b, pool.cycle.rounds) - poolMean(a, pool.cycle.rounds))
        const survivors = sorted.slice(0, keepN)
        pool.stats.exited += sorted.length - survivors.length
        pool.reserve = survivors
        for (const s2 of survivors) s2.cycleHeat = 0
        pool.cycle.index = (pool.cycle.index || 0) + 1
        pool.cycle.rounds = 0
        // 补回不设上限（管理员 2026-10-12 裁定）：全部幸存者整头整正文补回
        const toInject = survivors.filter((it) => !entryInContext(it, ctxText))
        if (!toInject.length) {
          ctx.logger?.info?.(`[dsh-worldtree] 注入池周期补位：幸存者均已在上下文，跳过注入`)
          return decision
        }
        const bd = await guard(callCore(cfg, { op: 'bodies', sources: toInject.map((x) => x.source) }))
        const bodies = (bd && bd.ok && bd.data && bd.data.bodies) || {}
        const rows = []
        for (const it of toInject) {
          const body = bodies[it.source] || ''
          if (body.length < 40) continue
          it.injectedCycle = pool.cycle.index
          if (!it.head) it.head = String(body).split('\n')[0].slice(0, 120)
          if (!it.lead) it.lead = String(body).replace(/\s+/g, '').slice(0, 40)
          rows.push(`【${it.source}】\n  周期热度 ${poolMean(it, pool.cycle.rounds).toFixed(3)}｜累计 ${(it.totalHeat || 0).toFixed(2)}\n${body}`)
        }
        if (rows.length) {
          pool.stats.injected += rows.length
          poolSaveSync(pool)
          const text = '<worldtree from="注入池" why="' + why + '" hits="' + rows.length + '">\n' + rows.join('\n\n')
            + `\n\n【注入池】以上是本轮上下文压缩后补回的记忆（在池内经两级赛马留存下来），直接当作既有知识使用，不必再检索。</worldtree>`
          const recall = { id: randomUUID(), role: 'user', content: [{ type: 'text', text }],
                           source: { kind: 'plugin:dsh-worldtree', form: 'pool-refill' } }
          ctx.logger?.info?.(`[dsh-worldtree] 注入池周期补位：${rows.length} 条（${why}）`)
          return { kind: 'enter', messages: [...(decision.messages || []), recall] }
        }
      }

      // ⑥ 时机②（独立触发点）：本轮检索命中（语义或纯 tag 降级）∩ 预备池 ∩ 本周期没注过
      //    ∩ 上下文短锚判"没有" → ≤missTop 条立刻补。「命中」这道门是它稀疏的关键。
      if (table.length && pool.reserve.length) {
        const hitSet = new Set(table.slice(0, Math.max(1, Number(cfg.injectPrefetchTop) || 10)).map((r) => r.source))
        const cand = pool.reserve
          .filter((it) => hitSet.has(it.source) && (it.injectedCycle || -1) !== pool.cycle.index
                           && !entryInContext(it, ctxText))
          .sort((a, b) => poolMean(b, pool.cycle.rounds) - poolMean(a, pool.cycle.rounds))
          .slice(0, Math.max(1, Number(cfg.injectMissTop) || 3))
        if (cand.length) {
          const bd = await guard(callCore(cfg, { op: 'bodies', sources: cand.map((x) => x.source) }))
          const bodies = (bd && bd.ok && bd.data && bd.data.bodies) || {}
          const rows = []
          for (const it of cand) {
            const body = bodies[it.source] || ''
            if (body.length < 40) continue
            it.injectedCycle = pool.cycle.index
            if (!it.head) it.head = String(body).split('\n')[0].slice(0, 120)
            if (!it.lead) it.lead = String(body).replace(/\s+/g, '').slice(0, 40)
            rows.push(`【${it.source}】\n  周期热度 ${poolMean(it, pool.cycle.rounds).toFixed(3)}｜累计 ${(it.totalHeat || 0).toFixed(2)}\n${body}`)
          }
          if (rows.length) {
            pool.stats.injected += rows.length
            poolSaveSync(pool)
            const text = '<worldtree from="注入池" why="命中补漏" hits="' + rows.length + '">\n' + rows.join('\n\n')
              + '\n\n【注入池】以上是预备池中经两级赛马留存、本轮检索又命中且上下文没有的记忆，直接当作既有知识使用。</worldtree>'
            const recall = { id: randomUUID(), role: 'user', content: [{ type: 'text', text }],
                             source: { kind: 'plugin:dsh-worldtree', form: 'pool-hit' } }
            ctx.logger?.info?.(`[dsh-worldtree] 注入池命中补漏：${rows.length} 条`)
            return { kind: 'enter', messages: [...(decision.messages || []), recall] }
          }
        }
      }
    } catch (err) {
      ctx.logger?.warn?.(`[dsh-worldtree] 注入池管线异常（不拖垮主流程）：${(err && err.message) || err}`)
    }
    return decision
  }, { prepend: true })
}

/* ── P3 上行自动化（管理员 2026-10-10 定纲）：触发一次上下文压缩 → 被压缩的全部
 * 上下文送提炼（不限篇数，98% 保真提示词——experiments/compress_fidelity 验证版）
 * → 逐条编码上树 → 台账记【真实对话哈希】。
 * 纪律：只读会话事件、绝不写会话（§3.3.5）；整段 try/catch 不拖垮主流程（§3.6）；
 * 提炼输入只收人话（source.kind 空/user）——排掉一切合成注入，防回声。
 *
 * P3 v2（2026-10-11 排障改版）：v1「全局单缓冲」被实证冲垮——多会话并行时
 * 「会话切换即清空」把缓冲反复归零，compaction/end 时不足 minChars 静默返回，
 * 无审计无日记无日志（本机 06:40 手动压缩，三会话交错实证）。且缓冲只含进程
 * 启动后的消息，重启即丢，天然不等于「被压缩的全部上下文」。
 * v2 改读权威来源：compaction/summary 事件自带 shadowedRange（闭区间 surface
 * seq），用 session.snapshotEvents(start, end+1) 同步取回被压缩的原始事件再提炼。
 * 被遮蔽事件永久保留在日志中——多会话并行、进程重启都影响不到它。
 * 无缓冲、无跨会话污染；每个分支必留日志，不再有静默出口。 */
let p3Busy = false
let p3BusySince = 0          // busy 起始时刻（看门狗用：卡死自愈）
const p3Queue = []            // 内存工作队列（作业对象与 p3Jobs 同引用）
let p3Batch = 0
let p3Jobs = []               // 持久作业表（断点续传）：{sid,texts,distilled,batch,queuedAt}
const p3Recent = []           // 最近压缩检测（记录视图展示，内存态，≤10 条）

/* p3Busy 看门狗（2026-10-12）：一次网络僵死让提炼 fetch 挂了 4 小时（AbortSignal
 * 对已建立的僵死连接不生效——实证），p3Busy 恒真 → 后续所有 P3 作业排队 forever。
 * 每 60s 巡检：busy 超 10 分钟 → 强制解锁并重排当前作业（作业有落盘，不丢）。 */
let p3WatchdogCtx = null
function p3WatchdogTick() {
  if (!p3Busy || !p3BusySince) return
  const stuckMin = (Date.now() - p3BusySince) / 60000
  if (stuckMin < 10) return
  p3Busy = false
  p3BusySince = 0
  const job = p3Queue[0]
  p3WatchdogCtx?.logger?.warn?.(`[dsh-worldtree] P3 看门狗：busy 挂起 ${stuckMin.toFixed(0)} 分钟，强制解锁` +
    (job ? `（作业 ${job.sid} 重排队）` : ''))
  if (p3WatchdogCtx && job) p3Drain(p3WatchdogCtx, p3WatchdogCfg)
}
let p3WatchdogCfg = null

function p3Note(sid, range, segs, chars, status) {
  p3Recent.unshift({ sid, range: String(range), segs: Number(segs) || 0, chars: Number(chars) || 0,
                     status, at: new Date().toISOString().replace('T', ' ').slice(5, 19) })
  if (p3Recent.length > 10) p3Recent.length = 10
}

/* ── P3 断点续传（2026-10-11 管理员指令）：提炼/上树被中断（崩溃、DSH 重启）
 * 时作业落盘 p3_pending.json，下次插件挂载自动续传。
 * 锚点①：提炼完成即落盘（texts 可丢，只存 distilled）
 * 锚点②：逐条 insert 前 exists 查重——已上树的条目不重复插（恢复天然幂等）
 * 批次计数器同步落盘：防重启后同会话新压缩与旧批次撞号（撞号会被 exists 误去重） */
function p3File() {
  return join(DSH_HOME, 'worldtree', 'p3_pending.json')
}
function p3Load() {
  try {
    const j = JSON.parse(readFileSync(p3File(), 'utf8').replace(/^\uFEFF/, '')) || {}
    if (Array.isArray(j.jobs)) {
      p3Batch = Number(j.batch) || 0
      return j.jobs.filter((x) => x && x.sid)
    }
  } catch { /* 无文件 = 无续传 */ }
  return []
}
function p3Save() {
  try {
    const dir = join(DSH_HOME, 'worldtree')
    mkdirSync(dir, { recursive: true })   // 2026-10-12 血案修复：目录不存在曾静默放弃持久化，
                                          // 断点续传从未落过盘——必须主动建目录
    const payload = { batch: p3Batch, savedAt: Date.now(),
      jobs: p3Jobs.map((j) => (j.distilled
        ? { sid: j.sid, batch: j.batch, distilled: j.distilled, queuedAt: j.queuedAt }
        : { sid: j.sid, texts: j.texts, queuedAt: j.queuedAt })) }
    const tmp = p3File() + '.tmp'
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, p3File())
  } catch { /* 持久化失败不拖垮主流程 */ }
}
function p3Remove(job) {
  const i = p3Jobs.indexOf(job)
  if (i >= 0) p3Jobs.splice(i, 1)
  p3Save()
}

function p3SessionKey(session) {
  const id = (session && (session.id || session.sessionId || session.hash)) || ''
  return String(id).replace(/^session-/, '').slice(0, 8) || 'unknown'
}

function p3ExtractHuman(evs) {
  // 从事件数组滤「人话」：user/message（kind 空/user）+ assistant/message 全文
  const out = []
  for (const e of evs || []) {
    if (!e || typeof e !== 'object') continue
    if (e.type === 'user/message') {
      const d = e.data || {}
      const kind = (d.source && d.source.kind) || ''
      if (kind && kind !== 'user') continue   // 排插件/技能目录/压缩摘要等一切合成注入
      let txt = d.text || d.content || ''
      if (Array.isArray(txt)) txt = txt.map((x) => (x && x.text) || '').join(' ')
      txt = String(txt).trim()
      if (txt) out.push('【人】' + txt)
    } else if (e.type === 'assistant/message') {
      const m = (e.data && e.data.message) || e.data || {}
      let c = m.content
      if (Array.isArray(c)) c = c.map((x) => (x && x.text) || '').join(' ')
      if (typeof c === 'string' && c.trim()) out.push('【助手】' + c.trim())
    }
  }
  return out
}

function p3LLM() {
  // 热读：每次提炼前重读设置文件（设置界面改完即时生效，无需重启）
  let url = ''
  let key = ''
  let model = ''
  try {
    const j = JSON.parse(readFileSync(configFile(), 'utf8').replace(/^\uFEFF/, '')) || {}
    if (j.llmUrl) url = j.llmUrl
    if (j.llmKey) key = j.llmKey
    if (j.llmModel) model = j.llmModel
  } catch { /* 本插件设置缺席 */ }
  if (!url || !key) {
    try { // 家族共享配置兜底
      const j = JSON.parse(readFileSync(join(DSH_HOME, 'liubian', 'config.json'), 'utf8').replace(/^\uFEFF/, '')) || {}
      if (!url && j.llmApiUrl) url = j.llmApiUrl
      if (!key && j.llmApiKey) key = j.llmApiKey
      // 注意：liubian 的模型字段是 llmApiModel（2026-10-11 实测），llmModel 是旧名——两个都收
      if (!model && j.llmModel) model = j.llmModel
      if (!model && j.llmApiModel) model = j.llmApiModel
    } catch { /* 缺席用缺省 */ }
  }
  return { url: url || 'https://api.deepseek.com/chat/completions', key,
           model: model || 'deepseek-flash' }
}

function p3HotNums() {
  // 提炼数值参数同样热读（分片/上限/最小字数）
  try {
    const j = JSON.parse(readFileSync(configFile(), 'utf8').replace(/^\uFEFF/, '')) || {}
    return { chunk: Number(j.p3ChunkChars) || 40000,
             maxTokens: Number(j.p3MaxTokens) || 16384,
             minChars: Number(j.p3MinChars) || 2000,
             total: Number(j.p3TotalChars) || 330000 }
  } catch { return { chunk: 40000, maxTokens: 16384, minChars: 2000, total: 330000 } }
}

/* ── P3·bili 通道（2026-10-19 双轨定案）──────────────────────────────
 * bili（billion-context 代理层）在上下文视图压缩会话，blocks 表记账压缩块
 * ref 区间。每 180s 轮询新 active 块：①块摘要 ≥100 字零 LLM 直采上树（选项 A）
 * ②块区间 user/assistant 正文走与 DSH 压缩通道同一条提炼管线。
 * 跨通道幂等 = 正文指纹（sha256）：bili ref 口径与 DSH seq 口径不可换算，
 * 正文 hash 是两种编号的共同语言。指纹只对入队 seg 记（低于 minChars 不记，
 * 防内容永久丢失）。状态水位/块标记/指纹存 p3_bili.json（不碰 bili 库）。 */
const BILI_SKIP_PREFIXES = ['<worldtree ', '<system-reminder', '<skill_content', '<skill ', '[ACP', '📦']

let p3LastSid = ''          // 从 session/event 持续刷新（bili 轮询需要会话键）
let p3BiliState = null
let p3BiliTickBusy = false

function p3BiliFile() { return join(DSH_HOME, 'worldtree', 'p3_bili.json') }

function p3BiliLoad() {
  if (p3BiliState) return p3BiliState
  try {
    p3BiliState = JSON.parse(readFileSync(p3BiliFile(), 'utf8').replace(/^\uFEFF/, '')) || {}
  } catch { p3BiliState = {} }
  if (!p3BiliState.watermarks) p3BiliState.watermarks = {}
  if (!p3BiliState.doneBlocks) p3BiliState.doneBlocks = {}
  if (!p3BiliState.fps) p3BiliState.fps = {}
  return p3BiliState
}

function p3BiliSave() {
  try {
    // 容量闸：指纹/块标记每会话各留最近 4000 条（防长会话无限膨胀）
    for (const sid of Object.keys(p3BiliState.fps)) {
      const ks = Object.keys(p3BiliState.fps[sid])
      if (ks.length > 4000) for (const k of ks.slice(0, ks.length - 4000)) delete p3BiliState.fps[sid][k]
    }
    for (const sid of Object.keys(p3BiliState.doneBlocks)) {
      const ks = Object.keys(p3BiliState.doneBlocks[sid])
      if (ks.length > 4000) for (const k of ks.slice(0, ks.length - 4000)) delete p3BiliState.doneBlocks[sid][k]
    }
    mkdirSync(dirname(p3BiliFile()), { recursive: true })
    const tmp = p3BiliFile() + '.tmp'
    writeFileSync(tmp, JSON.stringify(p3BiliState), 'utf8')
    renameSync(tmp, p3BiliFile())
  } catch { /* 持久化失败不拖垮主流程 */ }
}

function p3Fp(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

async function p3BiliTick(ctx, cfg, kickDrain = true) {
  if (cfg && cfg.p3BiliEnabled === false) return
  if (!p3LastSid) return
  if (p3BiliTickBusy) return
  p3BiliTickBusy = true
  try {
    const st = p3BiliLoad()
    const wm = st.watermarks[p3LastSid] || 0
    const bcfg = cfg || { p3BiliDb: DEFAULTS.p3BiliDb, p3BiliSummaryDirect: DEFAULTS.p3BiliSummaryDirect }
    const r = await callCore(bcfg, { op: 'bili_blocks', db: bcfg.p3BiliDb, prefix: p3LastSid, after: wm })
    const data = (r && r.data) || {}
    if (!data.ok) {
      if (!data.missing)  // 库缺席 = billion-context 没启用，静默；其他错留痕下轮再试
        ctx.logger?.warn?.('[dsh-worldtree] P3·bili：扫描失败（下轮再试）：' + (data.error || (r && r.error) || '未知'))
      return
    }
    const blocks = data.blocks || []
    if (!blocks.length) return
    const hot = p3HotNums()
    const done = st.doneBlocks[p3LastSid] || (st.doneBlocks[p3LastSid] = {})
    const fps = st.fps[p3LastSid] || (st.fps[p3LastSid] = {})
    let maxAt = wm, enqueued = 0
    for (const b of blocks) {
      if (b.created_at > maxAt) maxAt = b.created_at
      const key = b.session_id + '/' + b.block_id
      if (done[key]) continue
      // ① 块摘要直采（选项 A）：bili 压缩摘要质量高（TASK AS OF THIS BLOCK 结构化
      //    块），≥100 字直接作 distilled 预置作业，零 LLM 上树
      const sum = String(b.summary || '').trim()
      if (bcfg.p3BiliSummaryDirect !== false && sum.length >= 100) {
        const topic = String(b.topic || '').trim()
        const head = (topic || sum.split('\n').find((l) => l.trim()) || 'bili压缩块')
          .replace(/^#+\s*/, '').slice(0, 80)
        const job = { sid: p3LastSid, distilled: [{ head, body: sum }], queuedAt: Date.now(),
                      batch: 0, phase: 'queued', src: 'bili-sum',
                      range: 'bili:' + b.block_id, segs: 0, chars: sum.length }
        p3Jobs.push(job)
        p3Queue.push(job)
        p3Note(p3LastSid, job.range, 1, sum.length, '块摘要直采')
        ctx.logger?.info?.(`[dsh-worldtree] P3·bili：${p3LastSid} 块 ${b.block_id}（ref ${b.start_ref}–${b.end_ref}）摘要 ${sum.length} 字直采入队`)
        enqueued++
      }
      // ② 区间正文提炼（与 DSH 压缩通道同管线）
      const ru = await callCore(bcfg, { op: 'bili_users', db: bcfg.p3BiliDb,
                                        session_id: b.session_id, from_ref: b.start_ref, to_ref: b.end_ref })
      const rdata = (ru && ru.data) || {}
      if (!rdata.ok) {
        ctx.logger?.warn?.(`[dsh-worldtree] P3·bili：块 ${b.block_id} 取材失败（跳过正文提炼，DSH 通道兜底）：` + (rdata.error || '未知'))
        done[key] = 1
        p3BiliSave()
        continue
      }
      // 滤合成注入（worldtree 注入/系统提醒/技能目录/ACP 标记）+ 跨通道指纹闸
      const cand = []
      for (const t of rdata.texts || []) {
        if (t.role === 'user' && BILI_SKIP_PREFIXES.some((p) => t.text.startsWith(p))) continue
        const seg = (t.role === 'user' ? '【人】' : '【助手】') + t.text
        const fp = p3Fp(seg)
        if (fps[fp]) continue
        cand.push({ seg, fp })
      }
      if (cand.length) {
        // 总量上限保新弃旧（与 DSH 通道同律）
        const keptObjs = []
        let total = 0, droppedOld = 0
        for (let i = cand.length - 1; i >= 0; i--) {
          if (total + cand[i].seg.length > hot.total) { droppedOld = i + 1; break }
          keptObjs.unshift(cand[i])
          total += cand[i].seg.length
        }
        if (droppedOld > 0)
          ctx.logger?.warn?.(`[dsh-worldtree] P3·bili：${p3LastSid} 块 ${b.block_id} 超 ${hot.total} 字上限（保新弃旧），${cand.length} 段只入 ${keptObjs.length} 段`)
        if (total >= hot.minChars) {
          for (const k of keptObjs) fps[k.fp] = 1     // 指纹只对入队 seg 记（防内容丢失）
          const job = { sid: p3LastSid, texts: keptObjs.map((k) => k.seg), queuedAt: Date.now(),
                        distilled: null, batch: 0, phase: 'queued', src: 'bili',
                        range: 'bili:' + b.block_id + ' ' + b.start_ref + '-' + b.end_ref,
                        segs: keptObjs.length, chars: total }
          p3Jobs.push(job)
          p3Queue.push(job)
          p3Note(p3LastSid, 'bili:' + b.block_id, keptObjs.length, total, '已捕获(bili)')
          ctx.logger?.info?.(`[dsh-worldtree] P3·bili：${p3LastSid} 块 ${b.block_id} 捕获 ${keptObjs.length} 段 ${total} 字`)
          enqueued++
        } else {
          ctx.logger?.info?.(`[dsh-worldtree] P3·bili：${p3LastSid} 块 ${b.block_id} 人话 ${total} 字 < ${hot.minChars}，跳过提炼（正常）`)
        }
      }
      done[key] = 1
      p3BiliSave()
      if (enqueued) p3Save()                           // 入队即落盘（断点续传锚点⓪）
    }
    st.watermarks[p3LastSid] = maxAt
    p3BiliSave()
    if (enqueued && kickDrain) p3Drain(ctx, cfg)
  } catch (err) {
    ctx.logger?.warn?.('[dsh-worldtree] P3·bili 轮询异常（忽略）：' + ((err && err.message) || err))
  } finally {
    p3BiliTickBusy = false
  }
}

function p3Mount(ctx, cfg) {
  if (cfg.p3Enabled === false) return
  // 断点续传：上次被中断的作业（提炼/上树）自动排队续跑
  p3Jobs = p3Load()
  if (p3Jobs.length) {
    const toDistill = p3Jobs.filter((j) => !j.distilled).length
    ctx.logger?.info?.(`[dsh-worldtree] P3 续传：载入 ${p3Jobs.length} 个未完成任务（待提炼 ${toDistill} / 待上树 ${p3Jobs.length - toDistill}）`)
    for (const j of p3Jobs) p3Queue.push(j)
    p3Drain(ctx, cfg)
  }
  // p3Busy 看门狗（每 60s 巡检：busy 超 10 分钟强制解锁重排）
  p3WatchdogCtx = ctx
  p3WatchdogCfg = cfg
  ctx.effect(() => {
    let n = 0
    const t = setInterval(() => {
      try { p3WatchdogTick() } catch { /* 忽略 */ }
      // bili 轮询：每 3 tick（180s）扫一次新压缩块（2026-10-19 双轨之二）
      if (++n % 3 === 0) void p3BiliTick(ctx, cfg)
    }, 60000)
    return () => clearInterval(t)
  }, 'dsh-worldtree: p3-busy-watchdog')
  ctx.on('session/event', (session, event) => {
    try {
      const sid = p3SessionKey(session)
      p3LastSid = sid   // bili 轮询需要会话键（持续刷新）
      // 注入池周期边界（2026-10-12 老机制移植）：压缩成功结束 → 置 boundaryPending，
      // 下一拍 pre-step 按「保留前 50% 退池 → 幸存者全部补回」执行周期末三步。
      // 压缩失败（end 带 error）→ 表面没变，不置位。
      if (event && event.type === 'compaction/end') {
        if (!(event.data && event.data.error)) {
          const pool = poolLoad(sid)
          pool.cycle.boundaryPending = true
          poolSaveSync(pool)
          ctx.logger?.info?.(`[dsh-worldtree] 注入池：${sid} 收到压缩结束 → 周期边界置位（下一拍补位）`)
        }
        return
      }
      // v2：只认 compaction/summary——它带 shadowedRange（被压缩区间的闭区间 seq）
      if (!event || event.type !== 'compaction/summary') return
      const d = event.data || {}
      const range = d.shadowedRange
      if (!range || typeof range.start !== 'number' || typeof range.end !== 'number') {
        ctx.logger?.warn?.(`[dsh-worldtree] P3：${sid} summary 缺 shadowedRange，跳过`)
        return
      }
      const hot = p3HotNums()
      let segs = []
      try {
        // 同步快照被压缩区间（闭区间 → toSeqExclusive = end+1）；此后不再碰 session
        const evs = session.snapshotEvents(range.start, range.end + 1)
        segs = p3ExtractHuman(evs)
      } catch (err) {
        ctx.logger?.warn?.(`[dsh-worldtree] P3：${sid} 读取被压缩区间 seq ${range.start}–${range.end} 失败（跳过本批）：` + ((err && err.message) || err))
        return
      }
      if (!segs.length) {
        ctx.logger?.info?.(`[dsh-worldtree] P3：${sid} 压缩区间 seq ${range.start}–${range.end} 无人话内容，跳过`)
        p3Note(sid, range.start + '–' + range.end, 0, 0, '无人话跳过')
        return
      }
      // 跨通道幂等（2026-10-19 bili 双轨）：正文指纹 sha256 两通道共用——
      // bili ref 口径与 DSH seq 口径不可换算，正文 hash 是共同语言
      const biliSt = p3BiliLoad()
      const biliFps = biliSt.fps[sid] || (biliSt.fps[sid] = {})
      const fresh = segs.filter((s) => !biliFps[p3Fp(s)])
      if (fresh.length < segs.length)
        ctx.logger?.info?.(`[dsh-worldtree] P3：${sid} 区间 ${segs.length - fresh.length} 段已被 bili 通道提炼（指纹命中）`)
      segs = fresh
      if (!segs.length) {
        p3Note(sid, range.start + '–' + range.end, 0, 0, 'bili已提炼')
        return
      }
      // 总量上限（可配置 p3TotalChars，默认 24 万字）；截断方向 2026-10-12 反转：保新弃旧
      // （较新的段落对当前状态更有价值；旧段已被上次压缩覆盖过）
      const kept = []
      let total = 0, droppedOld = 0
      for (let i = segs.length - 1; i >= 0; i--) {
        const s = segs[i]
        if (total + s.length > hot.total) { droppedOld = i + 1; break }
        kept.unshift(s)
        total += s.length
      }
      if (droppedOld > 0) {
        ctx.logger?.warn?.(`[dsh-worldtree] P3：${sid} 超出 ${hot.total} 字上限（保新弃旧），${segs.length} 段只入提炼 ${kept.length} 段（截掉较旧 ${droppedOld} 段）`)
      }
      ctx.logger?.info?.(`[dsh-worldtree] P3：${sid} 捕获压缩区间 seq ${range.start}–${range.end}：${kept.length} 段 ${total} 字`)
      if (total < hot.minChars) {
        ctx.logger?.info?.(`[dsh-worldtree] P3：${sid} 区间人话 ${total} 字 < 最小 ${hot.minChars} 字，跳过提炼（正常，非失败）`)
        p3Note(sid, range.start + '–' + range.end, kept.length, total, '字数不足跳过')
        return
      }
      const job = { sid, texts: kept, queuedAt: Date.now(), distilled: null, batch: 0,
                    phase: 'queued', range: range.start + '–' + range.end, segs: kept.length, chars: total }
      for (const s of kept) biliFps[p3Fp(s)] = 1     // DSH 通道入队同样记账（bili 侧对称过滤）
      p3BiliSave()
      p3Note(sid, job.range, kept.length, total, '已捕获')
      p3Jobs.push(job)
      p3Queue.push(job)                              // 工作队列也要进（2026-10-17 修复：drain 只从
                                                     // p3Queue 取件——此前漏推导致新捕获原地排队，
                                                     // 只能等重启续传才处理，实测 8 单积压 5 天）
      p3Save()                                    // 入队即落盘（断点续传锚点⓪）
      p3Drain(ctx, cfg)
    } catch (err) {
      ctx.logger?.warn?.('[dsh-worldtree] P3 采集异常（忽略）：' + ((err && err.message) || err))
    }
  })
}

function p3ParseEntries(raw) {
  // 提炼输出容错解析：max_tokens 截断（输出停在字符串/对象中间）时回收全部完整条目。
  // 背景：贪婪截取 \[[\s\S]*\] 会匹配到 body 内的 ']'（如 [dsh-liubian-memory]），
  // JSON.parse 直接炸 → 整批丢。改为前缀截取 + 字符串感知的边界修复（2026-10-11 管线实测）。
  const m = String(raw || '').match(/\[[\s\S]*/)
  if (!m) return []
  const txt = m[0]
  try {
    const v = JSON.parse(txt)
    return Array.isArray(v) ? v : []
  } catch { /* 截断容错继续 */ }
  let depth = 0, inStr = false, esc = false, lastObjEnd = -1
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) lastObjEnd = i }
  }
  if (lastObjEnd > 0) {
    try {
      const v = JSON.parse(txt.slice(0, lastObjEnd + 1) + ']')
      if (Array.isArray(v)) return v
    } catch { /* 修不好就放弃 */ }
  }
  return []
}

function p3Drain(ctx, cfg) {
  if (p3Busy) return
  const job = p3Queue.shift()
  if (!job) return
  p3Busy = true
  p3BusySince = Date.now()
  void (async () => {
    try {
      let arr = job.distilled
      if (!arr) {
        const llm = p3LLM()
        const hot = p3HotNums()
        // 分片提炼（加固②）：单片 ≤ chunk 字，防 max_tokens 截断丢整批
        const slices = []
        let cur = [], curLen = 0
        for (const seg of job.texts) {
          if (curLen + seg.length > hot.chunk && cur.length) { slices.push(cur); cur = []; curLen = 0 }
          cur.push(seg); curLen += seg.length
        }
        if (cur.length) slices.push(cur)
        job.phase = 'distill'
        job.slicesTotal = slices.length
        job.slicesDone = 0
        ctx.logger?.info?.(`[dsh-worldtree] P3：${job.sid} 开始提炼（${slices.length} 片，输出上限 ${hot.maxTokens} tok）`)
        const callLLM = async (sl) => {
          const res = await fetch(llm.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + llm.key },
            body: JSON.stringify({ model: llm.model, temperature: 0.2, max_tokens: hot.maxTokens, messages: [
              { role: 'system', content: '你是记忆压缩器。把输入的对话上下文提炼为可长期保留的记忆条目。' },
              { role: 'user', content:
                '下面是一段刚被上下文压缩丢弃的对话内容。请把其中**所有值得长期保留的知识**分别提炼成独立的记忆条目（长期记忆提炼纪律）：\n'
                + '- 每条 body 按**三段式**组织：\n'
                + '  **结论**——一句话说清"什么是对的"（含可搜索关键词）；\n'
                + '  **机制**——它为什么成立/怎么运作（保留全部关键数字、阈值、错误串、文件路径、决策与理由，日后要用它们验证）；\n'
                + '  **终态**——现状如何；方案被推翻或修正必须显式标注终态与防回归措施\n'
                + '- **自洽检查**：结论与机制必须互相支撑——反向故障（结论说 A、机制推出 B）比过时更危险\n'
                + '- **篇数不限**：有几条值得留的就出几条；一次性的操作过程、寒暄、中间试错不要\n'
                + '- 严格 JSON 数组输出：[{"head":"一句话简介（含可搜索词）","body":"结论/机制/终态 三段正文"}]\n\n【上下文】\n'
                + sl.join('\n\n') },
            ] }),
            signal: AbortSignal.timeout(300000),
          })
          const j = await res.json()
          const fin = j.choices && j.choices[0] && j.choices[0].finish_reason
          const raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ''
          return { part: p3ParseEntries(raw), fin }
        }
        // 单片提炼（2026-10-12 增补两道保险）：① 整片零回收时对半降片重试一次；
        // ② 每片硬超时 240s——AbortSignal 对已建立的僵死连接可能不生效
        //（2026-10-12 实证：一次网络僵死让整条管线挂 4 小时），超时按失败跳过
        const distillSlice = async (sl, depth) => {
          try {
            const work = callLLM(sl)
            const t = new Promise((r) => setTimeout(() => r({ part: [], fin: 'hard-timeout' }), 240000))
            const { part, fin } = await Promise.race([work, t])
            if (fin === 'length' && part.length === 0 && depth < 1 && sl.length > 1) {
              ctx.logger?.warn?.(`[dsh-worldtree] P3：${job.sid} 片输出截断且零回收，对半降片重试（${sl.length} 段 → ${Math.ceil(sl.length / 2)}+${sl.length - Math.ceil(sl.length / 2)}）`)
              const half = Math.ceil(sl.length / 2)
              const ra = await distillSlice(sl.slice(0, half), depth + 1)
              const rb = await distillSlice(sl.slice(half), depth + 1)
              return ra.concat(rb)
            }
            if (fin === 'length') {
              ctx.logger?.warn?.(`[dsh-worldtree] P3：${job.sid} 片输出被 max_tokens 截断，容错回收 ${part.length} 条（残尾已弃）`)
            }
            return part
          } catch (err) {
            // 单片失败只跳过该片——不杀整批（其余片的内容照常上树）
            ctx.logger?.warn?.('[dsh-worldtree] P3：单片提炼失败（跳过该片，其余继续）：' + ((err && err.message) || err))
            return []
          }
        }
        arr = []
        for (const sl of slices) {
          const part = await distillSlice(sl, 0)
          arr.push(...part)
          job.slicesDone = (job.slicesDone || 0) + 1
        }
        if (!arr.length) {
          ctx.logger?.info?.('[dsh-worldtree] P3：本批无可提炼条目')
          p3Note(job.sid, job.range || '', job.segs || 0, job.chars || 0, '无可提炼条目')
          p3Remove(job)                       // 无价值 = 完成，出档
          return
        }
        job.distilled = arr
        job.batch = ++p3Batch
        p3Save()                              // 断点续传锚点①：提炼完成即落盘（texts 随之丢弃）
      }
      job.phase = 'insert'
      job.insertTotal = job.distilled.length
      job.insertDone = 0
      const sources = []
      for (let i = 0; i < job.distilled.length; i++) {
        const head = String(job.distilled[i].head || '').trim()
        const text = head + '\n' + String(job.distilled[i].body || '').trim()
        if (!text.trim()) continue
        const source = job.sid + '/C' + job.batch + '-' + (i + 1)
        // 断点续传锚点②：exists 查重——中断恢复后已上树的条目不重复插
        const ex = await callCore(cfg, { op: 'exists', source })
        if (ex && ex.ok && ex.data && ex.data.exists) { sources.push(source); job.insertDone = (job.insertDone || 0) + 1; continue }
        const r = await callCore(cfg, { op: 'insert', source, ws: 'compaction', text: text.slice(0, 8000) })
        if (r.ok) sources.push(source)
        job.insertDone = (job.insertDone || 0) + 1
      }
      if (sources.length) {
        await callCore(cfg, { op: 'record_upload', session: job.sid, count: sources.length,
                              sources, note: '压缩批次 #' + job.batch + '（区间直读）' })
        ctx.logger?.info?.(`[dsh-worldtree] P3 上行：${job.sid} 批次#${job.batch} 提炼 ${job.distilled.length} 条 → 上树 ${sources.length} 条`)
      } else {
        ctx.logger?.warn?.(`[dsh-worldtree] P3：${job.sid} 提炼出 ${job.distilled.length} 条但全部上树失败（查 callCore/树库）`)
      }
      p3Note(job.sid, job.range || '', job.segs || 0, job.chars || 0,
             '完成：提炼 ' + job.distilled.length + ' 条 → 上树 ' + sources.length + ' 条')
      p3Remove(job)                           // 完成（含全部已存在的续传情形）→ 出档
    } catch (err) {
      // 断点续传语义（2026-10-11）：失败不丢任务——留在 p3_pending.json，
      // 下次 DSH 启动自动续传；本轮不再热重试（防 LLM 故障时打转）
      ctx.logger?.warn?.('[dsh-worldtree] P3 失败（任务已缓存，下次 DSH 启动自动续传）：' + ((err && err.message) || err))
    } finally {
      p3Busy = false
      p3BusySince = 0
      if (p3Queue.length) p3Drain(ctx, cfg)
    }
  })()
}

/* ── 检查点调度器（2026-10-11 管理员指令）：五档稀释检查点此前只有 CLI 无人跑。
 * core/checkpoint.py 的无参 snapshot 自带档位判断（1m/7d 全量、24h/6h/1h 增量，
 * 以 7d 基线为参照），调度器只负责周期触发 + 启动补课（30s 后首跑，错过周期立即补）。 */
function ckptMount(ctx, cfg) {
  if (cfg.ckptEnabled === false) return
  if (!cfg.ckptPy || !existsSync(cfg.ckptPy)) {
    ctx.logger?.warn?.(`[dsh-worldtree] 检查点脚本不存在：${cfg.ckptPy}（调度器未挂载）`)
    return
  }
  let timer = null
  let busy = false
  const tick = async (why) => {
    if (busy) return
    busy = true
    try {
      const out = await new Promise((resolve) => {
        const child = execFile(cfg.pyExe, [cfg.ckptPy, 'snapshot'], { timeout: 120000, encoding: 'utf8' },
          (err, so) => resolve({ err, so: so || '' }))
        if (child.stdin) child.stdin.end()    // §3.4.0 症状 B：显式关 stdin
      })
      const done = String(out.so).split('\n').filter((l) => l.includes('✓')).map((l) => l.trim())
      if (done.length) ctx.logger?.info?.(`[dsh-worldtree] 检查点[${why}]：${done.join('｜')}`)
      if (out.err && !done.length) ctx.logger?.warn?.('[dsh-worldtree] 检查点失败（下轮再试）：' + ((out.err && out.err.message) || out.err))
    } catch (err) {
      ctx.logger?.warn?.('[dsh-worldtree] 检查点异常（忽略）：' + ((err && err.message) || err))
    } finally {
      busy = false
    }
  }
  const interval = Number(cfg.ckptIntervalMs) || 600000
  const loop = async () => { await tick('定时'); timer = setTimeout(loop, interval) }
  timer = setTimeout(() => { void tick('启动补课'); timer = setTimeout(loop, interval) }, 30000)
  ctx.effect(() => () => { if (timer) clearTimeout(timer) }, 'dsh-worldtree: 检查点调度器')
}

export function apply(ctx, input = {}) {
  const cfg = resolveConfig(input)
  if (!existsSync(cfg.corePy)) {
    ctx.logger?.warn?.(`[dsh-worldtree] 树核不存在：${cfg.corePy}（工具将返回错误）`)
  }
  if (!existsSync(cfg.dbPath)) {
    ctx.logger?.warn?.(`[dsh-worldtree] 树库不存在：${cfg.dbPath}（先跑 core/migrate_p2.py 移植）`)
  }
  wikiMountPanelRoutes(ctx, cfg)
  // 内置向量化服务（2026-10-10 自 dsh-liubian-memory 迁入：Q4_K_M @ 8082）
  const ecfg = embedResolveConfig()
  embedLogger = ctx.logger
  embedRegisterTool(ctx, ecfg)
  embedEnsureInFlow(ecfg, ctx.logger)
  embedMountWatchdog(ctx, ecfg)
  injectMount(ctx, { ...cfg, ...ecfg })
  p3Mount(ctx, cfg)
  ckptMount(ctx, cfg)

  registerWorldtreeTool(ctx, cfg)
  ctx.logger?.info?.(
    `[dsh-worldtree] v${PLUGIN_VERSION} 世界树插件已挂载：${cfg.dbPath}｜编码 ${cfg.embedUrl}（内置 Q4_K_M）｜检查点调度 ${cfg.ckptEnabled !== false ? '开' : '关'}｜P3 断点续传 开`,
  )
}

export const __test = { resolveConfig, configFile, DEFAULTS, injectMount, injectHumanText, p3ExtractHuman, p3ParseEntries, injectBuildBlock, p3File, p3Load, p3Save, p3Fp, p3BiliFile, p3BiliLoad, p3BiliSave, p3BiliTick,
  setBiliSid: (s) => { p3LastSid = String(s || '') } }
