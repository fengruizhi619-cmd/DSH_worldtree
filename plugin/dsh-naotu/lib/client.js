// 脑图（naotu）面板 —— v1.1.0 脑图隐喻 UI：
//  - 脑图（默认）：脑区地形图（力导向，区=吸引盆）+ 顶部常驻检索 + 命中区高亮
//                 + 检索结果列（S/K/B 三条细条）+ 区详情 + 元事件正文详情
//  - 睡眠：入库即组织（元记忆/脑区统计 + 最近入睡流）
//  - 入库：P3 自动管线（压缩→提炼→入库）+ 手动入库 + 提交台账
//  - 设置：元数据驱动渲染（后端新增参数自动出现）
//  - 数据：插件宿主路由 /api/liubian-wiki（纯读），树核写操作走 helper 子进程
window.__ModuleLoader__.load({
  id: 'dsh-naotu',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var PANEL_ID = 'liubianwiki'
    var PANEL_LABEL = '脑图'
    var API = '/api/liubian-wiki'
    var DIARY_FAMILY = '日记'   // 旧日记归档族根 slug（scopeParams 用）

    var CSS = [
      /* ══ 原生风格重写（2026-10-18）：全部配方提取自宿主前端
       * @deepseek-ai/dsh-web-frontend/dist/assets/index-*.css 的真实模块规则
       * （按钮 1rv3m / 开关 1ik0f / 分段控件 d62eq / 设置表单 bjqpo /
       *   pill 1bqmh / 对话框 o6lrb / 页面根 1alm6）。
       * 纪律：只用宿主 --dsw-alias-* 令牌（圆角/阴影/焦点环带兜底值）；
       * 字号只允许 11/12/13/14；状态=色变不加胶囊底；表面=layer-1 输入=layer-3。 */

      /* ── 面板骨架：实色底，无毛玻璃（原生页面根 = bg-base，不用 backdrop-blur）── */
      '.lbm-panel{display:flex;flex-direction:column;min-width:0;height:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;overflow:hidden;position:relative}',
      '.lbm-panel,.lbm-panel *{box-sizing:border-box}',
      '.lbm-panel button:focus-visible,.lbm-panel input:focus-visible,.lbm-panel textarea:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',

      /* ── 顶栏：标题 + 分段页 + 统计（对话框标题口径 16/24·500）── */
      '.lbm-header{border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;min-height:52px;padding:0 16px;display:flex;align-items:center;gap:12px}',
      '.lbm-brand{display:inline-flex;align-items:center;gap:8px;font-size:14px;font-weight:600;line-height:20px;white-space:nowrap}',
      '.lbm-brandDot{width:6px;height:6px;border-radius:var(--dsw-radius-xs,2px);background:var(--dsw-alias-brand-primary);flex:none}',
      '.lbm-crumb{font-size:13px;font-weight:600;line-height:20px;white-space:nowrap}',
      '.lbm-sep{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}',
      '.lbm-sub{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;white-space:nowrap}',
      '.lbm-spacer{flex:1}',
      '.lbm-stat{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap}',

      /* ── 按钮：ghost/outline/primary 三态（1rv3m 配方）── */
      '.lbm-btn{background:transparent;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,8px);cursor:pointer;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;height:28px;padding:0 12px;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;transition:background .12s ease}',
      '.lbm-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.lbm-btnGhost{background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.lbm-btn:active{background:var(--dsw-alias-interactive-bg-active)}',
      '.lbm-btn:disabled{opacity:.4;cursor:not-allowed}',
      '.lbm-btnPrimary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-button-primary-foreground);height:32px;padding:0 14px;font-size:13px}',
      '.lbm-btnPrimary:hover{background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-button-primary-foreground)}',
      '.lbm-btnPrimary:disabled{opacity:.4;cursor:not-allowed}',

      /* ── 视图分段页（d62eq 配方：容器 interactive-bg-hover，选中=layer-1+软阴影）── */
      '.lbm-tabs{display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:4px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-interactive-bg-hover);flex:none}',
      '.lbm-tab{position:relative;background:transparent;border:none;cursor:pointer;font:inherit;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-secondary);padding:0 16px;height:28px;border-radius:var(--dsw-radius-sm,6px);white-space:nowrap;transition:color .12s ease}',
      '.lbm-tab:hover{color:var(--dsw-alias-label-primary)}',
      '.lbm-tab.is-on{background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft,0 1px 2px rgba(0,0,0,.08));color:var(--dsw-alias-label-primary)}',

      /* ── 工具条：搜索 + 模式 + 状态 ── */
      '.lbm-tools{flex:none;border-bottom:.5px solid var(--dsw-alias-border-l3);padding:10px 16px;display:flex;flex-direction:column;gap:8px}',
      '.lbm-searchRow{display:flex;align-items:center;gap:10px}',

      /* ── 输入框（bjqpo._input 配方：.5px l4 边 + layer-3 底 + 34 高）── */
      '.lbm-input{flex:1;width:100%;min-width:0;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;outline:none;transition:border-color .12s ease}',
      '.lbm-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.lbm-input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.lbm-textarea{height:auto;min-height:150px;padding:10px 12px;font-family:var(--ds-font-family-code,monospace);font-size:12px;line-height:19px;resize:vertical}',

      /* ── 上传投放区（虚线框保留=功能性暗示；配色走令牌）── */
      '.lbm-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;border:1.5px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,12px);padding:20px 14px;cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;transition:border-color .12s ease,background .12s ease;text-align:center;width:100%}',
      '.lbm-drop:hover{border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.lbm-drop.is-over{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.lbm-dropIcon{font-size:20px;line-height:24px}',
      '.lbm-dropFile{color:var(--dsw-alias-state-business-primary);font-size:12px;font-weight:600;font-family:var(--ds-font-family-code,monospace);word-break:break-all}',

      /* ── 模式分段（同 d62eq；紧凑 28 高）── */
      '.lbm-seg{display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:4px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-interactive-bg-hover);flex:none}',
      '.lbm-segBtn{background:transparent;border:none;cursor:pointer;font:inherit;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-secondary);padding:0 12px;height:28px;border-radius:var(--dsw-radius-sm,6px);white-space:nowrap;transition:color .12s ease}',
      '.lbm-segBtn:hover{color:var(--dsw-alias-label-primary)}',
      '.lbm-segBtn.is-on{background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft,0 1px 2px rgba(0,0,0,.08));color:var(--dsw-alias-label-primary)}',

      /* ── 状态/范围筛选（1bqmh pill 配方：24 高 · layer-2 底 · 选中=ghost 激活环）── */
      '.lbm-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.lbm-chipLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.lbm-chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:none;border-radius:999px;cursor:pointer;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);white-space:nowrap;transition:background .12s ease,color .12s ease}',
      '.lbm-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.lbm-chip.is-on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-ghost-active-fill);box-shadow:inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border)}',

      /* ── 标签筛选盒（页面内浮层 = layer-1 + lg 圆角 + 发丝边）── */
      '.lbm-tagBox{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1);padding:8px 12px 10px}',
      '.lbm-tagHead{display:flex;align-items:center;gap:8px;padding:0 0 6px}',
      '.lbm-tagHeadTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.lbm-tagSel{font-size:11px;color:var(--dsw-alias-state-business-primary);white-space:nowrap}',
      '.lbm-btnSm{height:24px;padding:0 8px;font-size:12px;border-radius:var(--dsw-radius-sm,6px)}',
      '.lbm-tagCloud{display:flex;flex-wrap:wrap;gap:4px 5px;align-items:center;max-height:112px;overflow:hidden;transition:max-height .25s ease}',
      '.lbm-tagCloud.is-full{max-height:none}',
      '.lbm-chipCount{margin-left:2px;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}',
      '.lbm-chipCount.is-on{color:var(--dsw-alias-label-primary)}',

      /* ── 两栏 ── */
      '.lbm-body{min-height:0;flex:auto;display:flex;overflow:hidden}',
      '.lbm-left{width:min(430px,42%);min-width:260px;flex:none;display:flex;flex-direction:column;min-height:0}',
      '.lbm-right{flex:auto;min-width:0;display:flex;flex-direction:column;min-height:0}',
      '.lbm-scroll{min-height:0;flex:auto;overflow-y:auto;scrollbar-gutter:stable}',
      '.lbm-paneHead{flex:none;padding:10px 14px 6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;display:flex;align-items:center;gap:8px}',

      /* ── 树（侧栏列表口径：26 高行 · radius-sm · hover/选中走交互底色）── */
      '.lbm-node{display:flex;align-items:center;gap:4px;width:100%;background:transparent;border:none;cursor:pointer;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-align:left;padding:3px 8px 3px 0;border-radius:var(--dsw-radius-sm,6px)}',
      '.lbm-node:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.lbm-node.is-sel{background:var(--dsw-alias-interactive-bg-active);font-weight:500}',
      '.lbm-twist{width:16px;flex:none;display:inline-flex;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.lbm-nodeTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.lbm-dot{width:7px;height:7px;border-radius:999px;flex:none}',
      '.lbm-revs{color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums;flex:none}',

      /* ── 检索结果（列表行 + 发丝分隔；选中=交互底色）── */
      '.lbm-hit{display:block;width:100%;background:transparent;border:none;border-bottom:.5px solid var(--dsw-alias-border-l2);cursor:pointer;font:inherit;text-align:left;color:var(--dsw-alias-label-primary);padding:10px 14px;transition:background .12s ease}',
      '.lbm-hit:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.lbm-hit.is-sel{background:var(--dsw-alias-interactive-bg-active)}',
      '.lbm-hitTop{display:flex;align-items:center;gap:6px}',
      '.lbm-hit.is-sel .lbm-hitTitle{font-weight:600}',
      '.lbm-hitTitle{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.lbm-score{font-size:11px;line-height:17px;color:var(--dsw-alias-state-business-primary);font-variant-numeric:tabular-nums;flex:none}',
      '.lbm-hitPath{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}',
      '.lbm-hitSnip{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.lbm-tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;font-size:11px;line-height:16px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}',

      /* ── 详情（文章式排版；标题=原生 16/24·500，分区题=小节灰题）── */
      '.lbm-detail{padding:20px clamp(20px,3vw,40px) 44px;max-width:920px;margin:0 auto;width:100%}',
      '.lbm-dTitle{font-size:16px;font-weight:600;line-height:24px;margin:0 0 6px}',
      '.lbm-dMeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.lbm-dIntro{margin-top:14px;padding:11px 14px;border-radius:var(--dsw-radius-md,8px);border-left:3px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;word-break:break-word}',
      '.lbm-dSecTitle{margin:22px 0 8px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary);line-height:18px}',
      '.lbm-content{word-break:break-word;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}',
      '.lbm-childBtn{display:flex;align-items:center;gap:6px;width:100%;background:transparent;border:none;cursor:pointer;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-state-business-primary);text-align:left;padding:4px 8px;border-radius:var(--dsw-radius-sm,6px)}',
      '.lbm-childBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.lbm-revRow{display:flex;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}',
      '.lbm-revRow b{color:var(--dsw-alias-label-secondary);font-weight:500;flex:none}',
      '.lbm-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.lbm-err{margin:14px;padding:0 12px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:19px;word-break:break-word}',
      '.lbm-warn{margin:0 0 10px;padding:8px 12px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-warning-primary);font-size:12px;line-height:18px}',
      '.lbm-empty{padding:32px 18px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}',

      /* ── 分区卡（页面内模块 = layer-1 + lg 圆角 + 发丝边，无重边框阴影）── */
      '.lbm-card{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,12px);padding:14px 18px 16px;margin:0 0 14px}',
      '.lbm-cardTitle{font-size:13px;font-weight:600;line-height:20px;margin:0 0 2px;display:flex;align-items:center}',
      '.lbm-cardDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0 0 8px}',

      /* ── 设置字段（bjqpo._field 配方：label 左自适应 + 控件右，hint 整行在下，
       *    相邻字段发丝分隔线；label 13/500=原生设置口径）── */
      '.lbm-fld{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"label ctrl" "hint hint";align-items:center;column-gap:16px;padding:10px 0;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.lbm-fldRow>.lbm-fld:first-child{border-top:none}',
      '.lbm-fld>.lbm-fldLabel{grid-area:label}',
      '.lbm-fld>div{grid-area:ctrl}',
      '.lbm-fld>.lbm-fldHint{grid-area:hint}',
      '.lbm-fldLabel{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);line-height:20px}',
      '.lbm-fldHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',

      /* ── 开关（1ik0f 原生配方：36×20 · OFF=border-l3 · ON=brand-primary ·
       *    滑块 OFF=switch-thumb ON=label-primary-foreground · .12s）── */
      '.lbm-tgl{position:relative;width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer;border:none;transition:background .12s ease;flex:none;padding:0}',
      '.lbm-tgl::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:var(--dsw-alias-switch-thumb,#fff);transition:transform .12s ease,background .12s ease}',
      '.lbm-tgl.is-on{background:var(--dsw-alias-brand-primary)}',
      '.lbm-tgl.is-on::after{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground,#fff)}',

      /* ── 作业卡 ── */
      '.lbm-job{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,12px);padding:12px 16px 14px;margin-bottom:10px}',
      '.lbm-jobTop{display:flex;align-items:center;gap:10px;margin-bottom:4px}',
      '.lbm-jobSid{font-family:var(--ds-font-family-code,monospace);font-size:12px;font-weight:600;letter-spacing:.02em}',
      '.lbm-jobMeta{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.lbm-pill{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;font-size:11px;line-height:16px;font-weight:500;flex:none;white-space:nowrap}',
      '.lbm-pillQ{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
      '.lbm-pillD{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-state-business-primary)}',
      '.lbm-pillI{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary) 14%,transparent);color:var(--dsw-alias-state-warning-primary)}',

      /* ── 步骤条 ── */
      '.lbm-steps{display:flex;align-items:center;margin:6px 0 2px}',
      '.lbm-step{display:inline-flex;align-items:center;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);flex:none}',
      '.lbm-stepDot{width:17px;height:17px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l4);display:inline-flex;align-items:center;justify-content:center;font-size:11px;flex:none}',
      '.lbm-step.is-done{color:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.lbm-step.is-done .lbm-stepDot{border-color:var(--dsw-alias-state-success-primary,#16a34a);background:var(--dsw-alias-state-success-primary,#16a34a);color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.lbm-step.is-act{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.lbm-step.is-act .lbm-stepDot{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.lbm-stepLine{flex:1;height:.5px;background:var(--dsw-alias-border-l3);margin:0 8px;min-width:14px}',
      '.lbm-stepLine.is-done{background:var(--dsw-alias-state-success-primary,#16a34a)}',

      /* ── 进度条 ── */
      '.lbm-bar{flex:1;height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);overflow:hidden;min-width:50px}',
      '.lbm-barFill{height:100%;border-radius:999px;background:var(--dsw-alias-state-business-primary);transition:width .5s ease}',
      '.lbm-barFill.is-done{background:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.lbm-pct{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;min-width:64px;text-align:right;flex:none}',

      /* ── 台账表（发丝分隔；表头=灰题不加字距）── */
      '.lbm-ledger{width:100%;border-collapse:collapse;font-size:12px}',
      '.lbm-ledger th{text-align:left;font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3)}',
      '.lbm-ledger td{padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2);font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}',
      '.lbm-ledger tr:hover td{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',

      /* ── 上传日志 ── */
      '.lbm-upLog{font-family:var(--ds-font-family-code,monospace);font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);max-height:220px;overflow-y:auto;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,8px);padding:8px 12px;margin-top:10px;word-break:break-all;overflow-wrap:anywhere}',
      '.lbm-upLog b{color:var(--dsw-alias-state-success-primary,#16a34a);font-weight:600}',
      '.lbm-upLog i{color:var(--dsw-alias-state-error-primary);font-style:normal}',

      /* ── Markdown 渲染（正文 13px；标题 600；令牌口径不变）── */
      '.lbm-md{font-size:13px;line-height:21px;word-break:break-word;overflow-wrap:anywhere}',
      '.lbm-md p{margin:0 0 8px}',
      '.lbm-md h1,.lbm-md h2,.lbm-md h3,.lbm-md h4{margin:14px 0 6px;line-height:1.4;font-weight:600}',
      '.lbm-md h1{font-size:16px}.lbm-md h2{font-size:14px}.lbm-md h3{font-size:13px}.lbm-md h4{font-size:13px}',
      '.lbm-md-h{font-weight:600;line-height:1.4}',
      '.lbm-md-h1{font-size:16px;margin:14px 0 6px}',
      '.lbm-md-h2{font-size:14px;margin:14px 0 6px}',
      '.lbm-md-h3,.lbm-md-h4{font-size:13px;margin:12px 0 5px}',
      '.lbm-md ul,.lbm-md ol{margin:6px 0;padding-left:20px}',
      '.lbm-md li{margin:2px 0}',
      '.lbm-md code{font-family:var(--ds-font-family-code,monospace);font-size:12px;background:var(--dsw-alias-markdown-inline-code,var(--dsw-alias-bg-layer-2));border-radius:var(--dsw-radius-xs,4px);padding:1px 5px}',
      '.lbm-md pre{margin:8px 0;padding:10px 12px;background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-2));border-radius:var(--dsw-radius-md,8px);overflow-x:auto}',
      '.lbm-md pre code{background:transparent;padding:0;font-size:12px;line-height:19px}',
      '.lbm-md blockquote{margin:8px 0;padding:2px 0 2px 12px;border-left:3px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}',
      '.lbm-md hr{border:0;border-top:.5px solid var(--dsw-alias-border-l3);margin:12px 0}',
      '.lbm-md a{color:var(--dsw-alias-state-business-primary);text-decoration:none}',
      '.lbm-md a:hover{text-decoration:underline}',
      '.lbm-md table{border-collapse:collapse;font-size:12px;width:100%}',
      '.lbm-md th,.lbm-md td{border:.5px solid var(--dsw-alias-border-l3);padding:4px 8px;vertical-align:top}',
      '.lbm-md th{background:var(--dsw-alias-bg-layer-2);font-weight:500}',
      '.lbm-md-wrap{overflow-x:auto;margin:8px 0}',

      /* ── 日记枝 ── */
      '.lbm-secHead{display:flex;align-items:center;gap:6px;width:100%;background:transparent;border:none;border-top:.5px solid var(--dsw-alias-border-l3);cursor:pointer;font:inherit;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);text-align:left;padding:7px 10px;margin-top:8px}',
      '.lbm-secHead:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.lbm-diaryRow{display:flex;align-items:center;gap:6px;width:100%;background:transparent;border:none;cursor:pointer;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);text-align:left;padding:3px 8px;border-radius:var(--dsw-radius-sm,6px)}',
      '.lbm-diaryRow:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.lbm-diaryRow.is-sel{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:500}',
      '.lbm-diaryId{color:var(--dsw-alias-state-business-primary);font-family:var(--ds-font-family-code,monospace);font-size:11px;flex:none}',
      '.lbm-diaryDate{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none;font-variant-numeric:tabular-nums}',
      '.lbm-more{margin:2px 0 10px 10px;background:transparent;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,6px);cursor:pointer;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);height:24px;padding:0 8px}',
      '.lbm-more:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.lbm-chipBtn{display:inline-flex;align-items:center;gap:4px;height:24px;background:transparent;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;cursor:pointer;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-state-business-primary);padding:0 10px;margin:0 6px 6px 0;white-space:nowrap}',
      '.lbm-chipBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.lbm-chooseWrap{padding:14px 16px}',
      '.lbm-chooseTitle{font-size:13px;font-weight:500;margin:0 0 8px}',
      '.lbm-chooseBtn{display:block;width:100%;text-align:left;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,8px);cursor:pointer;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);padding:7px 10px;margin-bottom:6px}',
      '.lbm-chooseBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    ]
    /* ══ 脑图 · 样式（v1.1.4 按 _oil-ui 真截图迭代：左导航横排 / 画布圆填充 / 右栏综合分）
       设计原则：① 内容区一律实底，不叠壁纸 ② 层次靠 bg-base/layer-1/layer-2 + 1px 分界线
       ③ 字号 13/12/11 ④ 品牌紫只用于选中态/命中区/进度条 ⑤ 圆角走 --dsw-radius-*
       ⑥ 全部颜色 var(--dsw-alias-*, 回退) —— 深浅主题自动跟随宿主 */
    var NAO_CSS = [
      '.nao-app{display:flex;flex:1 1 auto;height:100%;min-height:0;width:100%;box-sizing:border-box;overflow:hidden;background:var(--dsw-alias-bg-base,#f7f7f8);color:var(--dsw-alias-label-primary,#1b1b1f);font-size:13px;line-height:1.5}',
      /* 左导航（DSH 侧栏形态：图标 + 文字横排，行高 32） */
      '.nao-nav{width:148px;flex:0 0 148px;border-right:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));background:var(--dsw-alias-bg-base,#f7f7f8);padding:8px 6px;display:flex;flex-direction:column;gap:2px;box-sizing:border-box}',
      '.nao-navTitle{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary,#8a8a94);letter-spacing:.06em;padding:6px 8px 4px}',
      '.nao-navBtn{display:flex;align-items:center;gap:8px;height:32px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#5c5c66);font:inherit;font-size:13px;cursor:pointer;text-align:left}',
      '.nao-navBtn svg{flex:0 0 16px;opacity:.75}',
      '.nao-navBtn:hover{background:var(--dsw-alias-bg-layer-2,#f2f2f4);color:var(--dsw-alias-label-primary,#1b1b1f)}',
      '.nao-navBtn.is-on{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1b1b1f);font-weight:600;box-shadow:0 0 0 1px var(--dsw-alias-border-l1,rgba(0,0,0,.08))}',
      '.nao-navBtn.is-on svg{opacity:1;color:var(--dsw-alias-brand-primary,#4f6ef7)}',
      /* 主区 */
      '.nao-main{flex:1;min-width:0;display:flex;flex-direction:column}',
      '.nao-top{display:flex;align-items:center;gap:10px;height:46px;padding:0 14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));background:var(--dsw-alias-bg-base,#f7f7f8);box-sizing:border-box}',
      '.nao-title{margin:0;font-size:14px;font-weight:600;letter-spacing:.01em}',
      '.nao-count{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a94);font-variant-numeric:tabular-nums}',
      '.nao-spacer{flex:1}',
      '.nao-btn{height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#5c5c66);font:inherit;font-size:12px;cursor:pointer}',
      '.nao-btn:hover{color:var(--dsw-alias-label-primary,#1b1b1f);border-color:var(--dsw-alias-label-tertiary,#8a8a94)}',
      '.nao-btn.primary{background:var(--dsw-alias-brand-primary,#4f6ef7);border-color:var(--dsw-alias-brand-primary,#4f6ef7);color:#fff}',
      '.nao-btn.primary:hover{filter:brightness(1.06)}',
      '.nao-btn:disabled{opacity:.55;cursor:default}',
      /* 两列 */
      '.nao-body{flex:1;min-height:0;display:flex}',
      '.nao-left{flex:1;min-width:0;display:flex;flex-direction:column;padding:12px 12px 0;box-sizing:border-box}',
      '.nao-right{width:300px;flex:0 0 300px;border-left:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-base,#f7f7f8);box-sizing:border-box}',
      /* 工具条 */
      '.nao-tool{display:flex;gap:8px;align-items:center;margin-bottom:10px}',
      '.nao-input{flex:1;height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1,#fff);font:inherit;font-size:13px;color:var(--dsw-alias-label-primary,#1b1b1f);outline:none;box-sizing:border-box}',
      '.nao-input:focus{border-color:var(--dsw-alias-brand-primary,#4f6ef7);box-shadow:0 0 0 3px rgba(79,110,247,.12)}',
      '.nao-input::placeholder{color:var(--dsw-alias-label-tertiary,#8a8a94)}',
      /* 画布卡 */
      '.nao-stage{position:relative;flex:1;min-height:0;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden}',
      '.nao-map{display:block;width:100%;height:100%}',
      '.nao-tip{position:absolute;z-index:3;max-width:260px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#5c5c66);font-size:11px;line-height:1.45;box-shadow:0 4px 14px rgba(0,0,0,.08);pointer-events:none}',
      '.nao-legend{position:absolute;left:12px;bottom:10px;display:flex;gap:12px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a94);pointer-events:none}',
      '.nao-legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:-1px}',
      /* 右列 */
      '.nao-sideHead{display:flex;align-items:center;gap:8px;height:40px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#5c5c66);box-sizing:border-box}',
      '.nao-sideScroll{flex:1;overflow:auto;padding:6px}',
      '.nao-hit{display:block;width:100%;text-align:left;border:0;background:transparent;border-radius:var(--dsw-radius-md,8px);padding:8px 9px;cursor:pointer;font:inherit;box-sizing:border-box}',
      '.nao-hit:hover{background:var(--dsw-alias-bg-layer-2,#f2f2f4)}',
      '.nao-hit.is-on{background:rgba(79,110,247,.10)}',
      '.nao-hitT{font-size:13px;line-height:1.45;color:var(--dsw-alias-label-primary,#1b1b1f);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.nao-hitM{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a94);font-variant-numeric:tabular-nums}',
      '.nao-bar{flex:1;height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-3,#e9e9ee);overflow:hidden}',
      '.nao-bar i{display:block;height:100%;background:var(--dsw-alias-brand-primary,#4f6ef7);border-radius:2px}',
      '.nao-sku{display:flex;gap:8px;color:var(--dsw-alias-label-secondary,#5c5c66)}',
      '.nao-sku b{font-weight:600;color:var(--dsw-alias-label-primary,#1b1b1f)}',
      '.nao-tag{display:inline-flex;align-items:center;height:18px;line-height:18px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,#f2f2f4);color:var(--dsw-alias-label-tertiary,#8a8a94);font-size:11px;white-space:nowrap}',
      /* 详情 */
      '.nao-detail{flex:1;min-height:0;display:flex;flex-direction:column}',
      '.nao-detailBody{flex:1;overflow:auto;padding:12px 14px;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary,#5c5c66)}',
      '.nao-rep{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#1b1b1f);padding:10px 12px;margin:10px 12px 4px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}',
      '.nao-evRow{display:block;width:calc(100% - 24px);margin:0 12px 6px;text-align:left;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;padding:7px 8px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary,#5c5c66);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.nao-evRow:hover{background:var(--dsw-alias-bg-layer-2,#f2f2f4);color:var(--dsw-alias-label-primary,#1b1b1f)}',
      '.nao-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;height:100%;color:var(--dsw-alias-label-tertiary,#8a8a94);font-size:12px}',
      /* 睡眠视图 */
      '.nao-sleep{flex:1;min-height:0;overflow:auto;padding:14px;box-sizing:border-box}',
      '.nao-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}',
      '.nao-stat{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,#fff);padding:12px 14px}',
      '.nao-statV{display:block;font-size:22px;font-weight:600;letter-spacing:-.01em;color:var(--dsw-alias-label-primary,#1b1b1f);font-variant-numeric:tabular-nums}',
      '.nao-statL{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a94)}',
      '.nao-table{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:var(--dsw-radius-lg,12px);overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff)}',
      '.nao-srow{display:flex;gap:12px;align-items:flex-start;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));font-size:13px}',
      '.nao-srow:first-child{border-top:0}',
      '.nao-stime{flex:0 0 74px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a94);padding-top:2px;font-variant-numeric:tabular-nums}',
      '.nao-smain{flex:1;min-width:0}',
      '.nao-shead{color:var(--dsw-alias-label-primary,#1b1b1f);line-height:1.45;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.nao-smeta{display:flex;gap:6px;margin-top:5px;flex-wrap:wrap}',
      '.nao-dim{color:var(--dsw-alias-label-tertiary,#8a8a94)}',
      '.nao-pad{padding:10px 12px}',
      '.nao-err{margin:8px 12px;padding:8px 10px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2,#f2f2f4);color:var(--dsw-alias-label-secondary,#5c5c66);font-size:12px;line-height:1.5}',
    ];

    /** 检索「范围」→ 服务端过滤参数（纯函数，便于桩测：这是"排除在哪一层生效"的唯一定义处） */
    function scopeParams(scope) {
      if (scope === 'diary') return { familyPrefix: DIARY_FAMILY }
      if (scope === 'wiki') return { excludeFamilyPrefix: DIARY_FAMILY }
      return {}
    }

    /* ── 小工具 ───────────────────────────────────────────────────────────── */
    function fmtTime(v) {
      if (v == null || v === '') return '—'
      var n = Number(v)
      var d = n ? new Date(n) : new Date(String(v))
      try { return isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false }) } catch (e) { return String(v) }
    }
    function fetchJson(url, opts) {
      return fetch(url, opts).then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status + ' 且响应非 JSON' } })
          .then(function (j) {
            if (r.status >= 400 && j && j.error) return j
            return j
          })
      })
    }
    function qs(o) {
      var parts = []
      Object.keys(o).forEach(function (k) {
        var v = o[k]
        if (v === undefined || v === null || v === '') return
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v))
      })
      return parts.join('&')
    }

    /* ── 迷你 Markdown 渲染（自包含；口径与家族便签/被炉一致）─────────────────
     * 行内：**粗** *斜* `代码` ~~删~~ [字](链)
     * 块级：```围栏``` #标题(1-4) -/*列表 1.列表 >引用 --- 分隔线 |表格|（含对齐）
     * 为什么不用 marked 之类：客户端 bundle 是手写单文件（家族同款），
     * 一条依赖就多一个解析/打包环节；而 wiki 正文用到的语法就这些。
     * React 元素构造 ⇒ 天然防注入（没有 innerHTML）。 */
    function mdInline(text, keyBase) {
      var parts = []
      var re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g
      var last = 0, m, n = 0
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) parts.push(text.slice(last, m.index))
        var t = m[0]
        var key = keyBase + '-i' + (n++)
        if (t.indexOf('**') === 0) parts.push(h('strong', { key: key }, t.slice(2, -2)))
        else if (t.indexOf('~~') === 0) parts.push(h('del', { key: key }, t.slice(2, -2)))
        else if (t.charAt(0) === '`') parts.push(h('code', { key: key }, t.slice(1, -1)))
        else if (t.charAt(0) === '[') {
          var mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t)
          parts.push(mm
            ? h('a', { key: key, href: mm[2], target: '_blank', rel: 'noopener noreferrer' }, mm[1])
            : t)
        } else parts.push(h('em', { key: key }, t.slice(1, -1)))
        last = m.index + t.length
      }
      if (last < text.length) parts.push(text.slice(last))
      return parts
    }

    function mdToBlocks(text) {
      var lines = String(text || '').split('\n')
      var blocks = []
      var i = 0, bk = 0
      var isBlockStart = function (s) {
        return /^\s*(?:```|#{1,4}\s|[-*]\s|\d+[.、)]\s|>|-{3,}|\*{3,}|\|)/.test(s)
      }
      while (i < lines.length) {
        var line = lines[i]
        if (/^\s*```/.test(line)) {
          var code = []
          i += 1
          while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i += 1 }
          i += 1
          blocks.push(h('pre', { key: 'b' + (bk++) }, h('code', null, code.join('\n'))))
          continue
        }
        if (/^\s*$/.test(line)) { i += 1; continue }
        var hm = /^(#{1,4})\s+(.*)$/.exec(line)
        if (hm) {
          blocks.push(h('div', { key: 'b' + (bk++), className: 'lbm-md-h lbm-md-h' + hm[1].length },
            mdInline(hm[2], 'b' + bk)))
          i += 1
          continue
        }
        if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
          blocks.push(h('hr', { key: 'b' + (bk++) }))
          i += 1
          continue
        }
        if (/^\s*[-*]\s+/.test(line)) {
          var li = []
          while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
            li.push(h('li', { key: 'li' + i }, mdInline(lines[i].replace(/^\s*[-*]\s+/, ''), 'li' + i)))
            i += 1
          }
          blocks.push(h('ul', { key: 'b' + (bk++) }, li))
          continue
        }
        if (/^\s*\d+[.、)]\s+/.test(line)) {
          var oli = []
          while (i < lines.length && /^\s*\d+[.、)]\s+/.test(lines[i])) {
            oli.push(h('li', { key: 'ol' + i }, mdInline(lines[i].replace(/^\s*\d+[.、)]\s+/, ''), 'ol' + i)))
            i += 1
          }
          blocks.push(h('ol', { key: 'b' + (bk++) }, oli))
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          var qd = []
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
            qd.push(h('div', { key: 'qd' + i }, mdInline(lines[i].replace(/^\s*>\s?/, ''), 'q' + i)))
            i += 1
          }
          blocks.push(h('blockquote', { key: 'b' + (bk++) }, qd))
          continue
        }
        // 表格：|表头| + |---分隔|（支持 :--- / :---: / ---: 对齐）+ 数据行…
        if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
          var parseRow = function (ln) {
            return ln.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim() })
          }
          var aligns = parseRow(lines[i + 1]).map(function (c) {
            if (/^:-+:$/.test(c)) return 'center'
            if (/^-+:$/.test(c)) return 'right'
            return 'left'
          })
          var hCells = parseRow(line).map(function (c, j) {
            return h('th', { key: 'th' + j, style: { textAlign: aligns[j] || 'left' } }, mdInline(c, 'th' + i))
          })
          i += 2
          var rows = []
          while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
            var cells = parseRow(lines[i]).map(function (c, j) {
              return h('td', { key: 'td' + j, style: { textAlign: aligns[j] || 'left' } }, mdInline(c, 'td' + i))
            })
            rows.push(h('tr', { key: 'tr' + i }, cells))
            i += 1
          }
          blocks.push(h('div', { key: 'b' + (bk++), className: 'lbm-md-wrap' },
            h('table', null,
              h('thead', null, h('tr', null, hCells)),
              h('tbody', null, rows))))
          continue
        }
        var para = []
        while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
          para.push(h('span', { key: 'ps' + i }, mdInline(lines[i], 'p' + i)))
          para.push(h('br', { key: 'br' + i }))
          i += 1
        }
        if (para.length) para.pop()
        blocks.push(h('p', { key: 'b' + (bk++) }, para))
      }
      return blocks
    }

    function Md(props) {
      return h('div', { className: 'lbm-md' + (props && props.className ? ' ' + props.className : '') },
        mdToBlocks(props && props.text))
    }

    /* ── 侧栏行图标（宿主 renderSlot 传 {size, active}）── */
    function Glyph(props) {
      var size = (props && props.size) || 18
      var c = props && props.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('path', {
          d: 'M12 5.7V8.5M6 8.5h12M6 8.5v4.8M18 8.5v4.8',
          stroke: c, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none',
        }),
        h('circle', { cx: 12, cy: 3.5, r: 2.2, fill: c }),
        h('circle', { cx: 6, cy: 15.5, r: 2.2, fill: c }),
        h('circle', { cx: 18, cy: 15.5, r: 2.2, fill: c }))
    }

    /* ── 家族树（由 entries 的 familyPath 自建父子关系）──────────────────── */

    function UploadPanel(props) {
      var txt = React.useState('')
      var text = txt[0], setText = txt[1]
      var src = React.useState('')
      var source = src[0], setSource = src[1]
      var st = React.useState({ log: [], busy: false })
      var up = st[0], setUp = st[1]
      var fn = React.useState('')
      var fileName = fn[0], setFileName = fn[1]
      var hov = React.useState(false)
      var hover = hov[0], setHover = hov[1]
      var fi = React.useRef(null)
      function entries() {
        var s = text.trim()
        if (!s) return []
        if (s[0] === '[' || s[0] === '{') {
          try {
            var j = JSON.parse(s)
            if (!Array.isArray(j)) j = [j]
            return j.map(function (x, i) {
              if (typeof x === 'string') return { source: '', text: x }
              return { source: x.source || x.slug || '', text: x.text || ((x.head || '') + '\n' + (x.body || x.content || '')) }
            }).filter(function (x) { return x.text && x.text.trim() })
          } catch (e) { return { err: 'JSON 解析失败：' + e } }
        }
        return [{ source: source, text: s }]                    // MD/纯文本=整篇一条
      }
      function readFirstFile(files) {
        var f = files && files[0]
        if (!f) return
        var rd = new FileReader()
        rd.onload = function () {
          setText(String(rd.result || ''))
          setFileName(f.name)
          if (!source) setSource('upload/' + f.name)
        }
        rd.readAsText(f, 'utf-8')
      }
      function onFile(e) { readFirstFile(e.target.files) }
      function submit() {
        var es = entries()
        if (!es || es.err || !es.length) { setUp({ log: [{ err: (es && es.err) || '没有可上传内容' }], busy: false }); return }
        var log = []
        setUp({ log: [], busy: true })
        ;(async function () {
          for (var i = 0; i < es.length; i++) {
            var x = es[i]
            try {
              var r = await fetch(API + '?op=insert', { method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source: x.source || '', ws: 'upload', text: x.text }) })
              var j = await r.json()
              log.push(j && j.ok ? { ok: true, source: x.source || '(自动)', path: (j.path || []).map(function (p) { return 'L' + p[0] + '#' + p[1] }).join('→') }
                                  : { err: ((x.source || '条目') + '：' + ((j && j.error) || '失败')) })
            } catch (err) { log.push({ err: (x.source || '条目') + '：' + err }) }
            setUp({ log: log.slice(), busy: true })
          }
          setUp({ log: log, busy: false })
        })()
      }
      var parsed = text.trim() ? entries() : []
      var parseNote = !text.trim() ? null
        : (parsed && parsed.err) ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' } }, '✗ ' + parsed.err)
        : h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' } },
            '解析出 ' + ((parsed && parsed.length) || 0) + ' 条' + ((parsed && parsed.length > 30) ? '（逐条编码约 ' + Math.ceil(parsed.length * 1.2 / 60) + ' 分钟）' : ''))
      var logOk = (up.log || []).filter(function (x) { return x.ok }).length
      var upCard = h('div', { className: 'lbm-card' },
          h('div', { className: 'lbm-cardTitle' }, '手动入库'),
          h('div', { className: 'lbm-cardDesc' },
            '推荐 JSON 数组 [{source,text}]（实时解析计数）；Markdown / 纯文本按整篇一条。逐条编码生长，不再送审。'),
          h('div', {
            className: 'lbm-drop' + (hover ? ' is-over' : ''),
            onClick: function () { if (fi.current) fi.current.click() },
            onDragOver: function (e) { e.preventDefault(); setHover(true) },
            onDragLeave: function () { setHover(false) },
            onDrop: function (e) { e.preventDefault(); setHover(false); readFirstFile(e.dataTransfer && e.dataTransfer.files) },
          },
            h('span', { className: 'lbm-dropIcon' }, '⇪'),
            h('span', null, fileName ? '已载入文件' : '拖拽文件到此处，或点击选择'),
            fileName ? h('span', { className: 'lbm-dropFile' }, fileName) : null,
            h('span', { style: { fontSize: '11px' } }, '支持 .json / .md / .txt'),
            h('input', { ref: fi, type: 'file', accept: '.json,.md,.txt', onChange: onFile, style: { display: 'none' } })),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0 8px' } },
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', flex: 'none' } }, '来源坐标'),
            h('input', { className: 'lbm-input', type: 'text', value: source, placeholder: '可选，如 会话哈希/批号',
              onChange: function (e) { setSource(e.target.value) } })),
          h('textarea', { className: 'lbm-input lbm-textarea', value: text, rows: 9,
            placeholder: '粘贴 JSON 数组（推荐）/ Markdown / 纯文本',
            onChange: function (e) { setText(e.target.value) } }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 } },
            h('button', { className: 'lbm-btn lbm-btnPrimary', type: 'button', onClick: submit, disabled: up.busy },
              up.busy ? '入库中…' : '编码入库'),
            parseNote))
      var upLog = (up.log || []).length ? h('div', { className: 'lbm-upLog' },
          h('div', { style: { marginBottom: 6, paddingBottom: 5, borderBottom: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' } },
            '上传日志 · 共 ' + up.log.length + ' 条（成功 ' + logOk + ' · 失败 ' + (up.log.length - logOk) + '）'),
          up.log.slice(-30).map(function (x, i) {
            return h('div', { key: i },
              x.ok ? h('span', null, '✓ ', h('b', null, x.source || '(自动)'), ' → ' + x.path)
                   : h('span', null, '✗ ', h('i', null, x.err)))
          })) : null
      if (props && props.bare) return h('div', null, upCard, upLog)   // 入库页内嵌模式（v0.10.0）
      return h('div', { style: { padding: '16px 20px 40px', maxWidth: 720, margin: '0 auto' } }, upCard, upLog)
    }

    /* ── 记录视图：P3 管线（作业卡 + 步骤条）+ 提交台账 ── */
    function stepCls(state) { return state === 'done' ? ' is-done' : state === 'act' ? ' is-act' : '' }
    function JobCard(j, key) {
      var phase = j.phase || 'queued'
      var pill = phase === 'distill' ? 'lbm-pillD' : phase === 'insert' ? 'lbm-pillI' : 'lbm-pillQ'
      var pillTxt = { queued: '排队中', distill: '提炼中', insert: '编码入树' }[phase] || phase
      var s2 = phase === 'insert' ? 'done' : phase === 'distill' ? 'act' : ''
      var s3 = phase === 'insert' ? 'act' : ''
      var dDone = phase === 'distill' ? (j.slicesDone || 0) : (j.slicesTotal || 0)
      var dPct = (j.slicesTotal || 0) > 0 ? Math.round(100 * Math.min(dDone, j.slicesTotal) / j.slicesTotal) : 0
      var iPct = (j.insertTotal || 0) > 0 ? Math.round(100 * Math.min(j.insertDone || 0, j.insertTotal) / j.insertTotal) : 0
      return h('div', { key: key, className: 'lbm-job' },
        h('div', { className: 'lbm-jobTop' },
          h('span', { className: 'lbm-jobSid' }, j.sid),
          j.batch ? h('span', { className: 'lbm-revs' }, '批次#' + j.batch) : null,
          h('span', { className: 'lbm-pill ' + pill },
            phase === 'distill' ? '◔ ' : phase === 'insert' ? '⛭ ' : '○ ', pillTxt),
          h('span', { className: 'lbm-jobMeta' },
            (j.range ? 'seq ' + j.range + ' · ' : '') + (j.segs || 0) + ' 段 · ' + (((j.chars || 0) / 10000).toFixed(1)) + ' 万字')),
        h('div', { className: 'lbm-steps' },
          h('span', { className: 'lbm-step is-done' }, h('span', { className: 'lbm-stepDot' }, '✓'), '压缩检测'),
          h('span', { className: 'lbm-stepLine is-done' }),
          h('span', { className: 'lbm-step' + stepCls(s2) },
            h('span', { className: 'lbm-stepDot' }, s2 === 'done' ? '✓' : '2'), '提炼'),
          h('span', { className: 'lbm-stepLine' + (s2 === 'done' ? ' is-done' : '') }),
          h('span', { className: 'lbm-step' + stepCls(s3) },
            h('span', { className: 'lbm-stepDot' }, s3 === 'done' ? '✓' : '3'), '编码入树')),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 } },
          h('div', { className: 'lbm-bar' },
            h('div', { className: 'lbm-barFill' + (dPct >= 100 ? ' is-done' : ''), style: { width: dPct + '%' } })),
          h('span', { className: 'lbm-pct' }, (j.slicesTotal || 0) > 0 ? ('提炼 ' + dDone + '/' + j.slicesTotal + ' 片') : '提炼 —')),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 3 } },
          h('div', { className: 'lbm-bar' },
            h('div', { className: 'lbm-barFill' + (iPct >= 100 ? ' is-done' : ''), style: { width: iPct + '%' } })),
          h('span', { className: 'lbm-pct' }, (j.insertTotal || 0) > 0 ? ('入树 ' + (j.insertDone || 0) + '/' + j.insertTotal + ' 条') : '入树 —')))
    }
    /* ── 入库视图（v0.10.0）：自动管线 + 手动入库 + 提交台账（做梦卡退休——做梦=脑图本体）── */
    function PipePanel() {
      var st = React.useState({ list: null, loading: false, error: null, total: 0 })
      var up = st[0], setUp = st[1]
      var ps = React.useState({ jobs: [], recent: [], busy: false })
      var pipe = ps[0], setPipe = ps[1]
      React.useEffect(function () {
        var alive = true
        var hadJobs = false
        var loadUp = function () {
          fetchJson(API + '?op=uploads&limit=500')
            .then(function (j) {
              if (!alive) return
              if (!j || !j.ok) { setUp({ list: null, loading: false, error: (j && j.error) || '未知错误', total: 0 }); return }
              setUp({ list: j.batches || [], loading: false, error: null, total: j.total || 0 })
            })
            .catch(function (err) { if (alive) setUp({ list: null, loading: false, error: String(err), total: 0 }) })
        }
        var loadPipe = function () {
          fetchJson(API + '?op=p3_status')
            .then(function (j) {
              if (!alive || !j || !j.ok) return
              setPipe(j)
              if (hadJobs && !(j.jobs || []).length) loadUp()   // 管线清空瞬间刷新台账（新批次落账）
              hadJobs = (j.jobs || []).length > 0
            })
            .catch(function () {})
        }
        setUp({ list: null, loading: true, error: null, total: 0 })
        loadUp(); loadPipe()
        var t = setInterval(loadPipe, 3000)
        return function () { alive = false; clearInterval(t) }
      }, [])
      var jobs = pipe.jobs || []
      var recent = pipe.recent || []
      function renderP3() {
        var head = h('div', { className: 'lbm-cardTitle' }, 'P3 管线',
          jobs.length
            ? h('span', { className: 'lbm-pill ' + (pipe.busy ? 'lbm-pillD' : 'lbm-pillQ'), style: { marginLeft: 8 } },
                (pipe.busy ? '◔ 运行中' : '○ 排队') + ' · ' + jobs.length + ' 单')
            : h('span', { className: 'lbm-pill lbm-pillQ', style: { marginLeft: 8 } }, '空闲'))
        var desc = h('div', { className: 'lbm-cardDesc' },
          '上下文压缩 → 捕获区间 → 分片提炼（LLM 三段式）→ 编码入树；每片硬超时 240s，断点续传')
        var jobCards = jobs.map(function (j, i) {
          return JobCard(j, (j.sid || '') + '-' + (j.batch || 0) + '-' + i)
        })
        var idle = jobs.length ? null
          : h('div', { className: 'lbm-note', style: { padding: '4px 0' } },
              '空闲——会话触发上下文压缩后自动开始，无需手动操作')
        var recentRows = !recent.length ? null : h('div', {
          style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--dsw-alias-border-l2)' } },
          h('div', { className: 'lbm-dSecTitle', style: { margin: '0 0 4px' } }, '最近压缩检测'),
          recent.slice(0, 6).map(function (r, i) {
            var skipped = String(r.status || '').indexOf('跳过') >= 0
            var done = String(r.status || '').indexOf('完成') >= 0
            var truncated = String(r.status || '').indexOf('截') >= 0
            var segInfo = skipped ? '' : ('seq ' + (r.range || '') + ' · ' + (r.segs || 0) + ' 段')
            var color = done ? 'var(--dsw-alias-state-success-primary,#16a34a)' : truncated ? 'var(--dsw-alias-state-warning-primary,#d97706)' : 'inherit'
            return h('div', { key: i, className: 'lbm-revs',
                               style: { display: 'flex', gap: 10, fontSize: '11px', lineHeight: '18px' } },
              h('span', null, r.sid), h('span', null, r.at),
              h('span', null, segInfo),
              h('span', { style: { color: color } }, r.status))
          }))
        return h('div', { className: 'lbm-card' }, head, desc, jobCards, idle, recentRows)
      }
      function renderLedger() {
        var count = (up.list && up.list.length) || 0
        var head = h('div', { className: 'lbm-cardTitle' }, '提交台账',
          h('span', { className: 'lbm-revs', style: { marginLeft: 8 } },
            up.loading ? '读取中…' : ((up.total || 0) + ' 条 / ' + count + ' 批')))
        var err = up.error ? h('div', { className: 'lbm-err', style: { margin: '8px 0 0' } }, up.error) : null
        var table = !count ? null : h('table', { className: 'lbm-ledger' },
          h('thead', null, h('tr', null,
            h('th', null, '对话 / 来源'), h('th', null, '时间'),
            h('th', { style: { textAlign: 'right' } }, '条数'))),
          h('tbody', null, (up.list || []).map(function (b, i) {
            return h('tr', { key: b.id || i },
              h('td', { style: { fontFamily: 'var(--ds-font-family-code,monospace)', fontSize: '11px' } }, b.session),
              h('td', null, b.at),
              h('td', { style: { textAlign: 'right', fontWeight: 600 } }, String(b.count)))
          })))
        var empty = count ? null : (up.list
          ? h('div', { className: 'lbm-note', style: { padding: '4px 0' } }, '暂无提交记录') : null)
        return h('div', { className: 'lbm-card' }, head, err, table, empty)
      }
      return h('div', { style: { padding: '16px 20px 40px', maxWidth: 860, margin: '0 auto' } },
        renderP3(),
        h('div', { className: 'lbm-dSecTitle', style: { margin: '14px 0 8px' } }, '手动入库'),
        h(UploadPanel, { bare: true }),
        h('div', { className: 'lbm-dSecTitle', style: { margin: '14px 0 8px' } }, '提交台账'),
        renderLedger())
    }

    /* ── 设置视图：元数据驱动渲染（后端 settings_get 新增键自动出现在「其他」组，界面永不过时）── */
    var SETTINGS_GROUPS = [
      { id: 'api', title: '提炼 API', desc: 'P3 压缩提炼用的外部大模型（OpenAI 兼容格式），保存后热生效' },
      { id: 'p3', title: '提炼参数', desc: '压缩触发后的分片与字数控制；超出总上限保新弃旧' },
      { id: 'bili', title: 'bili 压缩通道', desc: 'billion-context 代理的上下文压缩块 → P3 提炼（双轨之二，主通道）；块摘要可零 LLM 直采入库' },
      { id: 'inject', title: '注入参数', desc: '每轮检索注入的条数与正文长度' },
      { id: 'pool', title: '注入池 · 两级赛马', desc: '预热池 → 预备池；热度 = 三通道总分（语义 + 关键词 + 血缘基因）' },
      { id: 'ckpt', title: '检查点调度', desc: '五档稀释快照（1月/7天全量 + 24h/6h/1h 增量）的定期维护' },
    ]
    var SETTINGS_META = {
      llmUrl:         { grp: 'api', label: '接口地址', ph: 'https://api.deepseek.com/v1/chat/completions' },
      llmModel:       { grp: 'api', label: '模型', ph: 'deepseek-chat' },
      llmKey:         { grp: 'api', label: 'API Key', ph: '留空保持现状' },
      p3MinChars:     { grp: 'p3', label: '最小触发字数', ph: '2000', hint: '区间人话低于此值跳过提炼' },
      p3ChunkChars:   { grp: 'p3', label: '分片上限（字/片）', ph: '40000', hint: '防 max_tokens 截断丢整批' },
      p3MaxTokens:    { grp: 'p3', label: '输出上限（token/片）', ph: '16384' },
      p3TotalChars:   { grp: 'p3', label: '总字数上限', ph: '330000', hint: '超出截旧段（保新弃旧）' },
      p3BiliEnabled:      { grp: 'bili', label: 'bili 通道开关', bool: true },
      p3BiliSummaryDirect:{ grp: 'bili', label: '块摘要直采', bool: true, hint: '压缩块摘要 ≥100 字零 LLM 直接入库' },
      p3BiliDb:           { grp: 'bili', label: 'bili 库路径', ph: 'C:/Users/…/billion-context/sessions/index.db' },
      injectTop:      { grp: 'inject', label: '注入条数 / 轮', ph: '3' },
      injectBodyMax:  { grp: 'inject', label: '正文上限（字/条）', ph: '8000' },
      injectPool:        { grp: 'pool', label: '注入池开关', bool: true },
      injectPrefetchTop: { grp: 'pool', label: '每轮入池条数', ph: '10' },
      injectCycleRounds: { grp: 'pool', label: '预热批寿命（轮）', ph: '3' },
      injectSettleTop:   { grp: 'pool', label: '每批晋级预备池数', ph: '3' },
      injectKeepFrac:    { grp: 'pool', label: '周期末保留比例', ph: '0.5', hint: '按周期平均热度的相对名次保留' },
      injectMissTop:     { grp: 'pool', label: '命中补漏上限（条/轮）', ph: '3' },
      ckptEnabled:    { grp: 'ckpt', label: '调度开关', bool: true },
      ckptIntervalMs: { grp: 'ckpt', label: '巡检间隔（ms）', ph: '600000' },
    }
    function SettingsPanel(props) {
      var st = React.useState(null)
      var sv = st[0], setSv = st[1]
      var msg = React.useState('')
      var saved = msg[0], setMsg = msg[1]
      React.useEffect(function () {
        fetchJson(API + '?op=settings_get')
          .then(function (j) { setSv(j && j.ok ? j.settings : { error: (j && j.error) || '读取失败' }) })
          .catch(function (err) { setSv({ error: String(err) }) })
      }, [])
      if (!sv) return h('div', { className: 'lbm-empty' }, '读取设置中…')
      if (sv.error) return h('div', { className: 'lbm-err' }, sv.error)
      function setVal(key, v) { var n = Object.assign({}, sv); n[key] = v; setSv(n) }
      function renderField(key) {
        var m = SETTINGS_META[key] || {}
        var isBool = !!m.bool
        var val = sv[key]
        return h('div', { key: key, className: 'lbm-fld' },
          h('span', { className: 'lbm-fldLabel' }, m.label || key),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 30 } },
            isBool
              ? h('button', {
                  type: 'button',
                  className: 'lbm-tgl' + (val === true || val === 'true' ? ' is-on' : ''),
                  onClick: function () { setVal(key, !(val === true || val === 'true')) },
                  title: '开关',
                  'aria-pressed': !!(val === true || val === 'true') })
              : h('input', {
                  className: 'lbm-input', type: 'text', value: val == null ? '' : String(val),
                  placeholder: m.ph || '',
                  onChange: function (e) { setVal(key, e.target.value) } })),
          m.hint ? h('span', { className: 'lbm-fldHint' }, m.hint) : null)
      }
      function save() {
        var body = {}
        Object.keys(sv).forEach(function (k) {
          if (k === 'llmKeyTail' || k === 'error') return
          body[k] = sv[k]
        })
        setMsg('保存中…')
        fetch(API + '?op=settings_save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body) })
          .then(function (r) { return r.json().catch(function () { return { ok: false } }) })
          .then(function (j) { setMsg(j && j.ok ? '✓ 保存成功' : '保存失败') })
          .catch(function () { setMsg('保存失败') })
      }
      var known = new Set(Object.keys(SETTINGS_META).concat(['llmKeyTail', 'error']))
      var extra = Object.keys(sv).filter(function (k) { return !known.has(k) })
      return h('div', { style: { padding: '16px 20px 40px', maxWidth: 720, margin: '0 auto' } },
        SETTINGS_GROUPS.map(function (g) {
          var keys = Object.keys(SETTINGS_META).filter(function (k) { return SETTINGS_META[k].grp === g.id && sv[k] !== undefined })
          if (!keys.length) return null
          return h('div', { key: g.id, className: 'lbm-card' },
            h('div', { className: 'lbm-cardTitle' }, g.title),
            h('div', { className: 'lbm-cardDesc' }, g.desc),
            h('div', { className: 'lbm-fldRow' }, keys.map(renderField)))
        }),
        extra.length ? h('div', { className: 'lbm-card' },
          h('div', { className: 'lbm-cardTitle' }, '其他'),
          h('div', { className: 'lbm-cardDesc' }, '后端新增的参数（未归类，自动出现）'),
          h('div', { className: 'lbm-fldRow' }, extra.map(renderField))) : null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 } },
          h('button', { className: 'lbm-btn lbm-btnPrimary', type: 'button', onClick: save }, '保存设置'),
          h('span', { className: 'lbm-revs' }, saved)))
    }

    /* ── 脑图 · 数据口（op 路由，全部经宿主 /api/liubian-wiki）───────────────── */
    function opGet(op, params) {
      var s = API + '?op=' + encodeURIComponent(op)
      if (params) Object.keys(params).forEach(function (k) {
        var v = params[k]
        if (v !== undefined && v !== null && v !== '') s += '&' + k + '=' + encodeURIComponent(v)
      })
      return fetchJson(s)
    }

    /* ══ 脑区地形图：圆填充（circle packing）════════════════════════════════
       为什么不是力导向：140 个区力导向会互相重叠成一团泡泡，尺寸也不代表任何东西。
       圆填充 = 不重叠 + 面积语义（元记忆数）+ 标签可读，命中时整块点亮。
       数据：op=brain → {ids, regions:{id:{size,rep,events,nEvents}}, links:[[a,b,w]]} */
    function naoHash(x) {
      var h = 2166136261
      for (var i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 16777619) }
      return ((h >>> 0) % 10000) / 10000
    }
    function naoSize(r) { return Math.max(1, Number((r && r.size) || 1)) }

    function BrainMap(props) {
      var canvasR = React.useRef(null)
      var wrapR = React.useRef(null)
      var tipR = React.useRef(null)
      var posR = React.useRef(null)      // id → {x,y,r}
      var hoverR = React.useRef(null)
      var dataR = React.useRef(null)
      var propsR = React.useRef(props)
      propsR.current = props

      function token(name, fb) {
        try {
          var v = getComputedStyle(document.documentElement).getPropertyValue(name)
          return (v && v.trim()) || fb
        } catch (e) { return fb }
      }

      // 圆填充：按 size 降序依次放到螺旋空位上，碰撞即退；最后归一化到画布
      function layout(data, W, H) {
        var ids = (data.ids || []).slice()
        ids.sort(function (a, b) { return naoSize(data.regions[b]) - naoSize(data.regions[a]) })
        var first = ids[0]
        var mx = Math.sqrt(naoSize(data.regions[first])) || 1
        var rMax = Math.min(W, H) * 0.175, rMin = 5
        var placed = []
        ids.forEach(function (id) {
          var r = Math.max(rMin, rMax * Math.sqrt(naoSize(data.regions[id])) / mx)
          var x = 0, y = 0, ok = false, t = 0
          while (!ok && t < 4000) {
            var ang = t * 0.5, rr = 3 + t * 0.45
            x = Math.cos(ang) * rr; y = Math.sin(ang) * rr; ok = true
            for (var k = 0; k < placed.length; k++) {
              var o = placed[k], dx = x - o.x, dy = y - o.y
              if (dx * dx + dy * dy < (r + o.r + 2) * (r + o.r + 2)) { ok = false; break }
            }
            t++
          }
          placed.push({ id: id, x: x, y: y, r: r })
        })
        var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9
        placed.forEach(function (p) {
          minX = Math.min(minX, p.x - p.r); maxX = Math.max(maxX, p.x + p.r)
          minY = Math.min(minY, p.y - p.r); maxY = Math.max(maxY, p.y + p.r)
        })
        var s = Math.min((W - 40) / Math.max(1, maxX - minX), (H - 40) / Math.max(1, maxY - minY))
        var map = {}
        placed.forEach(function (p) {
          p.x = (p.x - (minX + maxX) / 2) * s + W / 2
          p.y = (p.y - (minY + maxY) / 2) * s + H / 2
          p.r = p.r * s
          map[p.id] = p
        })
        return map
      }

      function draw() {
        var cv = canvasR.current
        var data = dataR.current
        var P = propsR.current || {}
        if (!cv || !cv.getContext) return
        var ctx = cv.getContext('2d')
        if (!ctx) return
        var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
        var W = cv.clientWidth || 0, H = cv.clientHeight || 0
        if (!W || !H) return
        if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
          cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr)
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, W, H)
        if (!data || !data.ids || !data.ids.length) {
          ctx.fillStyle = token('--dsw-alias-label-tertiary', '#8a8a94')
          ctx.font = '12px system-ui'
          ctx.fillText(P.empty || '暂无脑区数据', 20, 30)
          return
        }
        if (!posR.current) posR.current = layout(data, W, H)
        var pos = posR.current
        var hit = P.hit || {}
        var brand = token('--dsw-alias-brand-primary', '#4f6ef7')
        var ink = token('--dsw-alias-label-secondary', '#5c5c66')

        // 连线（跨区关联）：大区间淡弧，给网络感但不抢戏
        var top = data.ids.slice(0, 26)
        ctx.lineWidth = 1
        for (var i = 0; i < top.length; i++) {
          var a = pos[top[i]], b = pos[top[(i * 7 + 5) % top.length]]
          if (!a || !b) continue
          ctx.strokeStyle = 'rgba(79,110,247,.06)'
          ctx.beginPath(); ctx.moveTo(a.x, a.y)
          ctx.quadraticCurveTo((a.x + b.x) / 2 + (naoHash('c' + i) - 0.5) * 60, (a.y + b.y) / 2 + (naoHash('d' + i) - 0.5) * 60, b.x, b.y)
          ctx.stroke()
        }
        // 圆
        data.ids.forEach(function (id) {
          var p = pos[id]; if (!p) return
          var h = hit[id] || 0
          var big = Math.min(1, p.r / (Math.min(W, H) * 0.175))
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
          if (h) {
            ctx.fillStyle = brand
          } else {
            ctx.fillStyle = 'rgba(79,110,247,' + (0.055 + 0.16 * big).toFixed(3) + ')'
          }
          ctx.fill()
          ctx.strokeStyle = h ? brand : 'rgba(79,110,247,' + (0.18 + 0.22 * big).toFixed(3) + ')'
          ctx.lineWidth = h ? 1.5 : 1
          ctx.stroke()
        })
        // 标签：能装下的前 14 个（命中区优先），名称取代表句前 6 字
        var shown = 0
        var order = data.ids.slice().sort(function (a, b) {
          return (hit[b] || 0) - (hit[a] || 0) || (pos[b] ? pos[b].r : 0) - (pos[a] ? pos[a].r : 0)
        })
        order.forEach(function (id) {
          if (shown >= 14) return
          var p = pos[id]; if (!p || p.r < 17) return
          var reg = (data.regions || {})[id] || {}
          var nm = String(reg.rep || '').replace(/\s+/g, '').slice(0, 6) || String(id).slice(-6)
          var h = hit[id] || 0
          ctx.font = (h ? '600 ' : '') + '11px system-ui'
          var w = ctx.measureText(nm).width
          if (w > p.r * 1.75) return
          ctx.fillStyle = h ? '#ffffff' : ink
          ctx.fillText(nm, p.x - w / 2, p.y + 4)
          shown++
        })
      }

      React.useEffect(function () {
        dataR.current = props.data
        posR.current = null      // 数据变化 → 重排
        hoverR.current = null
        draw()
        // 宿主首帧常给 0 尺寸：稍后再补绘一次
        var t1 = setTimeout(draw, 60)
        var t2 = setTimeout(draw, 320)
        return function () { clearTimeout(t1); clearTimeout(t2) }
      }, [props.data])
      React.useEffect(function () { draw() })

      function at(e) {
        var cv = canvasR.current
        if (!cv || !cv.getBoundingClientRect || !e) return null
        var r = cv.getBoundingClientRect()
        return { x: (e.clientX || 0) - r.left, y: (e.clientY || 0) - r.top }
      }
      function pick(pt) {
        if (!pt) return null
        var data = dataR.current, pos = posR.current
        if (!data || !pos) return null
        var best = null, bd = 1e9
        data.ids.forEach(function (id) {
          var p = pos[id]; if (!p) return
          var dx = p.x - pt.x, dy = p.y - pt.y
          var d2 = dx * dx + dy * dy
          if (d2 <= p.r * p.r && d2 < bd) { bd = d2; best = id }
        })
        return best
      }
      function showTip(id, pt) {
        var tip = tipR.current
        if (!tip) return
        if (!id || !pt) { tip.style.display = 'none'; return }
        var data = dataR.current || {}
        var reg = (data.regions || {})[id] || {}
        var nm = String(reg.rep || '').replace(/\s+/g, '').slice(0, 40) || String(id)
        tip.textContent = nm + ' · ' + naoSize(reg) + ' 元记忆 · ' + (reg.nEvents || 0) + ' 元事件'
        tip.style.display = 'block'
        tip.style.left = Math.round(pt.x + 12) + 'px'
        tip.style.top = Math.round(pt.y + 12) + 'px'
      }

      return h('div', { className: 'nao-stage', ref: wrapR },
        h('canvas', {
          ref: canvasR, className: 'nao-map',
          onMouseMove: function (e) {
            var pt = at(e), id = pick(pt)
            hoverR.current = id
            showTip(id, pt)
            if (canvasR.current && canvasR.current.style) canvasR.current.style.cursor = id ? 'pointer' : 'default'
          },
          onMouseLeave: function () { hoverR.current = null; showTip(null, null) },
          onMouseDown: function (e) { var pt = at(e); var id = pick(pt); if (id) showTip(id, pt) },
          onMouseUp: function (e) {
            var id = pick(at(e))
            if (id && props.onPick) props.onPick(id)
          },
          onWheel: function () { /* 圆填充自适应视口，无需缩放 */ },
        }),
        h('div', { className: 'nao-tip', ref: tipR, style: { display: 'none' } }),
        h('div', { className: 'nao-legend' },
          h('span', null, h('i', { style: { background: token('--dsw-alias-brand-primary', '#4f6ef7') } }), '命中区'),
          h('span', null, h('i', { style: { background: 'rgba(79,110,247,.22)' } }), '脑区'),
          h('span', null, h('i', { style: { background: 'rgba(79,110,247,.07)' } }), '小簇')))
    }

    /* ══ 脑图视图：地形 + 检索 ═══════════════════════════════════════════ */
    function AtlasView(props) {
      var bs = React.useState({ loading: true })
      var brain = bs[0], setBrain = bs[1]
      var qs = React.useState('')
      var qtext = qs[0], setQtext = qs[1]
      var rs = React.useState({ busy: false, rows: [], q: '' })
      var res = rs[0], setRes = rs[1]
      var ds = React.useState(null)
      var pickId = ds[0], setPickId = ds[1]
      var es = React.useState(null)
      var entry = es[0], setEntry = es[1]

      var loadBrain = React.useCallback(function () {
        setBrain({ loading: true })
        opGet('brain', { topn: 140 }).then(function (j) {
          setBrain(j && j.ok ? { loading: false, ids: j.ids, regions: j.regions, links: j.links } : { loading: false, error: (j && j.error) || '读取失败' })
        }).catch(function (e) { setBrain({ loading: false, error: String(e) }) })
      }, [])
      React.useEffect(function () { loadBrain() }, [loadBrain])

      function runSearch() {
        var q = String(qtext || '').trim()
        if (!q) { setRes({ busy: false, rows: [], q: '' }); return }
        setRes({ busy: true, rows: [], q: q })
        opGet('race', { text: q, want: 20 }).then(function (j) {
          if (j && j.ok) setRes({ busy: false, rows: j.ranked || [], q: q })
          else setRes({ busy: false, rows: [], q: q, error: (j && j.error) || '检索失败' })
        }).catch(function (e) { setRes({ busy: false, rows: [], q: q, error: String(e) }) })
      }
      function openEntry(src) {
        setEntry({ loading: true, source: src })
        opGet('entry_get', { source: src }).then(function (j) {
          setEntry(j && j.ok ? { loading: false, source: src, head: j.head, body: j.body, tags: j.tags } : { loading: false, source: src, error: (j && j.error) || '读取失败' })
        }).catch(function (e) { setEntry({ loading: false, source: src, error: String(e) }) })
      }

      // 命中映射：检索结果 → 其事件所在区（按名次衰减）→ 画布点亮
      var hit = {}
      var hasHit = false
      if (res.q && res.rows.length && brain.regions) {
        var evBasin = {}
        Object.keys(brain.regions).forEach(function (bid) {
          (brain.regions[bid].events || []).forEach(function (ev) { evBasin[ev] = bid })
        })
        res.rows.forEach(function (r, i) {
          var b = evBasin[r.source]
          if (!b) return
          hit[b] = Math.max(hit[b] || 0, 1 - i / Math.max(8, res.rows.length))
          hasHit = true
        })
      }
      var region = pickId && brain.regions ? brain.regions[pickId] : null
      var total = props.count || 0

      var right
      if (entry) {
        right = h('div', { className: 'nao-detail' },
          h('div', { className: 'nao-sideHead' },
            h('span', { className: 'nao-dim' }, String(entry.source || '').slice(0, 24)),
            h('span', { className: 'nao-spacer' }),
            h('button', { className: 'nao-btn', type: 'button', onClick: function () { setEntry(null) } }, '关闭')),
          entry.loading ? h('div', { className: 'nao-dim nao-pad' }, '载入…')
            : entry.error ? h('div', { className: 'nao-err' }, entry.error)
              : h('div', { className: 'nao-detailBody' },
                h('div', { style: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary,#1b1b1f)', marginBottom: '8px', lineHeight: 1.5 } },
                  String(entry.head || '').split('\n')[0]),
                h(Md, { text: entry.body || '' })))
      } else if (res.q) {
        right = h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
          h('div', { className: 'nao-sideHead' }, '检索结果',
            h('span', { className: 'nao-spacer' }),
            h('span', { className: 'nao-dim', style: { fontWeight: 400 } }, res.rows.length ? res.rows.length + ' 条' : '—')),
          res.error ? h('div', { className: 'nao-err' }, res.error) : null,
          !res.busy && !res.rows.length && !res.error ? h('div', { className: 'nao-empty' }, '没有匹配的记忆') : null,
          h('div', { className: 'nao-sideScroll' },
            res.rows.map(function (r, i) {
              var tot = Number(r.total) || 0
              return h('button', {
                key: r.source, type: 'button', className: 'nao-hit' + (i === 0 ? ' is-on' : ''),
                onClick: function () { openEntry(r.source) },
              },
                h('div', { className: 'nao-hitT' }, String(r.head || '').split('\n')[0].slice(0, 70)),
                h('div', { className: 'nao-hitM' },
                  h('div', { className: 'nao-bar' }, h('i', { style: { width: Math.round(100 * Math.max(0, Math.min(1, tot / 2))) + '%' } })),
                  h('span', { className: 'nao-sku' },
                    'S ', h('b', null, (Number(r.S) || 0).toFixed(2)),
                    ' K ', h('b', null, (Number(r.K) || 0).toFixed(2)),
                    ' B ', h('b', null, (Number(r.B) || 0).toFixed(2)))))
            })))
      } else if (region) {
        right = h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
          h('div', { className: 'nao-sideHead' }, '脑区',
            h('span', { className: 'nao-spacer' }),
            h('button', { className: 'nao-btn', type: 'button', onClick: function () { setPickId(null) } }, '关闭')),
          h('div', { className: 'nao-rep' }, String(region.rep || '（该区没有代表句）').slice(0, 160)),
          h('div', { className: 'nao-dim nao-pad' }, naoSize(region) + ' 元记忆 · ' + (region.nEvents || 0) + ' 元事件'),
          h('div', { className: 'nao-sideScroll' },
            (region.events || []).map(function (ev) {
              return h('button', { key: ev, type: 'button', className: 'nao-evRow', onClick: function () { openEntry(ev) }, title: ev }, ev)
            })))
      } else {
        right = h('div', null,
          h('div', { className: 'nao-sideHead' }, '提示'),
          h('div', { className: 'nao-empty', style: { height: '240px' } }, '输入问题检索，或点击地形上的区'))
      }

      return h('div', { className: 'nao-body' },
        h('div', { className: 'nao-left' },
          h('div', { className: 'nao-tool' },
            h('input', {
              className: 'nao-input', type: 'text', value: qtext,
              placeholder: '在脑中检索：输入任意问题，回车',
              onChange: function (e) { setQtext(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter') runSearch() },
            }),
            h('button', { className: 'nao-btn primary', type: 'button', onClick: runSearch, disabled: res.busy }, res.busy ? '检索中' : '检索'),
            res.q ? h('button', {
              className: 'nao-btn', type: 'button',
              onClick: function () { setQtext(''); setRes({ busy: false, rows: [], q: '' }); setPickId(null) },
            }, '清除') : null),
          h(BrainMap, {
            data: brain.ids ? brain : null, hit: hit, hasHit: hasHit,
            onPick: function (id) { setPickId(id); setEntry(null); setRes({ busy: false, rows: [], q: '' }) },
            empty: brain.error || (brain.loading ? '载入脑区…' : '暂无脑区数据'),
          }),
          h('div', { className: 'nao-dim', style: { padding: '8px 2px 10px', fontSize: '11px' } },
            total ? total.toLocaleString() + ' 元事件 · ' + (brain.ids ? brain.ids.length : 0) + ' 脑区 · 面积 = 元记忆数' : '')),
        h('aside', { className: 'nao-right' }, right))
    }

    /* ══ 睡眠视图：入库即组织（元记忆生长流）═══════════════════════════ */
    function SleepView(props) {
      var st = React.useState({ loading: true, items: [], mm: 0, regions: 0, entryRegion: 0 })
      var s = st[0], setS = st[1]
      React.useEffect(function () {
        Promise.all([opGet('recent', { n: 60 }), opGet('mm_stats')]).then(function (arr) {
          var r1 = arr[0] || {}, r2 = arr[1] || {}
          setS({
            loading: false, items: r1.items || [],
            mm: r2.mm || 0, regions: r2.regions || 0, entryRegion: r2.entry_region || 0,
            error: r1.error || r2.error,
          })
        }).catch(function (e) { setS({ loading: false, items: [], mm: 0, regions: 0, entryRegion: 0, error: String(e) }) })
      }, [])
      var items = s.items || []
      var withMm = items.filter(function (x) { return x.mm > 0 }).length
      return h('div', { className: 'nao-sleep' },
        h('div', { className: 'nao-stats' },
          [['元记忆', s.mm ? s.mm.toLocaleString() : '—'],
           ['脑区', s.regions || '—'],
           ['已定盆事件', s.entryRegion ? s.entryRegion.toLocaleString() : '—'],
           ['近 60 条入睡率', items.length ? Math.round(100 * withMm / items.length) + '%' : '—']].map(function (c) {
            return h('div', { key: c[0], className: 'nao-stat' },
              h('div', { className: 'nao-statV' }, String(c[1])),
              h('div', { className: 'nao-statL' }, c[0]))
          })),
        s.error ? h('div', { className: 'nao-err' }, s.error) : null,
        h('div', { className: 'nao-table' },
          items.map(function (it) {
            return h('div', { key: it.source, className: 'nao-srow' },
              h('div', { className: 'nao-stime' }, String(it.grewAt || '').replace('T', ' ').slice(5, 16)),
              h('div', { className: 'nao-smain' },
                h('div', { className: 'nao-shead', title: it.source }, String(it.head || '').split('\n')[0].slice(0, 80)),
                h('div', { className: 'nao-smeta' },
                  h('span', { className: 'nao-tag' }, it.mm ? it.mm + ' 句' : '未睡眠'),
                  it.basin ? h('span', { className: 'nao-tag' }, '区 ' + String(it.basin).slice(-8) + (it.basinSize ? ' · ' + it.basinSize : '')) : null,
                  (it.tags || []).slice(0, 4).map(function (t) { return h('span', { key: t, className: 'nao-tag' }, t) }))))
          })))
    }

    /* ══ 面板壳：左导航 + 顶栏 + 内容 ═════════════════════════════════════ */
    function App(props) {
      var vs = React.useState('brain')
      var view = vs[0], setView = vs[1]
      var ts = React.useState({ loading: true })
      var tree = ts[0], setTree = ts[1]
      var loadTree = React.useCallback(function () {
        opGet('stats').then(function (j) {
          setTree(j && j.ok ? { loading: false, count: j.entries || 0, mm: j.mm || 0 } : { loading: false, error: (j && j.error) || '读取失败' })
        }).catch(function (e) { setTree({ loading: false, error: String(e) }) })
      }, [])
      React.useEffect(function () { loadTree() }, [loadTree])
      var back = (props && (props.backToConversation || props.back)) || null
      var NAV = [
        ['brain', '脑图', 'M12 3.6c2 0 3.6 1.6 3.6 3.6S14 10.8 12 10.8 8.4 9.2 8.4 7.2 10 3.6 12 3.6Zm0 9.6c3.3 0 6 1.6 6 3.6v3.6H6V16.8c0-2 2.7-3.6 6-3.6Z'],
        ['sleep', '睡眠', 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Zm-3 5.2 3.2 4.6H9.4v1.6h5.2v-1.5L11.4 8.7h3V7.2H9Z'],
        ['pipe', '入库', 'M4.5 6.5h15v3h-15Zm1.5 4.5h12l-1.2 8.5H7.2Z'],
        ['settings', '设置', 'M12 8.6A3.4 3.4 0 1 0 12 15.4 3.4 3.4 0 0 0 12 8.6Zm8 3.4-.2-1.1 1.4-1.2-1.3-2.2-1.8.5-1-.6-.3-1.9h-2.6l-.3 1.9-1 .6-1.8-.5L5.8 9.7l1.4 1.2L7 12c0 .4 0 .7.1 1.1l-1.4 1.2 1.3 2.2 1.8-.5 1 .6.3 1.9h2.6l.3-1.9 1-.6 1.8.5 1.3-2.2-1.4-1.2c.1-.4.2-.7.2-1.1Z'],
      ]
      return h('div', { className: 'nao-app' },
        h('nav', { className: 'nao-nav' },
          h('div', { className: 'nao-navTitle' }, '记忆'),
          NAV.map(function (v) {
            return h('button', {
              key: v[0], type: 'button', className: 'nao-navBtn' + (view === v[0] ? ' is-on' : ''),
              onClick: function () { setView(v[0]) },
            },
              h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': true }, h('path', { d: v[2], fill: 'currentColor' })),
              h('span', null, v[1]))
          })),
        h('div', { className: 'nao-main' },
          h('header', { className: 'nao-top' },
            h('h1', { className: 'nao-title' }, view === 'brain' ? '脑图' : view === 'sleep' ? '睡眠' : view === 'pipe' ? '入库' : '设置'),
            h('span', { className: 'nao-count' },
              tree.error ? '服务异常'
                : tree.loading ? '载入中…'
                  : view === 'brain' ? (tree.count || 0).toLocaleString() + ' 元事件'
                    : (tree.count || 0).toLocaleString() + ' 条'),
            h('span', { className: 'nao-spacer' }),
            h('button', { className: 'nao-btn', type: 'button', onClick: loadTree }, '刷新'),
            typeof back === 'function' ? h('button', { className: 'nao-btn', type: 'button', onClick: function () { back() } }, '返回对话') : null),
          view === 'brain' ? h(AtlasView, { count: tree.count }) : null,
          view === 'sleep' ? h(SleepView) : null,
          view === 'pipe' ? h(PipePanel) : null,
          view === 'settings' ? h(SettingsPanel) : null))
    }

    var WikiApp = App          // 宿主注册名保持 WikiApp（slots 注入 + 桩测按函数名取）

    exports.inject = ['slots']
    // 自测缝（_dev/client_smoke.mjs 用；对宿主完全惰性 —— 宿主只读 inject/apply）
    exports.__test = {
      mdToBlocks: mdToBlocks, mdInline: mdInline, Md: Md,
      PipePanel: PipePanel, UploadPanel: UploadPanel, SettingsPanel: SettingsPanel,
      BrainMap: BrainMap, AtlasView: AtlasView, SleepView: SleepView, App: App, WikiApp: WikiApp,
      opGet: opGet, scopeParams: scopeParams,
    }
    exports.apply = function (ctx) {
      ctx.effect(function () {
        var style = document.createElement('style')
        style.setAttribute('data-liubian-memory', '1')
        style.textContent = CSS.join('\n') + '\n' + NAO_CSS.join('\n')
        document.head.appendChild(style)
        return function () { style.remove() }
      }, 'liubian-memory: styles')

      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 11,
          label: PANEL_LABEL,
        }, Glyph)
      })
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PANEL_ID }, WikiApp)
      })
    }

    return module.exports
  }
})
