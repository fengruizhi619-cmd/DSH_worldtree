// 流变·记忆 面板（client）：
//  - 入口：sidebar.panellist 注册「流变wiki」行（id=liubianwiki，order 11 → 第五项）；
//      行 id 必须与下面 main 槽的 key 完全一致，否则宿主 layout.selectPanel 直接抛错。
//  - 内容：家族树浏览 + 三模式检索（关键词 / 语义 / 融合）+ 条目详情；
//  - 数据：本插件宿主路由 /api/liubian-wiki?op=tree|get|find|health（**纯读**，不写任何数据）。
//      路由背后是记忆侧跨插件服务 liubianWiki——本插件不直读别人的库，也不直写。
//  - v0.2.0：接真实流变 wiki（184 条目 / 14 根家族）。
window.__ModuleLoader__.load({
  id: 'dsh-worldtree',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var PANEL_ID = 'liubianwiki'
    var PANEL_LABEL = '世界树wiki'
    var API = '/api/liubian-wiki'
    // 旧日记归档族的根 slug（记忆侧导入时定的）——树里它以 title「日记」出现。
    // 检索「范围」开关与"源枝去重"都靠它（见 runSearch / 日记源枝）。
    var DIARY_FAMILY = '日记'

    var MODES = [
      { id: 'hybrid', label: '融合', hint: '语义 + 字面（字面命中抬升）' },
      { id: 'semantic', label: '语义', hint: '向量：查询 vs 条目简介锚' },
      { id: 'keyword', label: '关键词', hint: '字面：标题/简介/正文/slug/路径' },
    ]
    var STATUSES = [
      { id: '', label: '全部' },
      { id: 'stable', label: 'stable' },
      { id: 'draft', label: 'draft' },
      { id: 'obsolete', label: 'obsolete' },
    ]
    // 检索范围：现在记忆是**三层**——策展条目（人写的）／精华条目（从日记提炼）／日记原料（逐篇导入）。
    // 真正该切的一刀是「知识 vs 原料」：原料上万条会把知识挤下去。
    // 过滤走**服务端**（helper 的 familyPrefix / excludeFamilyPrefix）。
    var SCOPES = [
      { id: 'all', label: '全部', hint: '策展 + 精华 + 日记原料' },
      { id: 'wiki', label: '不含原料', hint: '排除 日记/ 原料族（只看策展与精华）' },
      { id: 'diary', label: '仅原料', hint: '只看 日记/ 原料族' },
    ]
    var STATUS_COLOR = { stable: '#16a34a', draft: '#d97706', obsolete: '#9ca3af' }

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
    function buildTree(entries) {
      var byFull = {}
      entries.forEach(function (e) { byFull[e.fullPath] = e })
      var kids = {}
      var roots = []
      var orphans = []
      entries.forEach(function (e) {
        var p = byFull[e.familyPath]
        if (p && p !== e) {
          (kids[p.fullPath] = kids[p.fullPath] || []).push(e)
        } else if (e.familyPath === e.slug) {
          roots.push(e)
        } else {
          orphans.push(e)
        }
      })
      var cmp = function (a, b) { return String(a.fullPath).localeCompare(String(b.fullPath), 'zh') }
      roots.sort(cmp)
      Object.keys(kids).forEach(function (k) { kids[k].sort(cmp) })
      orphans.sort(cmp)
      return { roots: roots, orphans: orphans, kids: kids, byFull: byFull }
    }

    // 树节点每屏渲染上限：日记导入后单个年节点下会有几千个子节点，
    // 一次全渲染会卡住界面（2026-10-06 导入 778 篇时已见苗头，全量 10338 篇必卡）。
    var TREE_PAGE = 60

    function TreeNode(props) {
      var e = props.entry
      var kids = props.kids[e.fullPath] || []
      var open = !!props.expanded[e.fullPath]
      var sel = props.selected === e.slug
      var lim = (props.shown && props.shown[e.fullPath]) || TREE_PAGE
      var slice = kids.length > lim ? kids.slice(0, lim) : kids
      return h('div', null,
        h('button', {
          className: 'lbm-node' + (sel ? ' is-sel' : ''),
          type: 'button',
          style: { paddingLeft: (props.depth * 12 + 8) + 'px' },
          title: e.fullPath + ' ｜ ' + e.status + ' ｜ 修订 ' + e.revisions,
          onClick: function () {
            props.onSelect(e.slug)
            if (kids.length) props.onToggle(e.fullPath)
          },
        },
          h('span', { className: 'lbm-twist' }, kids.length ? (open ? '▾' : '▸') : ''),
          h('span', { className: 'lbm-dot', style: { background: STATUS_COLOR[e.status] || '#9ca3af' } }),
          h('span', { className: 'lbm-nodeTitle' }, e.title || e.slug),
          kids.length ? h('span', { className: 'lbm-revs' }, String(kids.length)) : null),
        open ? h('div', null,
          slice.map(function (k) {
            return h(TreeNode, {
              key: k.fullPath, entry: k, kids: props.kids, expanded: props.expanded,
              onToggle: props.onToggle, onSelect: props.onSelect, selected: props.selected,
              depth: props.depth + 1, shown: props.shown, onMore: props.onMore,
            })
          }),
          kids.length > lim
            ? h('button', {
                className: 'lbm-more', type: 'button',
                style: { marginLeft: (props.depth * 12 + 20) + 'px' },
                onClick: function () { props.onMore(e.fullPath) },
              }, '显示更多（' + lim + ' / ' + kids.length + '）')
            : null) : null)
    }

    /* ── 条目详情 ─────────────────────────────────────────────────────────── */
    function Detail(props) {
      var d = props.detail
      if (props.loading) return h('div', { className: 'lbm-empty' }, '读取中…')
      if (props.error) return h('div', { className: 'lbm-err' }, '读取条目失败：' + props.error)
      if (!d) {
        return h('div', { className: 'lbm-empty' },
          h('div', null, '左侧点一个条目，这里显示正文与修订史。'),
          h('div', { style: { marginTop: '8px' } }, '检索：上方输入框 —— 关键词 / 语义 / 融合三种模式。'))
      }
      var page = d.page || d
      var revs = page.recentRevisions || []
      return h('div', { className: 'lbm-detail' },
        h('h2', { className: 'lbm-dTitle' }, page.title || page.slug),
        h('div', { className: 'lbm-dMeta' },
          h('span', { className: 'lbm-tag' }, page.slug),
          h('span', { className: 'lbm-tag', style: { color: STATUS_COLOR[page.status] || '' } }, page.status || '—'),
          h('span', null, '修订 ' + (page.revisions != null ? page.revisions : '—')),
          h('span', null, '更新 ' + fmtTime(page.updatedAt)),
          h('span', null, '家族 ' + (page.familyPath || '—'))),
        page.intro ? h('div', { className: 'lbm-dIntro' }, h(Md, { text: page.intro })) : null,
        h('div', { className: 'lbm-dSecTitle' }, '正文'),
        h('div', { className: 'lbm-content' }, h(Md, { text: page.content || '（正文为空）' })),
        (page.diaryRefs && page.diaryRefs.length)
          ? h('div', null,
              h('div', { className: 'lbm-dSecTitle' }, '溯源日记 ' + page.diaryRefs.length + ' 篇（点开看原文）'),
              h('div', null, page.diaryRefs.map(function (r) {
                return h('button', {
                  key: r.workspace + '/' + r.id, className: 'lbm-chipBtn', type: 'button',
                  title: r.qualified ? '正文里带了工作区限定，按 (工作区,日记号) 精确定位'
                                     : '正文里只写了日记号——该号在多个工作区存在时全部列出（不猜）',
                  onClick: function () { props.onDiary(r.workspace, r.id) },
                }, r.id + ' @ ' + r.workspace)
              })))
          : null,
        (page.children && page.children.length)
          ? h('div', null,
              h('div', { className: 'lbm-dSecTitle' }, '子条目 ' + page.children.length),
              page.children.map(function (c) {
                return h('button', {
                  key: c.slug, className: 'lbm-childBtn', type: 'button',
                  onClick: function () { props.onSelect(c.slug) },
                }, '↳ ' + (c.title || c.slug) + '  ', h('span', { className: 'lbm-note' }, c.fullPath))
              }))
          : null,
        (revs && revs.length)
          ? h('div', null,
              h('div', { className: 'lbm-dSecTitle' }, '最近修订（' + revs.length + '）'),
              revs.map(function (r) {
                return h('div', { key: 'r' + r.rev, className: 'lbm-revRow' },
                  h('b', null, 'r' + r.rev),
                  h('span', null, fmtTime(r.time)),
                  h('span', null, r.contributor || '—'),
                  h('span', null, r.action || ''),
                  h('span', { style: { flex: '1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.summary || ''))
              }))
          : null,
        (page.checkpoints && page.checkpoints.length)
          ? h('div', { className: 'lbm-dSecTitle' }, '检查点 ' + page.checkpoints.length + ' 档（梯度稀释）')
          : null)
    }

    /* ── 日记枝（工作区 → 日记；懒加载 + 分页）────────────────────────────── */
    function DiaryRows(props) {
      var pg = props.pg || {}
      var items = pg.items || []
      if (pg.loading && !items.length) return h('div', { className: 'lbm-note', style: { padding: '4px 22px' } }, '载入中…')
      if (pg.error) return h('div', { className: 'lbm-err' }, pg.error)
      return h('div', null,
        items.map(function (it) {
          var sel = props.sel && props.sel.id === it.id && props.sel.ws === it.workspace
          var tip = (it.summary || '') + (it.tags && it.tags.length ? '\n标签：' + it.tags.join('、') : '')
          return h('button', {
            key: it.workspace + '/' + it.id, type: 'button',
            className: 'lbm-diaryRow' + (sel ? ' is-sel' : ''),
            style: { paddingLeft: '38px' },
            title: tip,
            onClick: function () { props.onOpen(it.workspace, it.id) },
          },
            h('span', { className: 'lbm-diaryId' }, it.id),
            h('span', { className: 'lbm-nodeTitle' }, (it.summary || '（无摘要）').slice(0, 46)),
            h('span', { className: 'lbm-diaryDate' }, it.date || ''))
        }),
        items.length < (pg.total || 0)
          ? h('button', {
              className: 'lbm-more', type: 'button',
              onClick: function () { props.onMore(props.ws, items.length) },
            }, pg.loading ? '载入中…' : '加载更多（' + items.length + ' / ' + pg.total + '）')
          : null)
    }

    function DiaryBranch(props) {
      var st = props.st || {}
      if (!st.open) return null
      if (st.error) return h('div', { className: 'lbm-err' }, '日记枝不可用：' + st.error)
      if (st.loading) return h('div', { className: 'lbm-empty' }, '载入日记枝…')
      return h('div', null, (st.list || []).map(function (w) {
        var open = !!props.open[w.workspace]
        return h('div', { key: w.workspace },
          h('button', {
            className: 'lbm-node', type: 'button', style: { paddingLeft: '20px' },
            title: w.workspace + '：' + w.count + ' 篇日记',
            onClick: function () { props.onToggleWs(w.workspace) },
          },
            h('span', { className: 'lbm-twist' }, open ? '▾' : '▸'),
            h('span', { className: 'lbm-nodeTitle' }, w.workspace),
            h('span', { className: 'lbm-revs' }, String(w.count))),
          open ? h(DiaryRows, {
            pg: (props.pages || {})[w.workspace], ws: w.workspace, sel: props.sel,
            onOpen: props.onOpen, onMore: props.onLoadMore,
          }) : null)
      }))
    }

    /* ── 日记详情（旧日记挂树；管理员 2026-10-06 指令）────────────────────── */
    function DiaryDetail(props) {
      if (props.loading) return h('div', { className: 'lbm-empty' }, '读取日记中…')
      // 日记号跨工作区重号 → 让**用户**选，不替它猜（猜一个就是取错人）
      if (props.needWorkspace) {
        return h('div', { className: 'lbm-chooseWrap' },
          h('div', { className: 'lbm-chooseTitle' }, '这个日记号在多个工作区都存在，请选一个：'),
          h('div', { className: 'lbm-note', style: { marginBottom: '10px' } },
            '日记号只在工作区内唯一（实测 D0001 出现在 19 个工作区），所以坐标必须带工作区。'),
          (props.candidates || []).map(function (c) {
            return h('button', {
              key: c.workspace, className: 'lbm-chooseBtn', type: 'button',
              onClick: function () { props.onPick(c.workspace) },
            }, c.workspace)
          }))
      }
      if (props.error) return h('div', { className: 'lbm-err' }, '读取日记失败：' + props.error)
      var d = props.data
      if (!d) {
        return h('div', { className: 'lbm-empty' },
          h('div', null, '左侧「日记」枝：展开工作区，点一篇看原文。'),
          h('div', { style: { marginTop: '8px' } }, '日记是 wiki 条目的原料——条目正文里的 D 号就指向它们。'))
      }
      var diary = d.diary || d
      var refs = diary.referencedBy || []
      // 关键词词云：本篇标签（主色）+ 联想词（共现，灰）——管理员 2026-10-10 需求
      var cloudSrc = diary.workspace && diary.id ? (diary.workspace + '/' + diary.id) : ''
      return h('div', { className: 'lbm-detail' },
        h('h2', { className: 'lbm-dTitle' }, '日记 ' + diary.id),
        h('div', { className: 'lbm-dMeta' },
          h('span', { className: 'lbm-tag' }, diary.workspace),
          diary.date ? h('span', null, diary.date) : null,
          diary.time ? h('span', null, diary.time) : null,
          h('span', null, (diary.chars || 0) + ' 字')),
        (diary.tags && diary.tags.length)
          ? h('div', { style: { marginTop: '10px' } }, diary.tags.map(function (t) {
              return h('span', { key: t, className: 'lbm-tag', style: { marginRight: '6px' } }, t)
            }))
          : null,
        cloudSrc ? h(TagCloudForSource, { source: cloudSrc }) : null,
        h('div', { className: 'lbm-dSecTitle' }, '正文'),
        h('div', { className: 'lbm-content' }, h(Md, { text: diary.body || '（正文为空）' })),
        diary.summary ? h('div', null, h('div', { className: 'lbm-dSecTitle' }, '摘要'), h(Md, { text: diary.summary })) : null,
        h('div', { className: 'lbm-dSecTitle' }, '被这些 wiki 条目引用（' + refs.length + '）'),
        refs.length
          ? h('div', null, refs.map(function (r) {
              return h('button', {
                key: r.slug, className: 'lbm-chipBtn', type: 'button',
                onClick: function () { props.onOpenWiki(r.slug) },
              }, r.title || r.slug)
            }))
          : h('div', { className: 'lbm-note' }, '暂无 wiki 条目在正文里引用它。'))
    }

    /* ── 主面板 ───────────────────────────────────────────────────────────── */
    /* 记忆上传记录（盘点）：每行 = 一个上传批次（对话哈希/来源 ｜ 时间 ｜ 产出条数）。
     * 数据：op=uploads（世界树库 uploads 表；便签上行按池键=会话哈希精确分组）。 */
    function TagCloudForSource(props) {
      var src = props.source
      var st = React.useState(null)
      var data = st[0], setData = st[1]
      React.useEffect(function () {
        if (!src) return
        setData(null)
        fetchJson(API + '?op=entry_tags&source=' + encodeURIComponent(src))
          .then(function (j) { setData(j && j.ok ? j : { error: (j && j.error) || '读取失败' }) })
          .catch(function (err) { setData({ error: String(err) }) })
      }, [src])
      if (!data) return null
      if (data.error) return h('div', { className: 'lbm-revs' }, '词云：' + data.error)
      var own = data.tags || [], assoc = data.associated || []
      if (!own.length && !assoc.length) return null
      return h('div', { style: { padding: '4px 0 8px', borderBottom: '1px solid var(--dsw-alias-separator)', marginBottom: 6 } },
        own.length ? h('div', null, own.map(function (t, i) {
          return h('span', { key: i, style: { fontSize: '13px', margin: '0 6px 0 0', color: 'var(--dsw-alias-state-business-primary)' } }, ' #' + t)
        })) : null,
        assoc.length ? h('div', { style: { marginTop: 4 } }, assoc.map(function (x, i) {
          var big = x.count >= 3 ? 13 : 11
          return h('span', { key: i, title: '共现 ' + x.count + ' 条',
            style: { fontSize: big + 'px', margin: '0 6px 0 0', color: 'var(--dsw-alias-label-tertiary)', cursor: 'default' } }, x.tag)
        })) : null)
    }

    /* ── tag 筛选面板：卡片式可折叠；词组化迁移（2026-10-17）后展示真实词汇 ── */
    function TagFilterPanel(props) {
      var st = React.useState({ list: null, loading: false, error: null })
      var tab = st[0], setTab = st[1]
      var sel = React.useState({})
      var selected = sel[0], setSelected = sel[1]
      var md = React.useState('rows')            // 'rows'=4行 ｜ 'full'=展开 ｜ 'hidden'=隐藏
      var mode = md[0], setMode = md[1]
      React.useEffect(function () {
        if (tab.list || tab.loading) return
        setTab({ list: null, loading: true, error: null })
        fetchJson(API + '?op=tag_table&limit=200')
          .then(function (j) {
            setTab(j && j.ok ? { list: j.tags || [], loading: false, error: null }
                             : { list: null, loading: false, error: (j && j.error) || '读取失败' })
          })
          .catch(function (err) { setTab({ list: null, loading: false, error: String(err) }) })
      }, [])
      function runFilter(sel) {                    // 点选即筛
        var tags = Object.keys(sel).join(',')
        if (!tags) { props.onResults && props.onResults(null, ''); return }
        fetchJson(API + '?op=tag_filter&tags=' + encodeURIComponent(tags))
          .then(function (j) { props.onResults && props.onResults(j && j.ok ? (j.hits || []) : { err: (j && j.error) || '筛选失败' }, Object.keys(selected).join(',')) })
          .catch(function (err) { props.onResults && props.onResults({ err: String(err) }, Object.keys(selected).join(',')) })
      }
      function pick(tag) {
        var n = Object.assign({}, selected)
        if (n[tag]) delete n[tag]; else n[tag] = true
        setSelected(n)
        runFilter(n)
      }
      var selCount = Object.keys(selected).length
      if (mode === 'hidden') {
        return h('button', { className: 'lbm-btn', type: 'button', onClick: function () { setMode('rows') } },
          '⌗ 标签筛选' + (selCount ? '（已选 ' + selCount + '）' : ''))
      }
      return h('div', { className: 'lbm-tagBox' + (mode === 'full' ? ' is-full' : '') },
        h('div', { className: 'lbm-tagHead' },
          h('span', { className: 'lbm-tagHeadTitle' }, '标签筛选',
            h('span', { className: 'lbm-revs' }, tab.loading ? ' 载入中…' : ' · ' + (tab.list ? tab.list.length : 0) + ' 个')),
          h('span', { style: { flex: 1 } }),
          selCount ? h('span', { className: 'lbm-tagSel' }, '已选 ' + selCount + '（点选即筛 · 再点取消）') : null,
          h('button', { className: 'lbm-btn lbm-btnSm', type: 'button', onClick: function () { setMode(mode === 'full' ? 'rows' : 'full') } },
            mode === 'full' ? '收起' : '展开全部'),
          h('button', { className: 'lbm-btn lbm-btnSm', type: 'button', onClick: function () { setMode('hidden') } }, '隐藏')),
        h('div', { className: 'lbm-tagCloud' + (mode === 'full' ? ' is-full' : '') },
          (tab.list || []).map(function (x) {
            var on = !!selected[x.tag]
            var big = x.count >= 100 ? 14 : (x.count >= 30 ? 13 : 12)
            return h('button', { key: x.tag, type: 'button', onClick: function () { pick(x.tag) },
              title: x.count + ' 条记忆带此标签', className: 'lbm-chip' + (on ? ' is-on' : ''),
              style: { fontSize: big + 'px' } },
              x.tag,
              h('span', { className: 'lbm-chipCount' + (on ? ' is-on' : '') }, String(x.count)))
          }),
          tab.error ? h('div', { className: 'lbm-err' }, tab.error) : null))
    }

    /* ── 上传视图：拖拽投放 + 粘贴 → 实时解析计数 → 逐条编码上树 ── */
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
      return h('div', { style: { padding: '16px 20px 40px', maxWidth: 720, margin: '0 auto' } },
        h('div', { className: 'lbm-card' },
          h('div', { className: 'lbm-cardTitle' }, '手动上树'),
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
              up.busy ? '上树中…' : '编码上树'),
            parseNote)),
        (up.log || []).length ? h('div', { className: 'lbm-upLog' },
          h('div', { style: { marginBottom: 6, paddingBottom: 5, borderBottom: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' } },
            '上传日志 · 共 ' + up.log.length + ' 条（成功 ' + logOk + ' · 失败 ' + (up.log.length - logOk) + '）'),
          up.log.slice(-30).map(function (x, i) {
            return h('div', { key: i },
              x.ok ? h('span', null, '✓ ', h('b', null, x.source || '(自动)'), ' → ' + x.path)
                   : h('span', null, '✗ ', h('i', null, x.err)))
          })) : null)
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
    function AuditPanel(props) {
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
        renderP3(), renderLedger())
    }

    /* ── 设置视图：元数据驱动渲染（后端 settings_get 新增键自动出现在「其他」组，界面永不过时）── */
    var SETTINGS_GROUPS = [
      { id: 'api', title: '提炼 API', desc: 'P3 压缩提炼用的外部大模型（OpenAI 兼容格式），保存后热生效' },
      { id: 'p3', title: '提炼参数', desc: '压缩触发后的分片与字数控制；超出总上限保新弃旧' },
      { id: 'bili', title: 'bili 压缩通道', desc: 'billion-context 代理的上下文压缩块 → P3 提炼（双轨之二，主通道）；块摘要可零 LLM 直采上树' },
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
      p3BiliSummaryDirect:{ grp: 'bili', label: '块摘要直采', bool: true, hint: '压缩块摘要 ≥100 字零 LLM 直接上树' },
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
    function WikiApp(props) {
      var back = props && props.backToConversation
      var st = React.useState({ tree: null, loading: true, error: null, count: 0 })
      var treeState = st[0], setTreeState = st[1]
      var se = React.useState({})
      var expanded = se[0], setExpanded = se[1]
      var sshow = React.useState({})
      var shown = sshow[0], setShown = sshow[1]
      var sq = React.useState({ text: '', mode: 'hybrid', status: '', scope: 'all' })
      var q = sq[0], setQ = sq[1]
      var sr = React.useState({ hits: null, loading: false, error: null, degraded: null, total: 0, ran: '' })
      var res = sr[0], setRes = sr[1]
      var sd = React.useState({ slug: '', detail: null, loading: false, error: null })
      var det = sd[0], setDet = sd[1]
      // 日记枝：dtState = 枝状态 / dOpen = 展开了哪些工作区 / dPages = 每区已加载页 / ddet = 选中日记
      var sdt = React.useState({ total: 0, list: null, loading: false, error: null, open: false })
      var dtState = sdt[0], setDtState = sdt[1]
      var sdo = React.useState({})
      var dOpen = sdo[0], setDOpen = sdo[1]
      var sdp = React.useState({})
      var dPages = sdp[0], setDPages = sdp[1]
      var sdd = React.useState({ ws: '', id: '', data: null, loading: false, error: null, needWorkspace: false, candidates: null })
      var ddet = sdd[0], setDdet = sdd[1]
      // 顶栏视图：检索（默认）/ 上传 / 记录（2026-10-11 改名+管线进度条）
      var svw = React.useState('search')
      var view = svw[0], setView = svw[1]
      // 家族树左栏折叠（管理员 2026-10-10：可向左隐藏，腾出全宽）
      var sto = React.useState(true)
      var treeOpen = sto[0], setTreeOpen = sto[1]

      var tree = treeState.tree
      var idx = React.useMemo(function () { return tree ? buildTree(tree.entries || []) : null }, [tree])

      function loadTree() {
        setTreeState({ tree: null, loading: true, error: null, count: 0 })
        fetchJson(API + '?op=wt_tree')
          .then(function (j) {
            if (!j || !j.ok) {
              setTreeState({ tree: null, loading: false, error: (j && j.error) || '未知错误', count: 0 })
              return
            }
            var e = j.entries || []
            setTreeState({ tree: j, loading: false, error: null, count: e.length })
            // 默认展开根家族的第一层（让 14 个家族一眼可见）
            var exp = {}
            e.forEach(function (x) { if (x.familyPath === x.slug) exp[x.fullPath] = true })
            setExpanded(exp)
          })
          .catch(function (err) {
            setTreeState({ tree: null, loading: false, error: String((err && err.message) || err), count: 0 })
          })
      }
      React.useEffect(function () { loadTree(); loadDiaryTree(false) }, [])

      function loadDetail(slug) {
        if (!slug) { setDet({ slug: '', detail: null, loading: false, error: '条目坐标为空（无法加载）' }); return }
        setDet({ slug: slug, detail: null, loading: true, error: null })
        fetchJson(API + '?op=get&' + qs({ slug: slug }))
          .then(function (j) {
            if (!j || !j.ok) { setDet({ slug: slug, detail: null, loading: false, error: (j && j.error) || '未知错误' }); return }
            setDet({ slug: slug, detail: j, loading: false, error: null })
          })
          .catch(function (err) { setDet({ slug: slug, detail: null, loading: false, error: String((err && err.message) || err) }) })
      }
      /** 打开一条世界树记忆（非 wiki 条目：tag 筛选命中的 P3/回填记忆没有 wiki 页，走树核 entry_get） */
      function loadMem(src) {
        // 记忆视图与日记视图互斥（同 openWiki）
        setDdet({ ws: '', id: '', data: null, loading: false, error: null, needWorkspace: false, candidates: null })
        setDet({ slug: '', src: src, detail: null, loading: true, error: null })
        fetchJson(API + '?op=entry_get&' + qs({ source: src }))
          .then(function (j) {
            if (!j || !j.ok) { setDet({ slug: '', src: src, detail: null, loading: false, error: (j && j.error) || '未知错误' }); return }
            var e = j.entry || {}
            var tagLine = (e.tags && e.tags.length) ? '\n\n标签：' + e.tags.join(' · ') : ''
            setDet({ slug: '', src: src, loading: false, error: null, detail: {
              title: e.source, slug: e.source, status: '记忆',
              revisions: null, updatedAt: e.grewAt, familyPath: e.ws,
              intro: (e.head || '') + tagLine,
              content: e.body || '（正文为空）',
              children: [], recentRevisions: [],
            } })
          })
          .catch(function (err) { setDet({ slug: '', src: src, detail: null, loading: false, error: String((err && err.message) || err) }) })
      }
      function select(slug) {
        if (!slug) return
        // 切到条目视图：清掉日记视图，右侧才不会同时挂着两篇内容
        setDdet({ ws: '', id: '', data: null, loading: false, error: null, needWorkspace: false, candidates: null })
        loadDetail(slug)
        if (idx && idx.byFull) {
          // 选中时把它的祖先链展开，树里能看见
          var e = null
          Object.keys(idx.byFull).forEach(function (k) { if (idx.byFull[k].slug === slug) e = idx.byFull[k] })
          if (e) {
            var exp = Object.assign({}, expanded)
            var cur = e
            var guard = 0
            while (cur && guard++ < 32) {
              exp[cur.fullPath] = true
              cur = idx.byFull[cur.familyPath] === cur ? null : idx.byFull[cur.familyPath]
            }
            setExpanded(exp)
          }
        }
      }
      function toggle(fullPath) {
        var exp = Object.assign({}, expanded)
        if (exp[fullPath]) delete exp[fullPath]
        else exp[fullPath] = true
        setExpanded(exp)
      }
      /** 展开树的下一页（日记族一个年节点下可能几千个孩子） */
      function growTree(fullPath) {
        setShown(function (s) {
          var n = Object.assign({}, s)
          n[fullPath] = (n[fullPath] || TREE_PAGE) + TREE_PAGE
          return n
        })
      }

      /* ── 日记枝：懒加载 + 分页 ────────────────────────────────────────────
       * setDPages 一律用**函数式更新**（读 p 而不是闭包里的 dPages）：
       * 否则同时展开两个工作区时，后返回的响应会覆盖先返回的（经典 stale state 覆盖）。 */
      var D_PAGE = 30
      /** 拉日记枝的一级（各工作区计数）。open=undefined 时保持当前展开态。 */
      function loadDiaryTree(open) {
        setDtState(function (s) {
          return { total: s.total || 0, list: s.list, loading: true, error: null,
                   open: open === undefined ? s.open : !!open }
        })
        fetchJson(API + '?op=diary_tree')
          .then(function (j) {
            if (!j || !j.ok) {
              setDtState(function (s) { return Object.assign({}, s, { loading: false, error: (j && j.error) || '未知错误' }) })
              return
            }
            setDtState(function (s) {
              return { total: j.total || 0, list: j.workspaces || [], loading: false, error: null, open: s.open }
            })
          })
          .catch(function (err) {
            setDtState(function (s) { return Object.assign({}, s, { loading: false, error: String((err && err.message) || err) }) })
          })
      }
      function toggleDiaryBranch() {
        if (dtState.loading) return
        if (dtState.list || dtState.error) {
          setDtState(Object.assign({}, dtState, { open: !dtState.open }))
          return
        }
        loadDiaryTree(true)
      }
      function loadDiaries(ws, offset) {
        var off = offset || 0
        setDPages(function (p) {
          var cur = p[ws] || { items: [], total: 0 }
          var n = Object.assign({}, p)
          n[ws] = { items: cur.items, total: cur.total, loading: true, error: null }
          return n
        })
        fetchJson(API + '?op=diary_list&' + qs({ workspace: ws, limit: D_PAGE, offset: off }))
          .then(function (j) {
            setDPages(function (p) {
              var cur = p[ws] || { items: [], total: 0 }
              var n = Object.assign({}, p)
              if (!j || !j.ok) {
                n[ws] = { items: cur.items, total: cur.total, loading: false, error: (j && j.error) || '未知错误' }
                return n
              }
              n[ws] = { items: (off ? cur.items : []).concat(j.items || []), total: j.total || 0, loading: false, error: null }
              return n
            })
          })
          .catch(function (err) {
            setDPages(function (p) {
              var cur = p[ws] || { items: [], total: 0 }
              var n = Object.assign({}, p)
              n[ws] = { items: cur.items, total: cur.total, loading: false, error: String((err && err.message) || err) }
              return n
            })
          })
      }
      function toggleDiaryWs(ws) {
        var open = !dOpen[ws]
        var n = Object.assign({}, dOpen)
        n[ws] = open
        setDOpen(n)
        var cur = dPages[ws]
        if (open && !(cur && cur.items && cur.items.length) && !(cur && cur.loading)) loadDiaries(ws, 0)
      }
      function openDiary(ws, id) {
        setDdet({ ws: ws, id: id, data: null, loading: true, error: null, needWorkspace: false, candidates: null })
        setDet({ slug: '', detail: null, loading: false, error: null })   // 右侧切成日记视图
        fetchJson(API + '?op=diary_get&' + qs({ id: id, workspace: ws }))
          .then(function (j) {
            if (j && j.needWorkspace) {
              setDdet({ ws: ws, id: id, data: null, loading: false, error: null, needWorkspace: true, candidates: j.candidates || [] })
              return
            }
            if (!j || !j.ok) {
              setDdet({ ws: ws, id: id, data: null, loading: false, error: (j && j.error) || '未知错误', needWorkspace: false, candidates: null })
              return
            }
            setDdet({ ws: ws, id: id, data: j, loading: false, error: null, needWorkspace: false, candidates: null })
          })
          .catch(function (err) {
            setDdet({ ws: ws, id: id, data: null, loading: false, error: String((err && err.message) || err), needWorkspace: false, candidates: null })
          })
      }
      /** 打开 wiki 条目（并清掉日记视图，让右侧显示条目） */
      function openWiki(slug) {
        setDdet({ ws: '', id: '', data: null, loading: false, error: null, needWorkspace: false, candidates: null })
        select(slug)
      }

      // 检索：输入防抖 350ms；模式/状态/范围变化立即重跑
      var pending = React.useRef(null)
      function runSearch(text, mode, status, scope) {
        var t = String(text || '').trim()
        if (!t) { setRes({ hits: null, loading: false, error: null, degraded: null, total: 0, ran: '' }); return }
        setRes({ hits: null, loading: true, error: null, degraded: null, total: 0, ran: t })
        // 范围过滤走**服务端**（helper 的 familyPrefix / excludeFamilyPrefix）：
        // 客户端事后过滤是二次事故——top-N 名额会被要排除的族占掉，返回条数不足。
        var scopeReq = scopeParams(scope)
        fetchJson(API + '?op=find&' + qs(Object.assign({ query: t, mode: mode, status: status, top: 40 }, scopeReq)))
          .then(function (j) {
            if (!j || !j.ok) {
              setRes({ hits: null, loading: false, error: (j && j.error) || '未知错误', degraded: null, total: 0, ran: t })
              return
            }
            setRes({ hits: j.results || [], loading: false, error: null, degraded: j.degraded || null, total: j.total || 0, ran: t })
          })
          .catch(function (err) {
            setRes({ hits: null, loading: false, error: String((err && err.message) || err), degraded: null, total: 0, ran: t })
          })
      }
      React.useEffect(function () {
        if (pending.current) window.clearTimeout(pending.current)
        if (!q.text.trim()) { setRes({ hits: null, loading: false, error: null, degraded: null, total: 0, ran: '' }); return }
        pending.current = window.setTimeout(function () { runSearch(q.text, q.mode, q.status, q.scope) }, 350)
        return function () { if (pending.current) window.clearTimeout(pending.current) }
      }, [q.text, q.mode, q.status, q.scope])

      // 标签筛选结果也要触发检索视图（ran 由文字搜索和 tag 筛选共同写入）
      var searching = !!(q.text.trim() || (res.ran && res.hits))
      var modeHint = (MODES.filter(function (m) { return m.id === q.mode })[0] || {}).hint || ''
      // 日记**源**枝的可见集合 = 还没导入成条目的工作区。
      // 判据：树里有没有 `日记/日记-<工作区>` 这个节点（导入器就是这么建家族的）。
      // 这样分批导入时源枝会自动变小，导完即消失，不会与树上的「日记」族重复显示。
      var srcList = React.useMemo(function () {
        var all = (dtState && dtState.list) || []
        if (!idx) return all
        return all.filter(function (w) { return !idx.byFull['日记/日记-' + w.workspace] })
      }, [dtState.list, idx])
      var srcTotal = srcList.reduce(function (a, w) { return a + (w.count || 0) }, 0)

      var VIEWS = [
        { id: 'search', label: '检索' },
        { id: 'upload', label: '上传' },
        { id: 'audit', label: '记录' },
        { id: 'settings', label: '设置' },
      ]
      return h('div', { className: 'lbm-panel' },
        h('div', { className: 'lbm-header' },
          h('span', { className: 'lbm-brand' },
            h('span', { className: 'lbm-brandDot' }),
            PANEL_LABEL),
          h('div', { className: 'lbm-tabs', role: 'tablist' },
            VIEWS.map(function (v) {
              return h('button', {
                key: v.id, type: 'button', role: 'tab',
                className: 'lbm-tab' + (view === v.id ? ' is-on' : ''),
                onClick: function () { setView(v.id) },
              }, v.label)
            })),
          h('span', { className: 'lbm-spacer' }),
          h('span', { className: 'lbm-stat' },
            treeState.error ? '服务异常'
              : (treeState.loading ? '载入中…'
                : (treeState.count + ' 条目 ｜ ' + ((idx && idx.roots.length) || 0) + ' 家族'
                  + (idx && idx.orphans.length ? ' ｜ 孤儿 ' + idx.orphans.length : '')
                  + (dtState.total ? ' ｜ 日记 ' + dtState.total : '')))),
          h('button', { className: 'lbm-btn', type: 'button', onClick: loadTree, title: '重新拉取家族树' }, '刷新'),
          typeof back === 'function' ? h('button', { className: 'lbm-btn', type: 'button', onClick: function () { back() } }, '返回对话') : null),

        view === 'search' ? h('div', { className: 'lbm-tools' },
          h('div', { className: 'lbm-searchRow' },
            h('input', {
              className: 'lbm-input', type: 'text', value: q.text,
              placeholder: '检索 wiki —— 回车立即搜（默认融合：语义 + 字面）',
              onChange: function (e) { setQ(Object.assign({}, q, { text: e.target.value })) },
              onKeyDown: function (e) { if (e.key === 'Enter') { if (pending.current) window.clearTimeout(pending.current); runSearch(q.text, q.mode, q.status, q.scope) } },
            }),
            h('div', { className: 'lbm-seg' }, MODES.map(function (m) {
              return h('button', {
                key: m.id, type: 'button', title: m.hint,
                className: 'lbm-segBtn' + (q.mode === m.id ? ' is-on' : ''),
                onClick: function () { setQ(Object.assign({}, q, { mode: m.id })) },
              }, m.label)
            }))),
          // tag 筛选独立成行（2026-10-17 修复：此前塞在 searchRow 横向 flex 里被挤成窄条没法用）
          h(TagFilterPanel, { onResults: function (arr, tags) {
              if (!arr) { setRes({ hits: null, loading: false, error: null, degraded: null, total: 0, ran: '' }); return }
              if (arr.err) { setRes({ hits: null, loading: false, error: arr.err, degraded: null, total: 0, ran: '标签：' + tags }); return }
              setRes({ hits: arr.map(function (x) {
                var _isWiki = x.source.indexOf('wiki:') === 0
                return { slug: _isWiki ? x.source.slice(5) : '', src: x.source, title: x.source,
                         familyPath: '', fullPath: _isWiki ? x.source.slice(5) : (x.ws || ''), intro: x.snippet || '', status: '', revisions: 0,
                         updatedAt: '', score: 1, semanticScore: null, match: 'tag', fields: null, snippet: x.snippet || '' }
              }), loading: false, error: null, degraded: null, total: arr.length, ran: '标签：' + tags })
            } }),
          h('div', { className: 'lbm-chips' },
            h('span', { className: 'lbm-chipLabel' }, '状态'),
            STATUSES.map(function (s) {
              return h('button', {
                key: 's' + s.id, type: 'button',
                className: 'lbm-chip' + (q.status === s.id ? ' is-on' : ''),
                onClick: function () { setQ(Object.assign({}, q, { status: s.id })) },
              }, s.label)
            }),
            h('span', { className: 'lbm-chipLabel', style: { marginLeft: '10px' } }, '范围'),
            SCOPES.map(function (s) {
              return h('button', {
                key: 'sc' + s.id, type: 'button', title: s.hint,
                className: 'lbm-chip' + (q.scope === s.id ? ' is-on' : ''),
                onClick: function () { setQ(Object.assign({}, q, { scope: s.id })) },
              }, s.label)
            }),
            h('span', { className: 'lbm-spacer' }),
            h('span', { className: 'lbm-note' }, modeHint))) : null,

        view === 'search' ? h('div', { className: 'lbm-body' },
          h('div', { className: 'lbm-left', style: treeOpen ? null : { display: 'none' } },
            h('div', { className: 'lbm-paneHead' },
              searching ? ('检索结果 ' + (res.loading ? '…' : (res.hits ? res.hits.length + ' / ' + res.total : 0)))
                        : '家族树（含日记归档族；点标题展开 / 右侧看正文 / 大族分页显示）'),
            h('div', { className: 'lbm-scroll' },
              searching
                ? (res.loading ? h('div', { className: 'lbm-empty' }, '检索中…')
                  : res.error ? h('div', { className: 'lbm-err' }, '检索失败：' + res.error)
                    : (!res.hits || !res.hits.length) ? h('div', { className: 'lbm-empty' }, '没有命中。换个词，或切到「语义」模式试试。')
                      : h('div', null,
                          res.degraded ? h('div', { className: 'lbm-warn', style: { margin: '10px 14px' } },
                            '已降级：' + (res.degraded.loss || res.degraded.reason || '语义一路缺席')) : null,
                          res.hits.map(function (r) {
                            var sel = r.slug ? det.slug === r.slug : (det.src === r.src)
                            return h('button', {
                              key: r.slug || r.src, type: 'button',
                              className: 'lbm-hit' + (sel ? ' is-sel' : ''),
                              onClick: function () { if (r.slug) select(r.slug); else if (r.src) loadMem(r.src) },
                            },
                              h('div', { className: 'lbm-hitTop' },
                                h('span', { className: 'lbm-dot', style: { background: STATUS_COLOR[r.status] || '#9ca3af' } }),
                                h('span', { className: 'lbm-hitTitle' }, r.title || r.slug || r.src),
                                h('span', { className: 'lbm-score' }, String(r.score)),
                                h('span', { className: 'lbm-tag' }, r.match === 'keyword' ? '字面' : (r.match === 'hybrid' ? '融合' : (r.match === 'tag' ? '标签' : '语义'))),
                                (r.match === 'hybrid' && r.semanticScore != null)
                                  ? h('span', { className: 'lbm-tag' }, '语义 ' + r.semanticScore) : null,
                                (r.fields && r.fields.length) ? h('span', { className: 'lbm-tag' }, r.fields.join('/')) : null),
                              h('div', { className: 'lbm-hitPath' }, r.fullPath),
                              r.snippet ? h('div', { className: 'lbm-hitSnip' }, r.snippet) : null)
                          })))
                : treeState.loading ? h('div', { className: 'lbm-empty' }, '载入家族树…')
                  : treeState.error ? h('div', { className: 'lbm-err' }, '家族树不可用：' + treeState.error
                      + '（提示：本面板走插件自带 /api/liubian-wiki 路由，后端=本地 wiki_store 只读副本（.memory_registry/liubian.db）；路由缺席时只读不可用）')
                    : h('div', null,
                        (idx.roots || []).map(function (e) {
                          return h(TreeNode, {
                            key: e.fullPath, entry: e, kids: idx.kids, expanded: expanded,
                            onToggle: toggle, onSelect: select, selected: det.slug, depth: 0,
                            shown: shown, onMore: growTree,
                          })
                        }),
                        idx.orphans.length
                          ? h('div', null,
                              h('div', { className: 'lbm-paneHead' }, '孤儿 ' + idx.orphans.length + '（家族父链断裂）'),
                              idx.orphans.map(function (e) {
                                return h(TreeNode, {
                                  key: e.fullPath, entry: e, kids: idx.kids, expanded: expanded,
                                  onToggle: toggle, onSelect: select, selected: det.slug, depth: 0,
                                  shown: shown, onMore: growTree,
                                })
                              }))
                          : null,
                        // ── 日记**源**枝：只有那些「还没导入成条目」的工作区才出现在这里 ──
                        // 导入后日记已是 `日记/` 族下的真条目，源枝必须自动让位、不能重复显示
                        // （2026-10-06：导入 中枢 778 篇后，这枝与树上的「日记」族会撞车）。
                        srcList.length
                          ? h('div', null,
                              h('button', {
                                className: 'lbm-secHead', type: 'button', onClick: toggleDiaryBranch,
                                title: '尚未导入成 wiki 条目的日记源（已导入的工作区不在此列）',
                              },
                                h('span', { className: 'lbm-twist' }, dtState.open ? '▾' : '▸'),
                                h('span', { className: 'lbm-nodeTitle' }, '日记源（未导入）'),
                                h('span', { className: 'lbm-revs' },
                                  dtState.loading ? '…' : (srcTotal || 0) + ' 篇 / ' + srcList.length + ' 区')),
                              h(DiaryBranch, {
                                st: Object.assign({}, dtState, { list: srcList }), open: dOpen, pages: dPages, sel: ddet,
                                onToggleWs: toggleDiaryWs, onLoadMore: loadDiaries, onOpen: openDiary,
                              }))
                          : null))),
          h('div', {
            onClick: function () { setTreeOpen(!treeOpen) },
            title: treeOpen ? '折叠家族树' : '展开家族树',
            style: {
              width: '14px', flex: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderLeft: treeOpen ? '.5px solid var(--dsw-alias-border-l3)' : 'none',
              borderRight: treeOpen ? 'none' : '.5px solid var(--dsw-alias-border-l3)',
              background: 'var(--dsh-alias-interactive-bg-hover)',
              color: 'var(--dsw-alias-label-tertiary)', fontSize: '10px',
              userSelect: 'none', minHeight: 0,
            } },
            treeOpen ? '◀' : '▶'),
          h('div', { className: 'lbm-right' },
            h('div', { className: 'lbm-scroll' },
              (ddet.loading || ddet.data || ddet.error || ddet.needWorkspace)
                ? h(DiaryDetail, {
                    data: ddet.data, loading: ddet.loading, error: ddet.error,
                    needWorkspace: ddet.needWorkspace, candidates: ddet.candidates,
                    onPick: function (ws) { openDiary(ws, ddet.id) },
                    onOpenWiki: openWiki,
                  })
                : h(Detail, {
                    detail: det.detail, loading: det.loading, error: det.error,
                    onSelect: openWiki, onDiary: openDiary,
                  }))))
        : h('div', { className: 'lbm-scroll' },
            // 非检索视图：全宽渲染（2026-10-17 修复：此前上传挤在底部条、记录/设置挤在树旁右列）
            view === 'upload' ? h(UploadPanel, null)
            : view === 'audit' ? h(AuditPanel, null)
            : view === 'settings' ? h(SettingsPanel, null)
            : null))
    }

    exports.inject = ['slots']
    // 自测缝（_dev/client_probe.mjs 用；对宿主完全惰性 —— 宿主只读 inject/apply）
    // 为什么连组件也暴露：日记枝 / 溯源区块这些**只在有数据时才渲染**的路径，
    // 光跑一次初始渲染根本走不到 —— 2026-10-06 真机翻车就是同款（抽查没覆盖到的分支等于没测）。
    exports.__test = {
      mdToBlocks: mdToBlocks, mdInline: mdInline, buildTree: buildTree, Md: Md,
      Detail: Detail, DiaryBranch: DiaryBranch, DiaryRows: DiaryRows, DiaryDetail: DiaryDetail,
      TreeNode: TreeNode, scopeParams: scopeParams, TREE_PAGE: TREE_PAGE, DIARY_FAMILY: DIARY_FAMILY,
    }
    exports.apply = function (ctx) {
      ctx.effect(function () {
        var style = document.createElement('style')
        style.setAttribute('data-liubian-memory', '1')
        style.textContent = CSS.join('\n')
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
