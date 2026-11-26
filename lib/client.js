// lib/client.js — 浏览器半：侧栏图标 + 独占工作台页面。
//
// 通道优先级：Typert Remote（`ctx.remote.$mount` → `remote['dsh-comfy-workbench']`）；
// 只有在 Remote 整个挂不上时才退到同源 HTTP `/dsh-comfy/v1/call`。
// 已经挂上但返回错误的调用**不会**重试 —— 出图这类动作重试一次就是两张图。
//
// 样式只用 --dsw-alias-* 主题变量，深浅色跟随宿主；类名统一 cw- 前缀，卸载即失效。

window.__ModuleLoader__.load({
  id: 'dsh-comfy-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PKG = 'dsh-comfy-workbench'
    const PANEL = 'comfy'
    const METHODS = [
      'probe', 'dirs', 'models', 'complete', 'workspace', 'workspaceBind',
      'submit', 'generate', 'job', 'serviceStart', 'serviceStop', 'config',
      'gallery', 'nsfwStatus', 'nsfwScan', 'catalog', 'catalogBind', 'workflows',
      'preview', 'stop', 'saveImage', 'upscale',
      'rewritePlan', 'rewriteApply', 'rewriteCancel',
      'hubStatus', 'hubKey', 'hubSearch', 'hubResolve',
      'hubDownload', 'hubJob', 'hubCancel', 'hubAdvice', 'hubChat', 'hubTranslate', 'hubTriggers', 'hubLookupTriggers',
    ]

    // ---------------------------------------------------------------- Remote

    function argsCodec() {
      return {
        mode: 'strict',
        typeSymbol: PKG + '/client#EndpointArgs',
        create: () => ({
          parse(value) {
            if (value === null || typeof value !== 'object' || Array.isArray(value)) {
              throw new TypeError(PKG + ': args must be a plain object')
            }
            return value
          },
        }),
      }
    }

    function descriptorsFor() {
      return METHODS.map((method) => ({
        id: PKG + '#' + PKG + '/' + method,
        service: PKG,
        namespace: PKG,
        method,
        invocation: { kind: 'direct' },
        parameters: [{ name: 'args', wire: 'args', source: 'json', codec: argsCodec() }],
        result: { mode: 'src-json' },
      }))
    }

    /** Remote 与 HTTP 两条通道都回 {ok,value}|{ok,error}，这里统一拆包。 */
    function unwrap(result) {
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') return result
      if (result.ok === true) return 'value' in result ? result.value : undefined
      const failure = result.error ?? {}
      const error = new Error(failure.message || '调用失败')
      error.code = failure.code || 'remote-error'
      throw error
    }

    async function httpCall(method, args) {
      const response = await fetch('/dsh-comfy/v1/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, args: args ?? {} }),
      })
      const payload = await response.json().catch(() => null)
      if (payload === null) throw new Error('HTTP ' + response.status + '：响应不是 JSON')
      return unwrap(payload)
    }

    /** 页面 ↔ 宿主 的唯一入口，apply 时填好。 */
    const bridge = {
      ctx: null,
      mounting: null,
      namespace: null,
      broken: false,

      /** 只在“挂得上/挂不上”上退让；挂上之后的业务错误一律往上抛，绝不换通道重试。 */
      async ensureNamespace() {
        if (this.namespace !== null) return this.namespace
        if (this.broken) return null
        const remote = this.ctx?.get?.('remote')
        if (!remote || typeof remote.$mount !== 'function') {
          this.broken = true
          return null
        }
        try {
          if (this.mounting === null) this.mounting = remote.$mount({ package: PKG, descriptors: descriptorsFor() })
          await this.mounting
          const ns = this.ctx.get('remote.' + PKG) || remote[PKG]
          if (!ns || typeof ns !== 'object') {
            this.broken = true
            return null
          }
          this.namespace = ns
          return ns
        } catch {
          this.broken = true
          this.mounting = null
          return null
        }
      },

      async call(method, args) {
        const ns = await this.ensureNamespace()
        if (ns !== null && typeof ns[method] === 'function') {
          try {
            return unwrap(await ns[method](args ?? {}))
          } catch (error) {
            // 唯一的例外：网关说「这个服务没这个方法」。那是宿主半的 Service 类漏了转发，
            // 请求根本没进业务代码，换 HTTP /v1/call 不会多跑一次出图或下载；
            // 其余业务错误照旧往上抛，绝不换通道重试（出图重试就是两张图）。
            const text = String(error?.code ?? '') + ' ' + String(error?.message ?? '')
            if (/method-unavailable|has no callable method/.test(text)) return httpCall(method, args)
            throw error
          }
        }
        return httpCall(method, args)
      },
    }

    // ------------------------------------------------------------------ CSS

    const CSS = `
.cw-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;}
.cw-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 18px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2);}
.cw-title{margin:0;font-size:14px;font-weight:600;line-height:22px;}
.cw-badge{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:var(--dsw-radius-sm);font-size:12px;line-height:22px;}
.cw-badge.up{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary);}
.cw-badge.down{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary);}
.cw-badge.idle{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}
.cw-spacer{flex:1 1 auto;}
.cw-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;text-decoration:none;box-sizing:border-box;height:30px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:28px;cursor:pointer;white-space:nowrap;}
.cw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}
.cw-btn:disabled{opacity:.45;cursor:default;}
/* 主按钮用「反色」而不是品牌色打底：本机这套皮肤把 --dsw-alias-brand-primary 解析成白色，
   白底 + 白字＝按钮消失（实测踩过）。label-primary / bg-layer-1 互为反色，深浅主题都成立。 */
.cw-btn.primary{background:var(--dsw-alias-label-primary);border-color:transparent;color:var(--dsw-alias-bg-layer-1);font-weight:600;}
.cw-btn.primary:hover:not(:disabled){opacity:.9;}
.cw-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 18px 24px;display:flex;flex-direction:column;gap:12px;}
.cw-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:12px 14px;display:flex;flex-direction:column;gap:10px;min-width:0;}
.cw-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.cw-card-title{margin:0;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);}
.cw-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent);}
.cw-warn-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.cw-warn-text{margin:0;flex:1 1 260px;min-width:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);}
.cw-facts{display:grid;gap:4px;margin:0;}
.cw-facts > div{display:grid;grid-template-columns:max-content minmax(0,1fr);column-gap:12px;align-items:baseline;}
.cw-facts dt{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.7;}
.cw-facts dd{margin:0;font-size:12px;line-height:1.7;overflow-wrap:anywhere;}
.cw-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}
.cw-select,.cw-input{box-sizing:border-box;height:30px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;min-width:0;}
.cw-select{max-width:280px;}
.cw-num{width:76px;}
.cw-label{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}
.cw-textarea{box-sizing:border-box;width:100%;min-height:104px;max-height:34vh;resize:vertical;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.65;}
.cw-textarea:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-brand-primary);outline-offset:1px;}
.cw-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary);}
.cw-path{font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);font-size:12px;overflow-wrap:anywhere;}
.cw-note{margin:0;font-size:12px;line-height:1.6;padding:8px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;white-space:pre-wrap;}
.cw-note.error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary);}
.cw-note.ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary);}
/* 「深度求索中」动图：白底贴纸，暗色主题下当贴纸看，不改原文件 */
.cw-btn-busy{background:#fff;border-color:transparent;color:#1a56db;padding:0 2px;gap:8px;cursor:default;}
.cw-btn-busy:hover{background:#fff;}
.cw-think{display:inline-flex;align-items:center;justify-content:center;gap:6px;}
.cw-think-sticker{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:26px;padding:0 2px;border-radius:var(--dsw-radius-sm);background:#fff;overflow:hidden;}
.cw-think-gif{display:block;height:24px;width:auto;max-width:104px;}
.cw-think-dots{display:inline-flex;align-items:center;gap:3px;height:26px;padding:0 8px;}
.cw-think-dots i{display:block;width:5px;height:5px;border-radius:50%;background:#1a56db;animation:cw-think-dot 1.1s infinite ease-in-out;}
.cw-think-dots i:nth-child(2){animation-delay:.16s;}
.cw-think-dots i:nth-child(3){animation-delay:.32s;}
@keyframes cw-think-dot{0%,80%,100%{opacity:.22;transform:translateY(0);}40%{opacity:1;transform:translateY(-2px);}}
.cw-think-label{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}
@media(prefers-reduced-motion:reduce){.cw-think-dots i{animation:none;opacity:.85;}}
/* 输入框 + 思考框并排：改写过程不进「输出」框，那是出图的日志 */
.cw-split{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:12px;align-items:start;min-width:0;}
@media(max-width:1000px){.cw-split{grid-template-columns:1fr;}}
.cw-think-card{min-width:0;}
.cw-logbox{display:flex;flex-direction:column;gap:4px;max-height:236px;overflow:auto;padding:2px 0;}
.cw-logline{display:flex;gap:6px;align-items:baseline;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}
.cw-logline time{flex:none;font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);}
.cw-logline.warn{color:var(--dsw-alias-state-warn-primary);}
.cw-logline.error{color:var(--dsw-alias-state-error-primary);}
.cw-logline.ok{color:var(--dsw-alias-state-success-primary);}
.cw-preview{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;}
.cw-preview img{max-width:min(100%,360px);border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l2);}
.cw-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;}
.cw-chip{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:22px;}
/* LoRA 多选器：徽标按钮 + 展开的多选表；勾选顺序 = 写入 LoraLoader 槽的顺序 */
.cw-chip-btn{appearance:none;border:.5px solid var(--dsw-alias-border-l2);background:none;font:inherit;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;gap:4px;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;}
.cw-chip-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.cw-chip-btn[aria-expanded="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);}
/* 徽标就是开关：点开在它下面挂下拉面板，不再把整张环境卡顶开 */
.cw-lora{position:relative;display:inline-flex;min-width:0;}
.cw-lora-pop{position:absolute;z-index:40;top:calc(100% + 8px);left:50%;transform:translateX(-50%);width:min(430px,calc(100vw - 60px));max-height:min(62vh,440px);overflow:auto;padding:10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);box-shadow:0 14px 36px rgba(0,0,0,.38);display:flex;flex-direction:column;gap:8px;}
.cw-lora-pop .cw-lora-list{max-height:none;padding:0;border:0;background:transparent;}
.cw-lora-pop .cw-lora-name{font-size:12px;}
.cw-lora-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}
.cw-lora-list{display:flex;flex-direction:column;gap:1px;max-height:236px;overflow:auto;padding:4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);}
.cw-lora-item{display:flex;align-items:center;gap:8px;padding:3px 6px;border-radius:var(--dsw-radius-sm);font-size:12px;min-width:0;}
.cw-lora-item:hover{background:var(--dsw-alias-interactive-bg-hover);}
.cw-lora-item.on{background:var(--dsw-alias-interactive-bg-hover);}
.cw-lora-item input[type=checkbox]{flex:none;width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary);}
.cw-lora-idx{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:999px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-1);font-size:10px;font-weight:600;}
.cw-lora-idx.off{background:transparent;}
.cw-lora-name{flex:1 1 auto;min-width:0;overflow:hidden;font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);font-size:11px;line-height:1.35;cursor:pointer;display:flex;flex-direction:column;gap:1px;}
.cw-lora-name > span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cw-lora-name .cw-lora-en{font-size:10px;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);}
.cw-lora-item.missing .cw-lora-name{color:var(--dsw-alias-state-warn-primary);}
/* 触发词 chip：点一下复制，样式照 ALT G1RL 那种小胶囊 */
.cw-lora-trigger{appearance:none;flex:none;display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;line-height:18px;max-width:132px;overflow:hidden;cursor:pointer;}
.cw-lora-trigger > span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cw-lora-trigger .ic{flex:none;opacity:.7;font-size:11px;}
.cw-lora-trigger:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);}
.cw-lora-trigger.missing{border-style:dashed;opacity:.75;}
.cw-lora-str{flex:none;width:64px;height:24px;font-size:11px;}
.cw-lora-foot{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;}
.cw-empty{margin:0;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary);}
.cw-tabs{display:flex;gap:4px;padding:8px 18px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);}
.cw-tab{appearance:none;border:none;background:none;padding:7px 12px 9px;font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary);cursor:pointer;border-bottom:2px solid transparent;}
.cw-tab:hover{color:var(--dsw-alias-label-primary);}
.cw-tab.active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600;}
.cw-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}
.cw-search{flex:0 1 220px;min-width:120px;}
.cw-folders{display:flex;gap:6px;flex-wrap:wrap;max-height:104px;overflow:auto;}
.cw-folder{appearance:none;display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:22px;cursor:pointer;max-width:320px;}
.cw-folder:hover{background:var(--dsw-alias-interactive-bg-hover);}
/* 选中的分类：同样不拿品牌色当底色，用悬停底色 + 品牌色描边，文字走 label 色 */
.cw-folder.active{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);font-weight:600;}
.cw-folder .n{opacity:.72;}
.cw-thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:8px;}
.cw-thumb{position:relative;padding:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);overflow:hidden;cursor:zoom-in;aspect-ratio:3/4;}
.cw-thumb img{display:block;width:100%;height:100%;object-fit:cover;}
.cw-thumb span{position:absolute;left:0;right:0;bottom:0;padding:3px 6px;font-size:10px;line-height:1.4;background:linear-gradient(to top,rgba(0,0,0,.62),transparent);color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cw-thumb-open{display:block;width:100%;height:100%;padding:0;border:0;background:none;cursor:zoom-in;text-align:left;}
.cw-thumb-use{position:absolute;left:6px;right:6px;bottom:26px;height:24px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:rgba(0,0,0,.7);color:#fff;font:inherit;font-size:11px;line-height:24px;cursor:pointer;opacity:0;transition:opacity .12s;}
.cw-thumb:hover .cw-thumb-use,.cw-thumb:focus-within .cw-thumb-use{opacity:1;}
.cw-style-thumb{width:34px;height:34px;border-radius:var(--dsw-radius-sm);object-fit:cover;border:.5px solid var(--dsw-alias-border-l2);flex:none;}
.cw-lightbox{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;gap:16px;padding:28px;background:rgba(0,0,0,.72);cursor:zoom-out;}
.cw-lightbox img{max-width:calc(100% - 260px);max-height:calc(100% - 40px);border-radius:var(--dsw-radius-md);box-shadow:0 12px 40px rgba(0,0,0,.5);cursor:default;}
.cw-lightbox-info{width:230px;flex:none;padding:12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.7;overflow-wrap:anywhere;}
.cw-release{display:flex;flex-direction:column;gap:10px;}
.cw-release h4{margin:0;font-size:13px;font-weight:600;}
.cw-iframe{width:100%;height:min(70vh,760px);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);}
.cw-sep{height:0;border-top:.5px solid var(--dsw-alias-border-l2);margin:2px 0;}
/* 逐步预览 */
.cw-steps{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:6px;}
.cw-step{position:relative;padding:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);overflow:hidden;aspect-ratio:1/1;cursor:zoom-in;}
.cw-step img{display:block;width:100%;height:100%;object-fit:cover;}
.cw-step em{position:absolute;left:4px;top:4px;padding:0 4px;border-radius:var(--dsw-radius-sm);background:rgba(0,0,0,.6);color:#fff;font-style:normal;font-size:10px;line-height:15px;}
.cw-step.active{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary) inset;}
.cw-step.empty{display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:11px;cursor:default;}
/* 输出：左图右日志 */
.cw-out{display:grid;grid-template-columns:minmax(180px,300px) minmax(0,1fr);gap:12px;align-items:start;}
@media(max-width:720px){.cw-out{grid-template-columns:1fr;}}
.cw-out-img{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow:hidden;background:var(--dsw-alias-bg-layer-2);height:220px;display:flex;align-items:center;justify-content:center;}
.cw-out-img img{display:block;width:100%;height:100%;object-fit:contain;cursor:zoom-in;}
.cw-out-img span{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:0 12px;text-align:center;line-height:1.7;}
.cw-log{box-sizing:border-box;width:100%;height:188px;resize:vertical;margin:0;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);font-size:11px;line-height:1.6;white-space:pre-wrap;overflow:auto;}
.cw-log mark{background:none;color:var(--dsw-alias-state-error-primary);}
.cw-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2);}
/* 放大输出：每张成品一格，点开进灯箱 */
.cw-ups{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;}
.cw-ups-item{margin:0;display:flex;flex-direction:column;gap:4px;min-width:0;}
.cw-ups-item img{display:block;width:100%;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);cursor:zoom-in;}
.cw-ups-item figcaption{font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;}
.cw-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);}
.cw-btn.danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent);}
.cw-toggle{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-tertiary);}
/* NSFW：缩略图先盖一层厚毛玻璃，点一下化开，再点才进大图 */
.cw-thumb-open>img{transition:filter .55s ease,transform .55s ease;}
.cw-thumb.is-nsfw .cw-thumb-open>img{filter:blur(16px) saturate(.82) brightness(.94);transform:scale(1.06);}
.cw-thumb.is-nsfw.revealed .cw-thumb-open>img{filter:none;transform:none;}
.cw-thumb span.cw-frost{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:0;background:linear-gradient(180deg,rgba(255,255,255,.22),rgba(120,132,152,.3));backdrop-filter:blur(22px) saturate(1.45);-webkit-backdrop-filter:blur(22px) saturate(1.45);opacity:1;transition:opacity .55s ease;}
.cw-thumb.is-nsfw.revealed .cw-frost{opacity:0;}
.cw-frost-tag{font-size:10px;letter-spacing:.14em;padding:2px 8px;border-radius:999px;background:rgba(0,0,0,.45);border:.5px solid rgba(255,255,255,.55);color:#fff;text-shadow:0 1px 6px rgba(0,0,0,.5);}
.cw-frost-hint{font-size:10px;opacity:.92;color:#fff;text-shadow:0 1px 8px rgba(0,0,0,.65);}
.cw-lightbox-wrap{position:relative;display:flex;align-items:center;justify-content:center;max-width:calc(100% - 260px);max-height:calc(100% - 40px);}
.cw-lightbox-wrap img{display:block;max-width:100%;max-height:100%;border-radius:var(--dsw-radius-md);box-shadow:0 12px 40px rgba(0,0,0,.5);transition:filter .6s ease;}
.cw-lightbox-wrap.masked img{filter:blur(24px) saturate(.85);}
.cw-lightbox-cover{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;border-radius:var(--dsw-radius-md);background:linear-gradient(180deg,rgba(255,255,255,.2),rgba(110,122,142,.32));backdrop-filter:blur(28px) saturate(1.5);-webkit-backdrop-filter:blur(28px) saturate(1.5);cursor:pointer;transition:opacity .6s ease;}
.cw-lightbox-cover.gone{opacity:0;pointer-events:none;}
/* ---- 模型库（Civitai）：第四页 ---- */
.cw-hub{display:grid;gap:12px;grid-template-columns:minmax(0,1fr);align-items:start;}
.cw-hub.with-drawer{grid-template-columns:minmax(0,1fr) 360px;}
@media (max-width:1120px){.cw-hub.with-drawer{grid-template-columns:minmax(0,1fr);}}
.cw-hub-main{display:flex;flex-direction:column;gap:10px;min-width:0;}
.cw-hub-src{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary);}
.cw-hub-src a{color:var(--dsw-alias-brand-primary);text-decoration:none;}
.cw-hub-src a:hover{text-decoration:underline;}
.cw-hub-keyrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.cw-hub-keyrow input[type=password]{flex:1 1 220px;min-width:140px;height:30px;padding:0 10px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;}
.cw-hub-state{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary);word-break:break-all;}
.cw-hub-state.ok{color:var(--dsw-alias-label-primary);}
.cw-hub-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
.cw-hub-filters select,.cw-hub-filters input[type=search]{height:28px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 8px;}
/* 大图网格：一屏铺得下 4–6 张卡，点开看详情 */
.cw-hub-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(176px,1fr));gap:12px;}
.cw-hub-tile{appearance:none;display:flex;flex-direction:column;padding:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);overflow:hidden;cursor:pointer;text-align:left;font:inherit;min-width:0;}
.cw-hub-tile:hover{border-color:var(--dsw-alias-brand-primary);}
.cw-hub-tile-cover{position:relative;width:100%;aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}
.cw-hub-tile-cover img{width:100%;height:100%;object-fit:cover;display:block;}
.cw-hub-tile-cover .ph{padding:0 10px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);text-align:center;}
.cw-hub-tile-body{display:flex;flex-direction:column;gap:4px;padding:8px 10px 10px;min-width:0;}
.cw-hub-tile-name{font-size:12px;font-weight:600;line-height:1.45;color:var(--dsw-alias-label-primary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;}
.cw-hub-tile-meta{display:flex;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary);}
/* 详情弹层：整屏遮罩 + 居中卡片，点遮罩 / 关闭退出 */
.cw-hub-detail{position:fixed;inset:0;z-index:70;display:flex;align-items:flex-start;justify-content:center;padding:36px 20px;background:rgba(0,0,0,.66);overflow:auto;}
.cw-hub-detail-card{box-sizing:border-box;width:min(940px,100%);display:flex;flex-direction:column;gap:12px;padding:16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);}
.cw-hub-detail-top{display:grid;grid-template-columns:minmax(0,230px) minmax(0,1fr);gap:16px;align-items:start;}
@media (max-width:760px){.cw-hub-detail-top{grid-template-columns:minmax(0,1fr);}}
.cw-hub-detail-cover{width:100%;aspect-ratio:3/4;border-radius:var(--dsw-radius-md);overflow:hidden;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center;}
.cw-hub-detail-cover img{width:100%;height:100%;object-fit:cover;display:block;}
.cw-hub-detail-info{display:flex;flex-direction:column;gap:8px;min-width:0;}
.cw-hub-desc{margin:0;padding:8px 10px;max-height:280px;overflow:auto;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:1.75;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;}
/* 模型助手已下线（2026-11-26）：文案改成自动翻译，对话相关样式一并清掉 */
.cw-hub-meta{display:flex;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary);}
.cw-hub-ver{border-top:.5px dashed var(--dsw-alias-border-l2);padding-top:6px;margin-top:2px;display:flex;flex-direction:column;gap:4px;}
.cw-hub-file{display:flex;align-items:center;gap:8px;font-size:12px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);}
.cw-hub-file .nm{flex:1 1 190px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cw-hub-file select{height:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;}
.cw-hub-foot{position:sticky;bottom:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary);}
.cw-hub-progress{width:100%;height:4px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden;}
.cw-hub-progress i{display:block;height:100%;background:var(--dsw-alias-label-primary);}
/* 自动翻译后的原文小字 / 详情译文头 / 进度条 */
.cw-hub-tile-en{font-size:10px;line-height:1.4;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cw-hub-desc-head{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);}
.cw-hub-desc-head .cw-btn{height:22px;padding:0 8px;font-size:11px;line-height:20px;}
.cw-hub-foot-bar{flex:1 1 100%;height:3px;}
.cw-hub-item-bar{flex:1 1 100%;height:3px;margin-top:2px;}
.cw-hub-drawer{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);padding:10px;display:flex;flex-direction:column;gap:8px;align-self:start;position:sticky;top:8px;max-height:calc(100vh - 200px);overflow:auto;}
.cw-hub-drawer h3{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}
.cw-hub-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);}
.cw-hub-badge.yes{color:#3fa45b;border-color:#3fa45b;}
.cw-hub-badge.no{color:#d9534f;border-color:#d9534f;}
.cw-hub-advice{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:1.75;color:var(--dsw-alias-label-secondary);word-break:break-word;}
.cw-hub-advice b{color:var(--dsw-alias-label-primary);font-weight:600;}
.cw-hub-actions{display:flex;gap:6px;flex-wrap:wrap;}
.cw-hub-note{margin:0;font-size:11px;line-height:1.7;color:var(--dsw-alias-label-tertiary);word-break:break-all;}
`

    let cssHandle = null
    function ensureCss() {
      if (cssHandle !== null) return
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', 'dsh-comfy-workbench')
      style.textContent = CSS
      document.head.appendChild(style)
      cssHandle = style
    }

    // ------------------------------------------------------------- 组件

    function Glyph({ size }) {
      const s = typeof size === 'number' && size > 0 ? size : 18
      return h('svg', {
        width: s, height: s, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', 'data-comfy-glyph': true,
      }, [
        h('path', { key: 'box', d: 'M2.5 5.5h11v8h-11z' }),
        h('path', { key: 'lid', d: 'M2 5.5 8 2l6 3.5' }),
        h('path', { key: 'spark', d: 'M8 7.6l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1L5 11.5l2.1-.9z' }),
      ])
    }

    /** 小工具：把 catch 到的东西变成一句人话。 */
    function describe(error) {
      if (!error) return '未知错误'
      if (typeof error === 'string') return error
      const code = error.code ? '[' + error.code + '] ' : ''
      return code + (error.message || String(error))
    }

    function Msg({ kind, children }) {
      if (!children) return null
      return h('p', { className: 'cw-note' + (kind ? ' ' + kind : '') }, children)
    }

    /** 每次点击换一个 token：宿主半按它管生命周期，「取消」靠它定位。 */
    function makeToken() {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
      } catch {
        /* 老浏览器没有 randomUUID */
      }
      return 'rw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    }

    /**
     * busy 时的「深度求索中」贴纸。
     * GIF 在 C:\DSH 根目录、不在插件包里，所以走同源路由；读不到就退成三点动画，按钮不塌。
     */
    function ThinkIcon({ src, phase }) {
      const [broken, setBroken] = useState(false)
      useEffect(() => { setBroken(false) }, [src])
      const dots = h('span', { key: 'dots', className: 'cw-think-dots' }, [
        h('i', { key: 'a' }), h('i', { key: 'b' }), h('i', { key: 'c' }),
      ])
      const gif = broken || typeof src !== 'string' || src.length === 0
        ? null
        : h('img', {
          key: 'gif',
          className: 'cw-think-gif',
          src,
          alt: '深度求索中',
          draggable: false,
          onError: () => setBroken(true),
        })
      return h('span', { className: 'cw-think' }, [
        h('span', { key: 'box', className: 'cw-think-sticker' }, [gif === null ? dots : gif]),
        phase ? h('span', { key: 'label', className: 'cw-think-label' }, phase) : null,
      ])
    }

    function Fact({ label, value, mono }) {
      return h('div', null, [h('dt', { key: 'k' }, label), h('dd', { key: 'v', className: mono ? 'cw-path' : undefined }, value)])
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '—'
      if (bytes < 1024) return bytes + ' B'
      const units = ['KB', 'MB', 'GB']
      let value = bytes / 1024
      let index = 0
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index += 1
      }
      return value.toFixed(value >= 10 ? 0 : 1) + ' ' + units[index]
    }

    /** 自动分桶的预览：源/年-月。口径跟宿主 api.js 的 autoOutputFolder 一致。 */
    function autoFolderHint(workflowId) {
      const prefix = typeof workflowId === 'string' && workflowId.includes('__')
        ? workflowId.slice(0, workflowId.indexOf('__'))
        : ''
      const bucket = /^[a-z0-9][a-z0-9-]*$/i.test(prefix) ? prefix.toLowerCase() : 'misc'
      const now = new Date()
      return bucket + '/' + now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
    }

    function formatTime(ms) {
      if (!Number.isFinite(ms)) return '—'
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    function formatClock(ms) {
      if (!Number.isFinite(ms)) return '--:--:--'
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    /** release 标题是上游英文，界面按中文习惯转一下；认不出的部分原样保留。 */
    function releaseTitle(release) {
      const raw = String(release?.title ?? '').trim()
      if (raw.length === 0) return 'MOSS 角色画风图库'
      return raw
        .replace(/([\d,]+)\s*samples/i, '$1 张样本')
        .replace(/\(Classic Cartoon update\)/i, '（经典卡通更新）')
        .replace(/\(([A-Za-z ]+) update\)/i, '（$1 更新）')
    }

    /** 合并增量预览：同一任务按步去重，换任务就整份替换。 */
    function mergePreview(previous, next) {
      if (previous === null || previous.promptId !== next.promptId) return next
      const byStep = new Map((previous.steps ?? []).map((frame) => [frame.step, frame]))
      for (const frame of next.steps ?? []) byStep.set(frame.step, frame)
      return { ...next, steps: [...byStep.values()].sort((a, b) => a.step - b.step) }
    }

    /** 任务状态的中文标签——界面上一律用这个，不直接显示英文枚举。 */
    const STATE_LABELS = {
      idle: '空闲',
      connecting: '连接中',
      queued: '排队中',
      running: '生成中',
      done: '已完成',
      failed: '失败',
      interrupted: '已停止',
      missing: '已丢失',
      'service-lost': '服务断开',
      timeout: '超时',
      unknown: '未知',
    }

    function stateLabel(value) {
      return STATE_LABELS[String(value ?? '')] ?? '未知'
    }

    /** 日志事件类型的中文标签。 */
    const KIND_LABELS = { info: '信息', exec: '执行', step: '步进', warn: '警告', error: '错误' }

    function kindLabel(value) {
      return KIND_LABELS[String(value ?? '')] ?? '信息'
    }

    /** 把事件列表拼成输出框文本：`HH:mm:ss 类型 内容`。 */
    function logText(events) {
      return (Array.isArray(events) ? events : [])
        .map((line) => formatClock(line.at) + ' ' + kindLabel(line.kind) + ' ' + line.text)
        .join('\n')
    }

    /** 浏览器下载：插件不写盘，交给宿主下载机制。 */
    function downloadFromUrl(url, name) {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name || 'comfy.png'
      anchor.rel = 'noreferrer'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      return '已交给浏览器下载：' + (name || 'comfy.png')
    }

    /**
     * 复制图片位图：先转 PNG（Windows 剪贴板对 webp/jpeg 的 ClipboardItem 不稳），
     * 大图等比缩到 2048；不支持时降级为复制图片地址。
     * @returns 给用户看的一句话。
     */
    async function copyImageFromUrl(url) {
      const absolute = new URL(url, window.location.href).href
      const response = await fetch(url, { credentials: 'same-origin' })
      if (!response.ok) throw new Error('取图失败：HTTP ' + response.status)
      const blob = await response.blob()
      const bitmap = await createImageBitmap(blob)
      const max = 2048
      const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext('2d')
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const png = await new Promise((resolve) => canvas.toBlob((value) => resolve(value), 'image/png'))
      const shrunk = scale < 1 ? '（已缩小到 2048px）' : ''
      if (png === null || typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
        await navigator.clipboard?.writeText?.(absolute)
        return '当前宿主不支持复制图片位图，已复制图片地址'
      }
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
        return '已复制到剪贴板' + shrunk
      } catch {
        await navigator.clipboard.writeText(absolute)
        return '剪贴板拒绝写入图片，已复制图片地址'
      }
    }

    /** NSFW 揭开后多久自动盖回去（毫秒）。 */
    const NSFW_REVEAL_MS = 5000

    /** 自动补扫 NSFW 一轮进程只跑一次：反复切标签页不该每次都拉起打标器。 */
    let nsfwAutoStartedOnce = false

    /** 缩略图：加载失败时留一个占位，不让网格塌；画风样张多一个「套用画风」。 */
    function Thumb({ item, onOpen, onUse }) {
      const label = item.displayName ?? item.name
      const flagged = item.nsfw === true
      const [revealed, setRevealed] = useState(false)
      // 揭开只给 5 秒：到点自动盖回去，人走开也不留在那儿
      useEffect(() => {
        if (!revealed) return undefined
        const timer = setTimeout(() => setRevealed(false), NSFW_REVEAL_MS)
        return () => clearTimeout(timer)
      }, [revealed])
      return h('div', {
        className: 'cw-thumb' + (flagged ? ' is-nsfw' : '') + (flagged && revealed ? ' revealed' : ''),
        title: item.rel,
      }, [
        h('button', {
          key: 'open',
          className: 'cw-thumb-open',
          type: 'button',
          onClick: () => {
            // 毛玻璃还在时，第一下只揭开，不直接弹大图
            if (flagged && !revealed) {
              setRevealed(true)
              return
            }
            onOpen(item)
          },
        }, [
          // 网格用 320 px 缩略图；生成失败时退回原图，不让格子空着。
          h('img', {
            key: 'i',
            src: item.thumb ?? item.url,
            alt: label,
            loading: 'lazy',
            decoding: 'async',
            onError: (event) => {
              const image = event.currentTarget
              if (item.url && image.dataset.fallback !== '1') {
                image.dataset.fallback = '1'
                image.src = item.url
              }
            },
          }),
          flagged
            ? h('span', { key: 'frost', className: 'cw-frost' }, [
              h('div', { key: 't', className: 'cw-frost-tag' }, 'NSFW'),
              h('div', { key: 'h', className: 'cw-frost-hint' }, '点击化开 · 5 秒后自动盖上'),
            ])
            : null,
          h('span', { key: 'n' }, label),
        ]),
        onUse === undefined ? null : h('button', {
          key: 'use',
          className: 'cw-thumb-use',
          type: 'button',
          onClick: (event) => {
            event.stopPropagation()
            onUse(item)
          },
        }, '套用画风'),
      ])
    }

    function FolderChips({ folders, active, total, onPick }) {
      return h('div', { className: 'cw-folders' }, [
        h('button', {
          key: '__all__',
          className: 'cw-folder' + (active === '' ? ' active' : ''),
          type: 'button',
          onClick: () => onPick(''),
        }, ['全部', h('span', { className: 'n', key: 'n' }, ' · ' + total)]),
      ].concat(folders.map((folder) => h('button', {
        key: folder.id,
        className: 'cw-folder' + (active === folder.id ? ' active' : ''),
        type: 'button',
        title: folder.name,
        onClick: () => onPick(folder.id),
      }, [
        h('span', { key: 'n', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, folder.name),
        h('span', { className: 'n', key: 'c' }, ' · ' + folder.count),
      ]))))
    }

    function Lightbox({ item, onClose, onUse, onSave, onCopy }) {
      const [clear, setClear] = useState(false)
      // 换一张就重新盖上，别把上一张的「已揭开」带过来
      useEffect(() => { setClear(false) }, [item?.rel])
      // 大图也一样：化开 5 秒自动盖回去
      useEffect(() => {
        if (!clear) return undefined
        const timer = setTimeout(() => setClear(false), NSFW_REVEAL_MS)
        return () => clearTimeout(timer)
      }, [clear])
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      if (!item) return null
      const label = item.displayName ?? item.name
      const prompt = typeof item.prompt === 'string' ? item.prompt : ''
      const flagged = item.nsfw === true
      return h('div', { className: 'cw-lightbox', onClick: onClose }, [
        h('div', {
          key: 'wrap',
          className: 'cw-lightbox-wrap' + (flagged && !clear ? ' masked' : ''),
          onClick: (event) => event.stopPropagation(),
        }, [
          h('img', { key: 'img', src: item.url, alt: label }),
          flagged && !clear
            ? h('div', {
              key: 'cover',
              className: 'cw-lightbox-cover',
              onClick: () => setClear(true),
            }, [
              h('div', { key: 't', className: 'cw-frost-tag' }, 'NSFW'),
              h('div', { key: 'h', className: 'cw-frost-hint' }, '点击化开毛玻璃 · 5 秒后自动盖上'),
            ])
            : null,
        ]),
        h('div', { className: 'cw-lightbox-info', key: 'info', onClick: (event) => event.stopPropagation() }, [
          h('div', { key: 'n', style: { fontWeight: 600, marginBottom: '6px' } }, label),
          item.nsfw === true
            ? h('div', { key: 'nf', className: 'cw-chip', style: { marginBottom: '6px' } }, 'NSFW · 置信 ' + Math.round(Number(item.nsfwScore ?? 0) * 100) + '%')
            : null,
          item.kind
            ? h('div', { key: 'k', style: { opacity: .85 } }, (item.kind === 'style' ? '画风' : '角色') + (item.category ? ' · ' + item.category : ''))
            : null,
          item.tags ? h('div', { key: 't', className: 'cw-path', style: { marginTop: '4px', opacity: .75 } }, item.tags) : null,
          h('div', { key: 'f', className: 'cw-path' }, item.folder.length > 0 ? item.folder : '（根目录）'),
          h('div', { key: 's', style: { marginTop: '6px' } }, formatBytes(item.size) + ' · ' + formatTime(item.mtime)),
          h('div', { key: 'r', className: 'cw-path', style: { marginTop: '6px', opacity: .7 } }, item.rel),
          prompt.length > 0
            ? h('div', { key: 'p', style: { marginTop: '8px', maxHeight: '32vh', overflow: 'auto', lineHeight: 1.6 } }, prompt)
            : null,
          onSave === undefined && onCopy === undefined
            ? null
            : h('div', { key: 'ops', className: 'cw-row', style: { marginTop: '10px' } }, [
              onSave === undefined ? null : h('button', {
                key: 'save',
                className: 'cw-btn',
                type: 'button',
                onClick: () => onSave(item),
              }, '保存图像'),
              onCopy === undefined ? null : h('button', {
                key: 'copy',
                className: 'cw-btn',
                type: 'button',
                onClick: () => onCopy(item),
              }, '复制图像'),
            ]),
          onUse === undefined ? null : h('button', {
            key: 'use',
            className: 'cw-btn primary',
            type: 'button',
            style: { marginTop: '10px', width: '100%' },
            onClick: () => onUse(item),
          }, '套用这个画风'),
          h('div', { key: 'h', style: { marginTop: '10px', opacity: .6 } }, '点背景或按 Esc 关闭'),
        ]),
      ])
    }

    /** 画风图库缺包时的说明卡：release 事实 + 下载直链 + 绑定。 */
    function ReleaseCard({ data, onBind, busy }) {
      const release = data.release ?? {}
      return h('div', { className: 'cw-card cw-release' }, [
        h('h4', { key: 't' }, releaseTitle(release)),
        h(Msg, { key: 'n' }, data.note),
        h('dl', { className: 'cw-facts', key: 'f' }, [
          h(Fact, { key: 'c', label: '规模', value: (release.characters ?? '?').toLocaleString('zh-CN') + ' 角色 + ' + (release.styles ?? '?') + ' 画风 = ' + (release.images ?? '?').toLocaleString('zh-CN') + ' 张' }),
          h(Fact, { key: 's', label: '主 ZIP', value: (release.sizeText ?? '—') + '（' + (release.bytes ?? 0).toLocaleString('zh-CN') + ' 字节）' }),
          h(Fact, { key: 'h', label: 'SHA256', value: release.sha256 ?? '—', mono: true }),
          h(Fact, { key: 'p', label: '目标路径', value: (data.root ?? '') || 'C:\\Moss本地画风库', mono: true }),
        ]),
        h('div', { className: 'cw-row', key: 'a' }, [
          release.zipUrl
            ? h('a', { className: 'cw-btn primary', href: release.zipUrl, target: '_blank', rel: 'noreferrer', key: 'dl' }, '下载完整 ZIP ↗')
            : null,
          h('button', { className: 'cw-btn', key: 'b', disabled: busy, onClick: onBind }, busy ? '绑定中…' : '绑定本地目录'),
        ]),
        Array.isArray(data.steps) && data.steps.length > 0
          ? h('div', { key: 'st' }, [
            h('p', { className: 'cw-empty', key: 'h' }, '落地步骤（本插件不会自己下载 2 GB）：'),
            ...data.steps.map((step, index) => h('p', { className: 'cw-empty cw-path', key: 's' + index }, (index + 1) + '. ' + step)),
          ])
          : null,
      ])
    }

    /**
     * 图库面板：我的图库（source=output）与画风图库（source=catalog）共用。
     * @param props - `{ source, onPickFolder, onApplyStyle }`；onApplyStyle 只在画风图库给。
     */
    function LibraryPane({ source, onPickFolder, onApplyStyle }) {
      const isCatalog = source === 'catalog'
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [folder, setFolder] = useState('')
      const [query, setQuery] = useState('')
      const [draftQuery, setDraftQuery] = useState('')
      const [open, setOpen] = useState(null)
      const [bindBusy, setBindBusy] = useState(false)
      const [showApp, setShowApp] = useState(false)
      const [kind, setKind] = useState('')
      const [category, setCategory] = useState('')
      /** 只看哪个等级的：'' 全部 / 'safe' 常规 / 'nsfw' 标红的 */
      const [verdict, setVerdict] = useState('')
      /** 打标进度：{ busy, text } */
      const [scan, setScan] = useState(null)
      const scanRunRef = useRef(false)
      const autoScanRef = useRef(false)
      /** 后台补扫重取次数：最多追三次，免得刷新死循环 */
      const refreshRetryRef = useRef(0)
      const call = useCallback((method, args) => bridge.call(method, args), [])
      const method = isCatalog ? 'catalog' : 'gallery'

      const load = useCallback(async (options = {}) => {
        setLoading(true)
        setError(null)
        try {
          const next = await call(method, {
            folder: options.folder ?? folder,
            query: options.query ?? query,
            limit: 60,
            cursor: options.cursor ?? 0,
            refresh: options.refresh === true,
            kind: options.kind ?? kind,
            category: options.category ?? category,
            nsfw: options.verdict ?? verdict,
          })
          if ((options.cursor ?? 0) > 0 && data && Array.isArray(data.images)) {
            setData({ ...next, images: [...data.images, ...next.images] })
          } else {
            setData(next)
            // 宿主正在后台补扫：过一秒自动再取一次，列表自己长出新图，不用手点刷新
            if (next?.refreshing === true) {
              if (refreshRetryRef.current < 3) {
                refreshRetryRef.current += 1
                window.setTimeout(() => { void load({ cursor: 0 }) }, 1200)
              }
            } else {
              refreshRetryRef.current = 0
            }
          }
        } catch (failure) {
          setError(describe(failure))
        } finally {
          setLoading(false)
        }
      }, [call, method, folder, query, data, kind, category, verdict])

      useEffect(() => {
        void load({ cursor: 0 })
        // 只在切换标签页时重新加载，folder/query 变化走各自的处理函数。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [isCatalog])

      const pickFolder = (next) => {
        setFolder(next)
        onPickFolder?.(next)
        void load({ folder: next, cursor: 0 })
      }

      const bind = async () => {
        setBindBusy(true)
        setError(null)
        try {
          const ui = bridge.ctx?.get?.('uiWorkspace')
          if (!ui || typeof ui.pickDirectory !== 'function') throw new Error('宿主没有 uiWorkspace 服务，无法选目录')
          const picked = await ui.pickDirectory()
          if (picked === null || picked === undefined) return
          const result = await call('catalogBind', { path: picked })
          setData(null)
          await load({ cursor: 0, refresh: true })
          if (result?.note) setError(result.note)
        } catch (failure) {
          setError(describe(failure))
        } finally {
          setBindBusy(false)
        }
      }

      const found = isCatalog ? data?.found === true : true
      const images = data?.images ?? []
      const folders = data?.folders ?? []
      // 这个图库把每张样本放在单独目录（app/outputs/user_items/<hash>/），
      // 文件夹约等于图片数时，分类没有语义——只留「全部」并明说。
      const degenerate = (data?.folderTotal ?? 0) >= Math.max(20, (data?.total ?? 0) * 0.9)
      // 画风图库的清单（user_catalog.json）在，才会有类型 / 分类两个筛选条。
      const kindCounts = data?.kindCounts ?? null
      const kindChips = kindCounts === null
        ? []
        : [
          { value: '', label: '全部', count: kindCounts.all ?? 0 },
          { value: 'style', label: '画风', count: kindCounts.style ?? 0 },
          { value: 'character', label: '角色', count: kindCounts.character ?? 0 },
        ]
      const applyKind = (next) => {
        setKind(next)
        setCategory('')
        void load({ kind: next, category: '', cursor: 0 })
      }
      const applyCategory = (next) => {
        setCategory(next)
        void load({ category: next, cursor: 0 })
      }
      const applyVerdict = (next) => {
        setVerdict(next)
        void load({ verdict: next, cursor: 0 })
      }

      /**
       * 分批打标：每轮 6 张。打标器一张约 3 秒，一轮约 20 秒，
       * 拿回来就刷一次列表——先标好的先盖上毛玻璃，不用等全扫完。
       */
      const runScan = useCallback(async (budget = 400) => {
        if (scanRunRef.current) return
        scanRunRef.current = true
        setScan({ busy: true, text: '正在加载打标器（首次约 5 秒）…' })
        try {
          for (let round = 0; round < budget; round += 1) {
            const result = await call('nsfwScan', { limit: 6 })
            if (result?.ok !== true) {
              setScan({ busy: false, text: result?.reason ?? '打标器不可用' })
              return
            }
            const counts = result.counts ?? {}
            setScan({
              busy: (counts.unknown ?? 0) > 0,
              text: '已识别 ' + (counts.scanned ?? 0) + ' / ' + (counts.total ?? 0) + ' 张 · NSFW ' + (counts.nsfw ?? 0) + ' 张',
            })
            if (Array.isArray(result.failures) && result.failures.length > 0) {
              setScan({ busy: false, text: '打标器出错：' + result.failures[0] })
              return
            }
            if ((counts.unknown ?? 0) === 0) break
            if ((result.scanned ?? 0) === 0) break
          }
        } catch (failure) {
          setScan({ busy: false, text: describe(failure) })
        } finally {
          scanRunRef.current = false
          void load({ cursor: 0 })
        }
      }, [call, load])

      // 打开「我的图库」自动补一小批；整个进程只跑一次，反复切页不再重新拉起打标器。
      useEffect(() => {
        if (isCatalog || data === null || autoScanRef.current) return
        if (nsfwAutoStartedOnce) return
        if (data.nsfwEngine?.ready !== true) return
        if ((data.nsfwCounts?.unknown ?? 0) === 0) return
        autoScanRef.current = true
        nsfwAutoStartedOnce = true
        // 先让缩略图落地，8 秒后再补一轮（6 张，约 18 秒 CPU）；
        // 原来一进来就补 36 张、打标器每张 3 秒，等于开图库先满载两分钟。
        // 剩下的点「识别 NSFW」按钮再继续。
        window.setTimeout(() => { void runScan(1) }, 8000)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [data, isCatalog])

      if (error && data === null) return h('div', { className: 'cw-card' }, [h(Msg, { kind: 'error', key: 'e' }, error)])
      if (data === null) {
        return h('div', { className: 'cw-card' }, [
          h('p', { className: 'cw-empty', key: 'p' }, loading
            ? (isCatalog ? '读取中…（画风库 34,709 张，首次扫描约 2 秒，之后读盘 0.2 秒）' : '读取中…')
            : '还没有数据'),
        ])
      }

      if (isCatalog && !found) {
        return h('div', { className: 'cw-card' }, [
          h(ReleaseCard, { key: 'r', data, onBind: bind, busy: bindBusy }),
          error ? h(Msg, { kind: 'error', key: 'e' }, error) : null,
        ])
      }

      return h('div', { className: 'cw-card', key: 'lib' }, [
        h('div', { className: 'cw-card-head', key: 'head' }, [
          h('h3', { className: 'cw-card-title', key: 't' }, isCatalog ? '画风图库' : '我的图库'),
          h('span', { className: 'cw-chip', key: 'c' }, (data.matched ?? 0).toLocaleString('zh-CN') + ' / ' + (data.total ?? 0).toLocaleString('zh-CN') + ' 张 · ' + folders.length + ' 个文件夹'),
          h('span', { className: 'cw-spacer', key: 'sp' }),
          isCatalog && data.app
            ? h('button', { className: 'cw-btn', key: 'app', onClick: () => setShowApp((current) => !current) }, showApp ? '收起官方应用' : '内嵌官方应用')
            : null,
          h('button', { className: 'cw-btn', key: 'r', disabled: loading, onClick: () => { void load({ cursor: 0, refresh: true }) } }, loading ? '读取中…' : '刷新'),
        ]),
        h('div', { className: 'cw-toolbar', key: 'tools' }, [
          h('input', {
            className: 'cw-input cw-search',
            placeholder: '搜文件名或路径',
            value: draftQuery,
            onChange: (event) => setDraftQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              setQuery(draftQuery)
              void load({ query: draftQuery, cursor: 0 })
            },
          }),
          h('button', {
            className: 'cw-btn',
            onClick: () => {
              setQuery(draftQuery)
              void load({ query: draftQuery, cursor: 0 })
            },
          }, '搜索'),
          query.length > 0
            ? h('button', {
              className: 'cw-btn',
              onClick: () => {
                setDraftQuery('')
                setQuery('')
                void load({ query: '', cursor: 0 })
              },
            }, '清空')
            : null,
          h('span', { className: 'cw-label' }, isCatalog ? (data.sourceOfRoot === 'config' ? '已绑定' : '自动探测') : (data.root ?? '')),
          h('span', { className: 'cw-spacer' }),
          h('span', { className: 'cw-label' }, '当前分类：' + (folder.length > 0 ? folder : '全部') + (isCatalog ? '' : '（生图默认归入这里）')),
        ]),
        isCatalog
          ? null
          : h('div', { className: 'cw-row', key: 'verdict' }, [
            h('span', { className: 'cw-label', key: 'l' }, 'NSFW'),
            ...[
              { value: '', label: '全部', count: data.nsfwCounts?.total ?? 0 },
              { value: 'safe', label: '常规', count: data.nsfwCounts?.safe ?? 0 },
              { value: 'nsfw', label: 'NSFW', count: data.nsfwCounts?.nsfw ?? 0 },
            ].map((chip) => h('button', {
              key: chip.value === '' ? 'all' : chip.value,
              className: 'cw-folder' + (verdict === chip.value ? ' active' : ''),
              type: 'button',
              title: '只看' + chip.label,
              onClick: () => applyVerdict(chip.value),
            }, [
              h('span', { key: 'n' }, chip.label),
              h('span', { className: 'n', key: 'c' }, ' · ' + chip.count),
            ])),
            h('span', { className: 'cw-spacer', key: 'sp' }),
            (data.nsfwCounts?.unknown ?? 0) > 0 || scan !== null
              ? h('button', {
                className: 'cw-btn',
                key: 'scan',
                type: 'button',
                disabled: scan?.busy === true,
                onClick: () => { void runScan(400) },
              }, scan?.busy === true
                ? '识别中…'
                : (data.nsfwCounts?.unknown ?? 0) > 0
                  ? '识别 NSFW（还剩 ' + (data.nsfwCounts?.unknown ?? 0) + ' 张）'
                  : '全部识别完' + (scan?.text ? ' · 点我再跑一遍' : ''))
              : h('span', { className: 'cw-label', key: 'done' }, '打标器：' + (data.nsfwEngine?.name ?? '—') + (data.nsfwEngine?.ready === true ? '' : '（不可用）')),
            scan === null || scan.busy === true ? null : h('span', { className: 'cw-chip', key: 'st' }, scan.text),
          ]),
        isCatalog
          ? null
          : (data.nsfwEngine?.ready === false
            ? h(Msg, { kind: 'error', key: 'nfwhy' }, 'NSFW 识别不可用：' + (data.nsfwEngine?.reason ?? '原因不明'))
            : null),
        isCatalog && kindChips.length > 0
          ? h('div', { className: 'cw-row', key: 'kinds' }, [
            h('span', { className: 'cw-label', key: 'l' }, '类型'),
            ...kindChips.map((chip) => h('button', {
              key: chip.value,
              className: 'cw-folder' + (kind === chip.value ? ' active' : ''),
              type: 'button',
              onClick: () => applyKind(chip.value),
            }, [h('span', { key: 'n' }, chip.label), h('span', { className: 'n', key: 'c' }, ' · ' + chip.count.toLocaleString('zh-CN'))])),
          ])
          : null,
        isCatalog && kind !== 'character' && Array.isArray(data.categories) && data.categories.length > 0
          ? h('div', { className: 'cw-row', key: 'cats' }, [
            h('span', { className: 'cw-label', key: 'l' }, '画风分类'),
            h('button', {
              key: '__all__',
              className: 'cw-folder' + (category === '' ? ' active' : ''),
              type: 'button',
              onClick: () => applyCategory(''),
            }, '全部'),
            ...data.categories.map((entry) => h('button', {
              key: entry.id,
              className: 'cw-folder' + (category === entry.label ? ' active' : ''),
              type: 'button',
              title: entry.label,
              onClick: () => applyCategory(entry.label),
            }, [h('span', { key: 'n' }, entry.label), h('span', { className: 'n', key: 'c' }, ' · ' + entry.count)])),
          ])
          : null,
        degenerate ? null : h(FolderChips, { key: 'folders', folders, active: folder, total: data.total ?? 0, onPick: pickFolder }),
        degenerate
          ? h('p', { className: 'cw-empty', key: 'degenerate' }, '这个图库把每张样本放在单独目录里（' + (data.folderTotal ?? 0).toLocaleString('zh-CN') + ' 个文件夹 / ' + (data.total ?? 0).toLocaleString('zh-CN') + ' 张图），按文件夹分组没有语义，所以不分栏；用上面的搜索框按文件名或路径找。')
          : null,
        images.length === 0
          ? h('p', { className: 'cw-empty', key: 'none' }, loading ? '读取中…' : '这个筛选条件下没有图片')
          : h('div', { className: 'cw-thumbs', key: 'grid' }, images.map((item) => h(Thumb, {
            key: item.rel,
            item,
            onOpen: setOpen,
            onUse: isCatalog && onApplyStyle !== undefined && item.kind === 'style' ? onApplyStyle : undefined,
          }))),
        h('div', { className: 'cw-row', key: 'more' }, [
          data.nextCursor === null || data.nextCursor === undefined
            ? h('span', { className: 'cw-label' }, '已经到底了')
            : h('button', { className: 'cw-btn', disabled: loading, onClick: () => { void load({ cursor: data.nextCursor }) } }, loading ? '加载中…' : '加载更多（还有 ' + Math.max((data.matched ?? 0) - images.length, 0) + ' 张）'),
          data.truncated ? h('span', { className: 'cw-chip', key: 'tr' }, '命中扫描上限 40,000，只显示前一批') : null,
          h('span', { className: 'cw-spacer', key: 'sp' }),
          h('span', { className: 'cw-label', key: 'ts' }, '扫描于 ' + formatTime(data.scannedAt) + (data.stale === true ? (data.refreshing === true ? ' · 后台更新中…' : ' · 已过期') : '')),
        ]),
        error ? h(Msg, { kind: 'error', key: 'err' }, error) : null,
        notice ? h(Msg, { kind: 'ok', key: 'ok' }, notice) : null,
        isCatalog && data.note ? h('p', { className: 'cw-empty', key: 'note' }, data.note) : null,
        isCatalog && data.indexAvailable === false && data.indexNote
          ? h('p', { className: 'cw-empty', key: 'noindex' }, '清单没读到，画风名与分类用不上：' + data.indexNote)
          : null,
        isCatalog && data.app === null && data.found
          ? h('p', { className: 'cw-empty', key: 'noapp' }, '这份 release 里没有静态 index.html：官方应用是 Python 本地服务（tools/launch_catalog.py），插件不代跑，这里只给只读网格。')
          : null,
        showApp && data.app
          ? h('iframe', { className: 'cw-iframe', key: 'iframe', src: data.app.url, title: 'MOSS 画风图库官方应用' })
          : null,
        h(Lightbox, {
          key: 'lightbox',
          item: open,
          onClose: () => setOpen(null),
          onUse: isCatalog && onApplyStyle !== undefined && open?.kind === 'style' ? onApplyStyle : undefined,
          onSave: open === null ? undefined : () => {
            void (async () => {
              try {
                if (isCatalog) {
                  // 画风库不在输出目录里，走浏览器下载；插件不代写盘。
                  setNotice(downloadFromUrl(open.url, open.name))
                  return
                }
                const saved = await call('saveImage', { rel: open.rel })
                setNotice('已存到工作区：' + saved.path)
              } catch (failure) {
                setError(describe(failure))
              }
            })()
          },
          onCopy: open === null ? undefined : () => {
            void (async () => {
              try {
                setNotice(await copyImageFromUrl(open.url))
              } catch (failure) {
                setError(describe(failure))
              }
            })()
          },
        }),
      ])
    }

    /**
     * 逐步预览卡片：缩略图网格 + 当前步高亮 + 开关。
     * 帧只在宿主内存里，卡片里明说「仅本次生成有效」。
     */
    function StepPreview({ preview, enabled, steps, total, current, note, dropped, onOpenStep, onToggle, onClear, busy }) {
      const frames = preview?.steps ?? []
      const currentStep = preview?.current ?? current ?? 0
      const totalSteps = preview?.total ?? total ?? 0
      const stateText = preview === null ? '还没有帧' : stateLabel(preview.state)
      return h('div', { className: 'cw-card', key: 'steps' }, [
        h('div', { className: 'cw-card-head', key: 'h' }, [
          h('h3', { className: 'cw-card-title', key: 't' }, '逐步预览'),
          h('span', { className: 'cw-chip', key: 'c' }, totalSteps > 0 ? currentStep + ' / ' + totalSteps + ' 步' : stateText),
          h('span', { className: 'cw-spacer', key: 'sp' }),
          h('label', { className: 'cw-toggle', key: 'tg' }, [
            h('span', { key: 'l' }, '预览'),
            h('select', {
              className: 'cw-select', key: 's', value: enabled ? (preview?.previewMethod ?? 'latent2rgb') : 'none',
              onChange: (event) => onToggle(event.target.value),
            }, [
              h('option', { key: 'n', value: 'none' }, '关闭'),
              h('option', { key: 'l2r', value: 'latent2rgb' }, '近似色彩（latent2rgb）'),
              h('option', { key: 't', value: 'taesd' }, 'TAESD（需权重）'),
            ]),
          ]),
          h('button', { className: 'cw-btn', key: 'clr', disabled: busy || frames.length === 0, onClick: onClear }, '清空'),
        ]),
        frames.length === 0
          ? h('p', { className: 'cw-empty', key: 'none' }, enabled
            ? (preview?.state === 'running' ? '等待第一帧…采样开始后每步一张。' : '还没有预览帧：出图后这里会按步显示。')
            : '预览已关闭，本次只轮询成品图。')
          : h('div', { className: 'cw-steps', key: 'grid' }, frames.map((frame) => h('button', {
            key: frame.step,
            className: 'cw-step' + (frame.step === currentStep ? ' active' : ''),
            type: 'button',
            title: '第 ' + frame.step + ' 步 · 节点 ' + (frame.node ?? '?'),
            onClick: () => onOpenStep(frame),
          }, [
            h('img', { key: 'i', src: frame.url, alt: '第 ' + frame.step + ' 步', loading: 'lazy' }),
            h('em', { key: 'n' }, frame.step),
          ]))),
        h('p', { className: 'cw-empty', key: 'note' }, [
          note ? note + ' ' : '',
          dropped > 0 ? '丢了 ' + dropped + ' 帧（步号不连续属正常）。' : '',
          ' 只在本次生成期间有效、不写盘，重开页面即丢（当前保留 ' + frames.length + ' 帧）。',
        ].join('')),
      ])
    }

    /**
     * 输出卡片：左成品图 + 右只读日志，底部一排操作。
     * 按钮可用性只按状态判定，不给灰按钮配猜测逻辑。
     */
    function OutputPane({ job, events, logRef, paused, onTogglePause, onStop, onDownload, onSaveToWorkspace, onCopyImage, onCopyLog, onOpenImage, busy, canStop, canSave }) {
      const images = job?.images ?? []
      const first = images[0] ?? null
      const text = logText(events)
      return h('div', { className: 'cw-card', key: 'output' }, [
        h('div', { className: 'cw-card-head', key: 'h' }, [
          h('h3', { className: 'cw-card-title', key: 't' }, '输出'),
          h('span', { className: 'cw-chip', key: 's' }, stateLabel(job?.state)),
          job?.promptId ? h('span', { className: 'cw-path', key: 'p' }, job.promptId.slice(0, 12)) : null,
          h('span', { className: 'cw-spacer', key: 'sp' }),
          h('label', { className: 'cw-toggle', key: 'pause' }, [
            h('input', { type: 'checkbox', key: 'c', checked: paused, onChange: onTogglePause }),
            h('span', { key: 'l' }, '暂停跟随'),
          ]),
          h('button', { className: 'cw-btn', key: 'copy', disabled: text.length === 0, onClick: onCopyLog }, '复制日志'),
        ]),
        h('div', { className: 'cw-out', key: 'body' }, [
          h('div', { className: 'cw-out-img', key: 'img' }, [
            first !== null
              ? h('img', { key: 'i', src: first.url, alt: first.filename, onClick: () => onOpenImage(first) })
              : h('span', { key: 'ph' }, job === null ? '还没有任务' : stateLabel(job.state) + '，成品图会出现在这里'),
          ]),
          h('textarea', {
            key: 'log',
            className: 'cw-log',
            readOnly: true,
            spellCheck: false,
            ref: logRef,
            value: text.length > 0 ? text : '（还没有输出）',
          }),
        ]),
        first !== null
          ? h('dl', { className: 'cw-facts', key: 'facts' }, [
            h(Fact, { key: 'file', label: '文件', value: first.filename, mono: true }),
            h(Fact, { key: 'path', label: '落盘', value: job.filePath ?? '—', mono: true }),
            h(Fact, { key: 'cost', label: '耗时', value: Number.isFinite(job.elapsedMs) ? Math.round(job.elapsedMs / 1000) + ' 秒' : '—' }),
          ])
          : null,
        h('div', { className: 'cw-actions', key: 'ops' }, [
          h('button', {
            className: 'cw-btn danger',
            key: 'stop',
            disabled: !canStop || busy,
            onClick: onStop,
          }, '停止生图'),
          h('button', { className: 'cw-btn', key: 'dl', disabled: !canSave, onClick: onDownload }, '保存图像'),
          h('button', { className: 'cw-btn', key: 'ws', disabled: !canSave || busy, onClick: onSaveToWorkspace }, '存到工作区'),
          h('button', { className: 'cw-btn', key: 'cp', disabled: !canSave || busy, onClick: onCopyImage }, '复制图像'),
          h('span', { className: 'cw-spacer', key: 'sp' }),
          job?.previewMethod && job.previewMethod !== 'none'
            ? h('span', { className: 'cw-label', key: 'pm' }, '预览：' + job.previewMethod + (job.previewConnected ? '' : '（未连上）'))
            : null,
        ]),
      ])
    }

    /**
     * 放大输出卡片：拿输入框 / 输出框里的图，走 ComfyUI 的 ESRGAN 放大。
     * 成品单独落这里，不覆盖输出框里那张原图。
     */
    function UpscalePane({ job, meta, models, model, scale, onModel, onScale, onRun, onOpenImage, onDownload, onCopy, onSave, busy, running, serviceUp, sources }) {
      const images = job?.images ?? []
      const first = images[0] ?? null
      return h('div', { className: 'cw-card', key: 'upscale' }, [
        h('div', { className: 'cw-card-head', key: 'h' }, [
          h('h3', { className: 'cw-card-title', key: 't' }, '放大输出'),
          job !== null ? h('span', { className: 'cw-chip', key: 's' }, job.state === 'running' ? '放大中' : stateLabel(job.state)) : null,
          job?.promptId ? h('span', { className: 'cw-path', key: 'p' }, job.promptId.slice(0, 12)) : null,
          h('span', { className: 'cw-spacer', key: 'sp' }),
          h('span', { className: 'cw-label', key: 'ml' }, '超分模型'),
          h('select', {
            className: 'cw-select', value: model, key: 'm',
            onChange: (event) => onModel(event.target.value),
          }, [
            h('option', { key: '', value: '' }, '默认：RealESRGAN anime 4x'),
            ...models.map((name) => h('option', { key: name, value: name }, name)),
          ]),
          h('span', { className: 'cw-label', key: 'sl' }, '倍数'),
          h('select', {
            className: 'cw-select cw-num', value: String(scale), key: 'sc',
            onChange: (event) => onScale(Number(event.target.value)),
          }, [2, 3, 4].map((step) => h('option', { key: step, value: String(step) }, step + 'x'))),
          h('button', {
            className: 'cw-btn primary', key: 'run',
            disabled: busy || !serviceUp || sources.length === 0,
            onClick: onRun,
          }, running ? '放大中…' : '放大'),
        ]),
        h('p', { className: 'cw-empty', key: 'hint' }, sources.length === 0
          ? '输入框 / 输出框里还没有图：先出一张（或在画风图库里套一个画风），再点「放大」。'
          : '点「放大」把 ' + sources.join(' + ') + ' 送进 ComfyUI 超分，完成后成品出现在下面，原图不动。'),
        images.length > 0
          ? h('div', { className: 'cw-ups', key: 'grid' }, images.map((image) => h('figure', { className: 'cw-ups-item', key: image.url }, [
            h('img', { src: image.url, alt: image.filename, key: 'i', onClick: () => onOpenImage(image) }),
            h('figcaption', { key: 'c' }, (image.subfolder ? image.subfolder + '/' : '') + image.filename),
          ])))
          : null,
        first !== null
          ? h('dl', { className: 'cw-facts', key: 'facts' }, [
            h(Fact, { key: 'file', label: '文件', value: first.filename, mono: true }),
            h(Fact, { key: 'path', label: '落盘', value: job.filePath ?? '—', mono: true }),
            h(Fact, { key: 'model', label: '模型 / 倍数', value: (meta?.model ?? '—') + ' · ' + String(meta?.scale ?? scale) + 'x' }),
            h(Fact, { key: 'cost', label: '耗时', value: Number.isFinite(job.elapsedMs) ? Math.round(job.elapsedMs / 1000) + ' 秒' : '—' }),
          ])
          : null,
        first !== null
          ? h('div', { className: 'cw-actions', key: 'ops' }, [
            h('button', { className: 'cw-btn', key: 'dl', onClick: onDownload }, '保存图像'),
            h('button', { className: 'cw-btn', key: 'ws', disabled: busy, onClick: onSave }, '存到工作区'),
            h('button', { className: 'cw-btn', key: 'cp', disabled: busy, onClick: onCopy }, '复制图像'),
            h('span', { className: 'cw-spacer', key: 'sp' }),
            h('span', { className: 'cw-label', key: 'note' }, '产物在 ' + (meta?.folder ?? 'upscale') + ' 下，原图不动'),
          ])
          : null,
      ])
    }
    // ------------------------------------------------------------ 模型库（Civitai）

    const HUB_TYPES = [
      { value: 'LORA', label: 'LoRA' },
      { value: 'Checkpoint', label: '底模 Checkpoint' },
      { value: 'TextualInversion', label: '文本嵌入 Embedding' },
      { value: 'VAE', label: 'VAE' },
      { value: 'Controlnet', label: 'ControlNet' },
      { value: 'Upscaler', label: '放大模型' },
    ]

    const HUB_SORTS = [
      { value: 'Most Downloaded', label: '最多下载' },
      { value: 'Highest Rated', label: '评分最高' },
      { value: 'Newest', label: '最新' },
    ]

    // Civitai 的底模枚举名（不是我们起的别名）：过滤原样放进 `baseModels=`。
    // MOSS Image 是 2026 年新增的，原先漏了；NoobAI / HiDream / Chroma / Wan Video 一并补上。
    const HUB_BASE_MODELS = [
      '', 'MOSS Image', 'Illustrious', 'NoobAI', 'Pony', 'SDXL 1.0', 'SD 1.5',
      'Flux.1 D', 'Flux.1 S', 'Qwen', 'HiDream', 'Chroma', 'Wan Video',
    ]
    /** 下拉里显示中文，值仍是 Civitai 的枚举名（过滤要用原文）。 */
    const HUB_BASE_MODEL_LABELS = {
      'MOSS Image': 'MOSS 图像',
      'Illustrious': '动漫 · Illustrious',
      'NoobAI': '动漫 · NoobAI',
      'Pony': '动漫 · Pony',
      'SDXL 1.0': '通用 · SDXL 1.0',
      'SD 1.5': '经典 · SD 1.5',
      'Flux.1 D': 'Flux · 1 D',
      'Flux.1 S': 'Flux · 1 S',
      'Qwen': '千问 · Qwen',
      'HiDream': 'HiDream',
      'Chroma': 'Chroma',
      'Wan Video': '通义万相 · Wan Video',
    }

    /** 目标目录的中文说明；没列出来的直接显示目录名。 */
    const HUB_CATEGORY_LABELS = {
      loras: 'loras · LoRA',
      checkpoints: 'checkpoints · 底模',
      embeddings: 'embeddings · 文本嵌入',
      vae: 'vae · VAE',
      controlnet: 'controlnet · ControlNet',
      upscale_models: 'upscale_models · 放大模型',
      hypernetworks: 'hypernetworks · 超网络',
      diffusion_models: 'diffusion_models',
      unet: 'unet',
      text_encoders: 'text_encoders',
    }

    /** 下载进度里每个文件的状态。 */
    const HUB_ITEM_LABELS = {
      queued: '排队中',
      running: '下载中',
      done: '完成',
      failed: '失败',
      cancelled: '已取消',
    }

    /** LoRA 文件名 → 可翻译的英文短语：去扩展名、下划线换空格。 */
    function cleanLoraName(name) {
      return String(name).replace(/\.[^.]+$/, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim()
    }

    /** 封面：大图卡 / 详情弹层共用；加载失败就退回纯文字，布局不塌。 */
    function HubCover({ model, big }) {
      const [failed, setFailed] = useState(false)
      const src = model.cover
      const className = big === true ? 'cw-hub-detail-cover' : 'cw-hub-tile-cover'
      if (src === null || src === undefined || failed) {
        return h('div', { className }, [
          h('span', { className: 'ph', key: 't' }, model.typeLabel ?? '无封面'),
        ])
      }
      return h('div', { className }, [
        h('img', {
          key: 'i',
          src,
          alt: model.name,
          loading: 'lazy',
          decoding: 'async',
          onError: () => setFailed(true),
        }),
      ])
    }

    /**
     * 模型库第四页。
     *
     * 数据只从 Civitai 公开 API 来；页面不内嵌 civitai.red（那个页面直连 403）。
     * key 只进 `hubKey` 的 POST body，渲染进程拿不到原文，只拿掩码 + 保存时间。
     */
    function HubPane({ call, onLoraAdd, onRefreshDirs, onDraft, onInsertPrompt, promptText }) {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [keyInput, setKeyInput] = useState('')
      const [remember, setRemember] = useState(true)
      const [query, setQuery] = useState('')
      const [type, setType] = useState('LORA')
      const [baseModel, setBaseModel] = useState('')
      /** 搜索结果里出现过的底模：Civitai 加新家族时下拉自动跟上，不用改代码。 */
      const [extraBases, setExtraBases] = useState([])
      const [sort, setSort] = useState('Most Downloaded')
      const [nsfw, setNsfw] = useState(false)
      const [result, setResult] = useState(null)
      const [loading, setLoading] = useState(false)
      /** 详情弹层：点大图卡片进来，0 = 关着。 */
      const [detailId, setDetailId] = useState(0)
      const [versionId, setVersionId] = useState({})
      const [selection, setSelection] = useState({})
      const [job, setJob] = useState(null)
      const [busy, setBusy] = useState('')
      /** 自动翻译：英文名 / 简介 → 中文（宿主 hubTranslate，按句缓存，重复搜索不再花钱）。 */
      const [autoTranslate, setAutoTranslate] = useState(true)
      const [zhNames, setZhNames] = useState({})
      const [zhDesc, setZhDesc] = useState({})
      const [showOriginal, setShowOriginal] = useState(false)
      const [paste, setPaste] = useState('')
      const pollRef = useRef(null)
      /** 每个下载任务只自动刷一次目录：LoRA 选择菜单要看到新文件。 */
      const refreshTokenRef = useRef('')
      const autoSearchedRef = useRef(false)

      const run = async (key, action) => {
        setBusy(key)
        try {
          const message = await action()
          if (typeof message === 'string' && message.length > 0) setNotice({ kind: 'ok', text: message })
          return message
        } catch (failure) {
          setNotice({ kind: 'error', text: describe(failure) })
          return null
        } finally {
          setBusy('')
        }
      }

      const loadStatus = useCallback(async () => {
        try {
          const next = await call('hubStatus', {})
          setStatus(next)
          setRemember(next.rememberKey !== false)
          setError(null)
        } catch (failure) {
          setError(describe(failure))
        }
      }, [call])

      useEffect(() => {
        void loadStatus()
      }, [loadStatus])

      const search = useCallback(async (options = {}) => {
        setLoading(true)
        try {
          const next = await call('hubSearch', {
            query: options.query ?? (query.trim().length > 0 ? query.trim() : undefined),
            types: type.length > 0 ? type : undefined,
            baseModels: baseModel.length > 0 ? baseModel : undefined,
            sort: sort.length > 0 ? sort : undefined,
            nsfw,
            cursor: options.cursor ?? undefined,
            limit: 12,
          })
          setResult((previous) => (options.cursor !== undefined && previous !== null
            ? { ...next, items: [...previous.items, ...next.items] }
            : next))
          setExtraBases((previous) => {
            const seen = new Set(previous)
            for (const item of next.items ?? []) {
              for (const version of item.versions ?? []) {
                if (typeof version.baseModel === 'string' && version.baseModel.length > 0) seen.add(version.baseModel)
              }
            }
            return [...seen].slice(0, 24)
          })
          setError(null)
        } catch (failure) {
          setError(describe(failure))
        } finally {
          setLoading(false)
        }
      }, [call, query, type, baseModel, sort, nsfw])

      // 第一次进来先拉一页最热 LoRA：空着等用户输入太生硬，也不花 key。
      useEffect(() => {
        if (autoSearchedRef.current || status === null || result !== null) return
        autoSearchedRef.current = true
        void search({})
      }, [status, result, search])

      const saveKey = () => run('key', async () => {
        const text = keyInput.trim()
        if (text.length === 0) throw new Error('先粘贴 API Key')
        const next = await call('hubKey', { key: text, persist: remember })
        setStatus((previous) => (previous === null ? previous : { ...previous, ...next }))
        setKeyInput('')
        if (typeof next.storeError === 'string' && next.storeError.length > 0) {
          return '已用于本次，但写盘失败：' + next.storeError
        }
        return next.persisted ? '已保存到本机，重启 DSH 免填' : '仅本次有效（没有写盘）'
      })

      const clearKey = () => run('clear', async () => {
        const next = await call('hubKey', { key: '' })
        setStatus((previous) => (previous === null ? previous : { ...previous, ...next }))
        return '已清除本机凭据'
      })

      const resolvePaste = () => run('resolve', async () => {
        const text = paste.trim()
        if (text.length === 0) throw new Error('粘贴 Civitai 链接或填模型 ID')
        const found = await call('hubResolve', { url: text })
        setResult({ items: [found.model], nextCursor: null, total: 1, note: found.reason, host: status?.host ?? '' })
        setDetailId(found.model.id)
        setPaste('')
        return '定位到 ' + found.model.name
      })

      const versionOf = (model) => {
        const picked = versionId[model.id]
        return model.versions.find((version) => version.id === picked) ?? model.versions[0] ?? null
      }

      const selectionKey = (version, file) => String(version.id) + '|' + file.name

      const toggleFile = (model, version, file) => {
        const key = selectionKey(version, file)
        setSelection((current) => {
          if (current[key] !== undefined) {
            const next = { ...current }
            delete next[key]
            return next
          }
          const target = file.suggestedCategory ?? model.suggestedCategory ?? 'loras'
          return {
            ...current,
            [key]: {
              key,
              versionId: version.id,
              name: file.name,
              sizeBytes: file.sizeBytes,
              sha256: file.sha256,
              targetCategory: target,
              modelName: model.name,
              versionName: version.name,
              baseModel: version.baseModel,
              trainedWords: version.trainedWords,
              type: model.type,
            },
          }
        })
      }

      const setTarget = (key, category) => {
        setSelection((current) => (current[key] === undefined
          ? current
          : { ...current, [key]: { ...current[key], targetCategory: category } }))
      }


      // 1 秒一轮只看 job；到终态就停，并按配置自动要一次建议（只一次，不重复花 token）。
      useEffect(() => {
        const active = job !== null && typeof job.token === 'string' && job.state === 'running'
        if (!active) {
          if (pollRef.current !== null) {
            clearInterval(pollRef.current)
            pollRef.current = null
          }
          return undefined
        }
        if (pollRef.current !== null) return undefined
        const token = job.token
        pollRef.current = setInterval(async () => {
          try {
            const next = await call('hubJob', { token })
            setJob(next)
            if (next.state !== 'running' && next.state !== 'idle') {

              void loadStatus()
              if (refreshTokenRef.current !== token) {
                refreshTokenRef.current = token
                if ((next.items ?? []).some((item) => item.state === 'done') && typeof onRefreshDirs === 'function') {
                  // 下完立刻重扫一次目录；不然 LoRA 选择菜单里永远是旧列表。
                  onRefreshDirs()
                }
              }
            }
          } catch (failure) {
            setJob({ token, state: 'failed', items: [], note: describe(failure), bytesDone: 0, bytesTotal: 0 })
          }
        }, 1000)
        return undefined
      }, [job, call, loadStatus, status])

      const download = () => run('download', async () => {
        const items = Object.values(selection)
        if (items.length === 0) throw new Error('先勾选要下载的文件')
        const token = 'hub-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)

        const started = await call('hubDownload', { token, items })
        // 顺手把 Civitai 的触发词记到本机：工台面板要显示 / 复制，大模型改写也要用。
        const withWords = items
          .filter((item) => Array.isArray(item.trainedWords) && item.trainedWords.length > 0)
          .map((item) => ({ name: item.name, words: item.trainedWords }))
        if (withWords.length > 0 && typeof onRefreshDirs === 'function') {
          void call('hubTriggers', { put: withWords }).then(() => onRefreshDirs()).catch(() => null)
        }
        setJob({ token, state: 'running', items: [], bytesDone: 0, bytesTotal: started.totalBytes })
        const rejected = started.rejected.length > 0
          ? '；' + started.rejected.length + ' 个没进队（' + started.rejected[0].message + '）'
          : ''
        return '已入队 ' + started.accepted + ' 个文件 · ' + formatBytes(started.totalBytes) + rejected
      })

      const cancel = () => run('cancel', async () => {
        if (job === null || typeof job.token !== 'string') throw new Error('现在没有任务')
        const done = await call('hubCancel', { token: job.token })
        return done.cancelled ? '已取消；下完的文件保留' : (done.note ?? '任务已经结束')
      })


      const chosen = Object.values(selection)
      const chosenBytes = chosen.reduce((sum, item) => sum + (Number(item.sizeBytes) || 0), 0)
      const jobPercent = job !== null && job.bytesTotal > 0
        ? Math.min(100, Math.round((job.bytesDone / job.bytesTotal) * 100))
        : 0
      // 详情弹层：从结果里按 id 找回来（不另存一份，免得跟搜索结果脱节）。
      const detail = result === null ? null : ((result.items ?? []).find((model) => model.id === detailId) ?? null)
      const detailVersion = detail === null ? null : versionOf(detail)
      const detailBaseModels = detail === null
        ? []
        : [...new Set(detail.versions.map((version) => version.baseModel).filter((name) => typeof name === 'string' && name.length > 0))]
      // 自动翻译：搜索结果里的英文名逐批翻。宿主按句缓存，重复搜索不再花钱；失败就显示原文。
      useEffect(() => {
        if (!autoTranslate || result === null) return undefined
        const todo = [...new Set((result.items ?? [])
          .map((item) => item.name)
          .filter((name) => typeof name === 'string' && name.length > 0 && zhNames[name] === undefined))]
          .slice(0, 24)
        if (todo.length === 0) return undefined
        let cancelled = false
        void (async () => {
          try {
            const answer = await call('hubTranslate', { texts: todo })
            if (cancelled) return
            const rows = Array.isArray(answer?.items) ? answer.items : []
            setZhNames((current) => {
              const next = { ...current }
              for (const row of rows) {
                if (row && typeof row.source === 'string' && typeof row.zh === 'string' && row.zh.length > 0) next[row.source] = row.zh
              }
              return next
            })
          } catch {
            /* 翻译失败就显示原文，不弹错 */
          }
        })()
        return () => { cancelled = true }
      }, [result, autoTranslate, zhNames, call])

      // 详情简介：打开时翻一次，按模型 id 缓存；「看原文」可随时切回去。
      useEffect(() => {
        if (!autoTranslate || detail === null || detail.description.length === 0) return undefined
        if (zhDesc[detail.id] !== undefined) return undefined
        const modelId = detail.id
        const source = detail.description.slice(0, 1500)
        let cancelled = false
        void (async () => {
          try {
            const answer = await call('hubTranslate', { texts: [source] })
            if (cancelled) return
            const row = Array.isArray(answer?.items) ? answer.items[0] : null
            if (row && typeof row.zh === 'string' && row.zh.length > 0) {
              setZhDesc((current) => ({ ...current, [modelId]: row.zh }))
            }
          } catch {
            /* 显示原文 */
          }
        })()
        return () => { cancelled = true }
      }, [detail, autoTranslate, zhDesc, call])


      const keyState = status?.hasKey === true
        ? (status.keySource === 'file'
          ? { text: '已保存 ' + (status.savedAt === null ? '' : formatTime(status.savedAt)) + ' · ' + (status.keyMask ?? ''), ok: true }
          : { text: '仅本次有效 · ' + (status.keyMask ?? ''), ok: false })
        : { text: '未设置（公开列表不用 key）', ok: false }

      return h('div', { className: 'cw-hub' }, [
        h('div', { className: 'cw-hub-main', key: 'main' }, [

          notice === null ? null : h(Msg, { kind: notice.kind, key: 'notice' }, notice.text),
          error === null ? null : h(Msg, { kind: 'error', key: 'err' }, error),

          h('div', { className: 'cw-card', key: 'src' }, [
            h('div', { className: 'cw-card-head', key: 'h' }, [
              h('h3', { className: 'cw-card-title', key: 't' }, '模型库 · Civitai'),
              h('span', { className: 'cw-spacer', key: 'sp' }),
              h('button', { className: 'cw-btn', key: 'refresh', type: 'button', disabled: busy.length > 0, onClick: () => { void loadStatus() } }, '刷新状态'),
            ]),
            h('div', { className: 'cw-hub-src', key: 'row' }, [
              h('span', { key: 'l' }, '来源'),
              h('a', {
                key: 'a',
                href: 'https://civitai.red/models',
                target: '_blank',
                rel: 'noreferrer',
              }, 'https://civitai.red/models ↗'),
              h('span', { key: 'api' }, '数据走 ' + (status?.apiBase ?? 'https://civitai.red/api/v1')),
              h('span', { key: 'cov' }, status?.proxy === null || status?.proxy === undefined
                ? '没探到本机代理：封面走境外反代，一张要十来秒'
                : '经本机代理 ' + status.proxy + '：封面几百毫秒'),
            ]),
            h('div', { className: 'cw-hub-keyrow', key: 'key' }, [
              h('input', {
                key: 'i',
                type: 'password',
                autoComplete: 'off',
                spellCheck: false,
                placeholder: '粘贴 Civitai API Key（可留空）',
                value: keyInput,
                onChange: (event) => setKeyInput(event.target.value),
              }),
              h('button', {
                className: 'cw-btn primary', key: 'save', type: 'button',
                disabled: busy.length > 0 || keyInput.trim().length === 0,
                onClick: () => { void saveKey() },
              }, busy === 'key' ? '保存中…' : '保存'),
              h('button', {
                className: 'cw-btn', key: 'clear', type: 'button',
                disabled: busy.length > 0 || status?.hasKey !== true,
                onClick: () => { void clearKey() },
              }, busy === 'clear' ? '清除中…' : '清除'),
            ]),
            h('label', { className: 'cw-hub-src', key: 'remember' }, [
              h('input', {
                key: 'c',
                type: 'checkbox',
                checked: remember,
                onChange: (event) => setRemember(event.target.checked),
              }),
              h('span', { key: 't' }, '记住在本机（重启免填）'),
            ]),
            h('p', { className: 'cw-hub-state' + (keyState.ok ? ' ok' : ''), key: 'state' }, keyState.text),
            h('p', { className: 'cw-hub-note', key: 'file' }, '凭据文件：' + (status?.keyFile ?? '（读取中）') + (status?.aclHardened === false ? ' · 权限未收紧，别把这个目录同步到网盘' : '')),
            status?.note === null || status?.note === undefined ? null : h('p', { className: 'cw-hub-note', key: 'note' }, status.note),
          ]),

          h('div', { className: 'cw-card', key: 'search' }, [
            h('div', { className: 'cw-hub-filters', key: 'f' }, [
              h('input', {
                key: 'q',
                type: 'search',
                placeholder: '搜模型名、作者、关键词',
                value: query,
                style: { flex: '1 1 220px' },
                onChange: (event) => setQuery(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') void search({}) },
              }),
              h('select', { key: 'type', value: type, onChange: (event) => setType(event.target.value) },
                HUB_TYPES.map((item) => h('option', { key: item.value, value: item.value }, item.label))),
              h('select', { key: 'base', value: baseModel, onChange: (event) => setBaseModel(event.target.value) },
                HUB_BASE_MODELS.concat(extraBases.filter((name) => !HUB_BASE_MODELS.includes(name)))
                  .map((item) => h('option', { key: item.length === 0 ? '__all__' : item, value: item }, item.length === 0 ? '全部底模' : (HUB_BASE_MODEL_LABELS[item] ?? item)))),
              h('select', { key: 'sort', value: sort, onChange: (event) => setSort(event.target.value) },
                HUB_SORTS.map((item) => h('option', { key: item.value, value: item.value }, item.label))),
              h('label', { key: 'nsfw', className: 'cw-hub-src' }, [
                h('input', { key: 'c', type: 'checkbox', checked: nsfw, onChange: (event) => setNsfw(event.target.checked) }),
                h('span', { key: 't' }, '含 NSFW'),
              ]),
              h('label', { key: 'zh', className: 'cw-hub-src' }, [
                h('input', { key: 'c', type: 'checkbox', checked: autoTranslate, onChange: (event) => setAutoTranslate(event.target.checked) }),
                h('span', { key: 't' }, '自动翻译'),
              ]),
              h('button', {
                className: 'cw-btn primary', key: 'go', type: 'button', disabled: loading || busy.length > 0,
                onClick: () => { void search({}) },
              }, loading ? '搜索中…' : '搜索'),
            ]),
            h('div', { className: 'cw-hub-filters', key: 'paste' }, [
              h('input', {
                key: 'p',
                type: 'search',
                placeholder: '粘贴 Civitai 链接或模型 / 版本 ID',
                value: paste,
                style: { flex: '1 1 260px' },
                onChange: (event) => setPaste(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') void resolvePaste() },
              }),
              h('button', {
                className: 'cw-btn', key: 'r', type: 'button', disabled: busy.length > 0 || paste.trim().length === 0,
                onClick: () => { void resolvePaste() },
              }, busy === 'resolve' ? '定位中…' : '直接定位'),
            ]),
          ]),

          h('div', { className: 'cw-card', key: 'list' }, [
            h('div', { className: 'cw-card-head', key: 'h' }, [
              h('h3', { className: 'cw-card-title', key: 't' }, '结果'),
              h('span', { className: 'cw-chip', key: 'n' }, (result?.items?.length ?? 0) + ' 个模型'),
              result?.note === null || result?.note === undefined ? null : h('span', { className: 'cw-hub-meta', key: 'note' }, result.note),
            ]),
            result === null
              ? h('p', { className: 'cw-empty', key: 'empty' }, loading ? '读取中…' : '点「搜索」拿一页最热门的模型')
              : (result.items ?? []).length === 0
                ? h('p', { className: 'cw-empty', key: 'none' }, '没有结果，换个词或放宽类型')
                : h('div', { className: 'cw-hub-grid', key: 'items' }, result.items.map((model) => {
                  const version = versionOf(model)
                  return h('button', {
                    className: 'cw-hub-tile', key: String(model.id), type: 'button',
                    title: '看详情 · ' + model.name,
                    onClick: () => setDetailId(model.id),
                  }, [
                    h(HubCover, { key: 'cover', model }),
                    h('div', { className: 'cw-hub-tile-body', key: 'b' }, [
                      h('div', { className: 'cw-hub-tile-name', key: 'n' }, zhNames[model.name] ?? model.name),
                      zhNames[model.name] === undefined ? null : h('div', { className: 'cw-hub-tile-en', key: 'en', title: model.name }, model.name),
                      h('div', { className: 'cw-hub-tile-meta', key: 'm' }, [
                        h('span', { key: 't' }, model.typeLabel),
                        version === null || version.baseModel === null ? null : h('span', { key: 'bm' }, version.baseModel),
                        h('span', { key: 'd' }, '↓ ' + (model.stats.downloads || 0).toLocaleString('zh-CN')),
                        model.nsfw ? h('span', { key: 'x' }, 'NSFW') : null,
                      ]),
                    ]),
                  ])
                })),
            result !== null && typeof result.nextCursor === 'string' && result.nextCursor.length > 0
              ? h('button', {
                className: 'cw-btn', key: 'more', type: 'button', disabled: loading,
                onClick: () => { void search({ cursor: result.nextCursor }) },
              }, loading ? '加载中…' : '加载更多')
              : null,
          ]),

          h('div', { className: 'cw-hub-foot', key: 'foot' }, [
            h('span', { key: 'n' }, '已选 ' + chosen.length + ' 个 · 合计 ' + formatBytes(chosenBytes)),
            job === null
              ? null
              : h('div', { className: 'cw-hub-progress cw-hub-foot-bar', key: 'bar' }, [
                h('i', { key: 'i', style: { width: jobPercent + '%' } }),
              ]),
            job === null
              ? null
              : h('span', { className: 'cw-hub-meta', key: 'pct' }, (HUB_ITEM_LABELS[job.state] ?? job.state) + ' · ' + jobPercent + '%'),
            h('span', { className: 'cw-spacer', key: 'sp' }),
            h('button', {
              className: 'cw-btn primary', key: 'dl', type: 'button',
              disabled: busy.length > 0 || chosen.length === 0 || job?.state === 'running',
              onClick: () => { void download() },
            }, busy === 'download' ? '提交中…' : (job?.state === 'running' ? '下载中…' : '下载选中')),
            h('button', {
              className: 'cw-btn', key: 'cx', type: 'button',
              disabled: job?.state !== 'running',
              onClick: () => { void cancel() },
            }, busy === 'cancel' ? '取消中…' : '取消'),

          ]),

          job === null ? null : h('div', { className: 'cw-card', key: 'job' }, [
            h('div', { className: 'cw-card-head', key: 'h' }, [
              h('h3', { className: 'cw-card-title', key: 't' }, '下载进度'),
              h('span', { className: 'cw-chip', key: 's' }, HUB_ITEM_LABELS[job.state] ?? job.state),
              h('span', { className: 'cw-spacer', key: 'sp' }),
              h('span', { className: 'cw-hub-meta', key: 'b' }, formatBytes(job.bytesDone) + ' / ' + formatBytes(job.bytesTotal) + ' · ' + jobPercent + '%'),
            ]),
            h('div', { className: 'cw-hub-progress', key: 'bar' }, [
              h('i', { key: 'i', style: { width: jobPercent + '%' } }),
            ]),
            job.note === null || job.note === undefined ? null : h('p', { className: 'cw-hub-note', key: 'note' }, job.note),
            (job.items ?? []).length === 0
              ? null
              : h('div', { key: 'items' }, job.items.map((item) => h('div', { className: 'cw-hub-file', key: item.name + ':' + item.versionId }, [
                h('span', { className: 'nm', key: 'n', title: item.path }, item.name),
                h('span', { key: 's' }, HUB_ITEM_LABELS[item.state] ?? item.state),
                h('span', { key: 'b', style: { opacity: .7 } }, formatBytes(item.bytes) + ' / ' + formatBytes(item.total)),
                h('span', { key: 'pct', style: { opacity: .7 } }, String(item.total > 0 ? Math.round((item.bytes / item.total) * 100) : 0) + '%'),
                h('div', { className: 'cw-hub-progress cw-hub-item-bar', key: 'pb' }, [
                  h('i', { key: 'i', style: { width: String(item.total > 0 ? Math.min(100, Math.round((item.bytes / item.total) * 100)) : 0) + '%' } }),
                ]),
                item.sha256Ok === true ? h('span', { key: 'h', style: { opacity: .7 } }, 'SHA256 ✓') : null,
                item.error === null || item.error === undefined ? null : h('span', { key: 'e', style: { color: '#d9534f' } }, item.error.message),
                h('span', { className: 'cw-path', key: 'p', style: { flex: '1 1 100%' } }, item.path),
              ]))),
          ]),
        ]),


        detail === null
          ? null
          : h('div', {
            className: 'cw-hub-detail',
            key: 'detail',
            onClick: (event) => { if (event.target === event.currentTarget) setDetailId(0) },
          }, [
            h('div', { className: 'cw-hub-detail-card', key: 'card' }, [
              h('div', { className: 'cw-card-head', key: 'h' }, [
                h('h3', { className: 'cw-card-title', key: 't' }, zhNames[detail.name] ?? detail.name),
                zhNames[detail.name] === undefined ? null : h('span', { className: 'cw-hub-tile-en', key: 'en', title: detail.name }, detail.name),
                h('span', { className: 'cw-chip', key: 'ty' }, detail.typeLabel),
                detail.nsfw ? h('span', { className: 'cw-chip', key: 'nsfw' }, 'NSFW') : null,
                h('span', { className: 'cw-spacer', key: 'sp' }),
                h('a', { className: 'cw-btn', key: 'a', href: detail.url, target: '_blank', rel: 'noreferrer' }, '在 Civitai 打开 ↗'),
                h('button', { className: 'cw-btn', key: 'x', type: 'button', onClick: () => setDetailId(0) }, '关闭'),
              ]),
              h('div', { className: 'cw-hub-detail-top', key: 'top' }, [
                h(HubCover, { key: 'cover', model: detail, big: true }),
                h('div', { className: 'cw-hub-detail-info', key: 'info' }, [
                  h('div', { className: 'cw-hub-meta', key: 'm' }, [
                    detail.creator === null ? null : h('span', { key: 'c' }, 'by ' + detail.creator),
                    h('span', { key: 'd' }, '↓ ' + (detail.stats.downloads || 0).toLocaleString('zh-CN')),
                    h('span', { key: 'u' }, '♥ ' + (detail.stats.thumbsUp || 0).toLocaleString('zh-CN')),
                    Number(detail.stats.rating) > 0 ? h('span', { key: 'r' }, '★ ' + Number(detail.stats.rating).toFixed(2)) : null,
                    detailBaseModels.length === 0 ? null : h('span', { key: 'b' }, '底模 ' + detailBaseModels.join(' / ')),
                  ]),
                  detail.tags.length === 0 ? null : h('div', { className: 'cw-hub-meta', key: 'tags' },
                    detail.tags.map((tag) => h('span', { className: 'cw-chip', key: tag }, tag))),
                  h('div', { className: 'cw-hub-file', key: 'vrow' }, [
                    h('span', { key: 'l', style: { opacity: .7 } }, '版本'),
                    h('select', {
                      key: 's',
                      value: detailVersion === null ? '' : String(detailVersion.id),
                      onChange: (event) => setVersionId((current) => ({ ...current, [detail.id]: Number(event.target.value) })),
                    }, detail.versions.map((item) => h('option', { key: String(item.id), value: String(item.id) },
                      item.name + (item.baseModel === null ? '' : ' · ' + item.baseModel)))),
                    h('span', { key: 'w', style: { opacity: .7 } }, (detailVersion?.trainedWords ?? []).length > 0
                      ? '触发词 ' + detailVersion.trainedWords.join(', ')
                      : '没有触发词'),
                  ]),
                  h('div', { className: 'cw-hub-desc-head', key: 'dh' }, [
                    h('span', { key: 'l' }, showOriginal ? '原文' : '自动翻译'),
                    zhDesc[detail.id] === undefined
                      ? null
                      : h('button', {
                        className: 'cw-btn', key: 'sw', type: 'button',
                        onClick: () => setShowOriginal((current) => !current),
                      }, showOriginal ? '看译文' : '看原文'),
                  ]),
                  h('p', { className: 'cw-hub-desc', key: 'desc' },
                    showOriginal || zhDesc[detail.id] === undefined
                      ? (detail.description.length > 0 ? detail.description : '（作者没写简介）')
                      : zhDesc[detail.id]),
                ]),
              ]),
              detailVersion === null
                ? null
                : h('div', { className: 'cw-hub-ver', key: 'files' }, detailVersion.files.map((file) => {
                  const key = selectionKey(detailVersion, file)
                  const picked = selection[key]
                  const target = picked?.targetCategory ?? file.suggestedCategory ?? ''
                  return h('div', { className: 'cw-hub-file', key }, [
                    h('input', { key: 'c', type: 'checkbox', checked: picked !== undefined, onChange: () => toggleFile(detail, detailVersion, file) }),
                    h('span', { className: 'nm', key: 'n', title: file.name }, file.name),
                    h('span', { key: 's', style: { opacity: .7 } }, formatBytes(file.sizeBytes)),
                    file.format === null ? null : h('span', { key: 'f', style: { opacity: .5 } }, file.format),
                    h('select', {
                      key: 't', value: target, disabled: picked === undefined,
                      onChange: (event) => setTarget(key, event.target.value),
                    }, (status?.targets ?? [])
                      .filter((item) => ['loras', 'checkpoints', 'embeddings', 'vae', 'controlnet', 'upscale_models', 'hypernetworks'].includes(item.category))
                      .map((item) => h('option', { key: item.category, value: item.category },
                        (HUB_CATEGORY_LABELS[item.category] ?? item.category) + (item.exists ? '' : '（目录不存在）')))),
                  ])
                })),
              h('div', { className: 'cw-hub-actions', key: 'act' }, [
                h('span', { key: 'n', className: 'cw-hub-meta' }, '已选 ' + chosen.length + ' 个 · ' + formatBytes(chosenBytes)),
                h('span', { className: 'cw-spacer', key: 'sp' }),

                h('button', {
                  className: 'cw-btn primary', key: 'dl', type: 'button',
                  disabled: busy.length > 0 || chosen.length === 0 || job?.state === 'running',
                  onClick: () => { void download() },
                }, busy === 'download' ? '提交中…' : '下载选中'),
              ]),
            ]),
          ]),
      ])
    }

    function Page() {
      const [env, setEnv] = useState(null)
      const [dirs, setDirs] = useState(null)
      const [models, setModels] = useState(null)
      const [ws, setWs] = useState(null)
      const [text, setText] = useState('')
      const [negative, setNegative] = useState('')
      const [pick, setPick] = useState({ provider: '', model: '' })
      const [checkpoint, setCheckpoint] = useState('')
      const [size, setSize] = useState({ width: 768, height: 1024 })
      const [steps, setSteps] = useState(10)
      /** LoRA 多选：数组顺序 = 写入 LoraLoader 槽的顺序；空数组 = 完全不碰工作流自带的 LoRA。 */
      const [loraSel, setLoraSel] = useState([])
      /** LoRA 文件名的中文（键是完整文件名）；只在下拉打开时翻。 */
      const [zhLoras, setZhLoras] = useState({})
      /** 工台这边的翻译开关（和模型库那个 autoTranslate 是两个组件的状态，别串）。 */
      const [zhLoraOn, setZhLoraOn] = useState(true)
      /** LoRA 文件名 → 触发词（小写键，来自宿主 lora-triggers.json）。 */
      const [triggerMap, setTriggerMap] = useState({})
      /** 正在回填触发词的文件名（空串 = 空闲）。 */
      const [triggerBusy, setTriggerBusy] = useState('')
      const [loraOpen, setLoraOpen] = useState(false)
      const [busy, setBusy] = useState('')
      /** 「关闭 ComfyUI」的两步确认：第一下只上膛，4 秒内再点才真杀 */
      const [stopArm, setStopArm] = useState(false)
      const [notice, setNotice] = useState(null)
      const [job, setJob] = useState(null)
      const [tab, setTab] = useState('work')
      const [genFolder, setGenFolder] = useState('')
      const [workflowList, setWorkflowList] = useState(null)
      const [workflowId, setWorkflowId] = useState('')
      /** 从画风图库套用的画风：{ name, category, prompt, url }；出图时拼在画面之前。 */
      const [styleRef, setStyleRef] = useState(null)
      /** 逐步预览快照（只含元数据与步列表，图片走 /dsh-comfy/preview/<step>）。 */
      const [preview, setPreview] = useState(null)
      const [previewOn, setPreviewOn] = useState(true)
      const [previewMethod, setPreviewMethod] = useState('latent2rgb')
      /** 页面自己产生的事件（提交/停止/保存），与宿主事件合并成输出框。 */
      const [localEvents, setLocalEvents] = useState([])
      const [logPaused, setLogPaused] = useState(false)
      /** 页面级灯箱：成品图与逐步预览帧共用。 */
      const [lightboxImage, setLightboxImage] = useState(null)
      /** 放大输出：模型 / 倍数 / 任务 / 提交信息——和出图任务分开存，别抢 job。 */
      const [upscaleModel, setUpscaleModel] = useState('')
      const [upscaleScale, setUpscaleScale] = useState(2)
      const [upscaleJob, setUpscaleJob] = useState(null)
      const [upscaleMeta, setUpscaleMeta] = useState(null)
      /** 改写两阶段：'' 空闲 / 'plan' 判定中 / 'apply' 思考中；GIF 的 src 每次点击换 t=，强制从头播。 */
      const [rewritePhase, setRewritePhase] = useState('')
      const [rewriteGif, setRewriteGif] = useState('')
      /** 点击前的两个框，供「撤销改写」原样写回；null = 没有可撤销的。 */
      const [undoRef, setUndoRef] = useState(null)
      const rewriteTokenRef = useRef('')
      /** 改写过程记在「思考」框里，不进「输出」框——输出框是出图日志。 */
      const [thinkLog, setThinkLog] = useState([])
      const [thinkInfo, setThinkInfo] = useState(null)
      const thinkRef = useRef(null)
      const upscalePollRef = useRef(null)
      const upscaleDoneRef = useRef(false)
      const logRef = useRef(null)
      /** LoRA 下拉面板：点外面 / 按 Esc 收起来。 */
      const loraPopRef = useRef(null)
      const previewSinceRef = useRef(0)
      const pollRef = useRef(null)

      const call = useCallback((method, args) => bridge.call(method, args), [])

      const load = useCallback(async (refresh) => {
        setBusy(refresh ? 'refresh' : 'init')
        try {
          const [probe, listing, modelList, workspaceView, workflowView, triggerView] = await Promise.all([
            call('probe', {}),
            call('dirs', { refresh: Boolean(refresh) }),
            call('models', {}),
            call('workspace', {}),
            // 宿主还是旧版时没有这个方法：拿不到就退回「只有默认工作流」，别把整页拖挂。
            call('workflows', {}).catch(() => null),
            // 触发词映射：拿不到就当空表，不影响别的。
            call('hubTriggers', {}).catch(() => null),
          ])
          if (triggerView !== null && triggerView !== undefined && triggerView.items && typeof triggerView.items === 'object') {
            setTriggerMap(triggerView.items)
          }
          setEnv(probe)
          setDirs(listing)
          setModels(modelList)
          setWs(workspaceView)
          setWorkflowList(workflowView)
          const fallback = modelList?.selected ?? modelList?.default ?? null
          if (fallback) setPick({ provider: fallback.provider, model: fallback.model })
          const saved = await call('config', {})
          if (saved && typeof saved === 'object') {
            if (saved.checkpoint) {
              // 记住的底模先对一遍当前候选：换了工作流（UNETLoader ↔ CheckpointLoaderSimple）、
              // 模型被删或改名都会对不上。对不上就别塞回控件——塞回去控件会显示成「工作流默认」，
              // 内部却还带着旧名字，出图就被 ComfyUI 400 拒掉。
              const savedWorkflowId = typeof saved.workflow === 'string' && (workflowView?.items ?? []).some((item) => item.id === saved.workflow)
                ? saved.workflow
                : ''
              const savedKind = (workflowView?.items ?? []).find((item) => item.id === savedWorkflowId)?.summary?.loader ?? null
              const have = workflowView?.have ?? null
              const allowed = have === null
                ? null
                : savedKind === 'checkpoint'
                  ? (have.checkpoints ?? [])
                  : savedKind === 'unet'
                    ? (have.unet ?? [])
                    : [...new Set([...(have.checkpoints ?? []), ...(have.unet ?? [])])]
              if (allowed === null || allowed.includes(saved.checkpoint)) setCheckpoint(saved.checkpoint)
            }
            if (Number.isFinite(saved.width) && Number.isFinite(saved.height)) setSize({ width: saved.width, height: saved.height })
            if (Number.isFinite(saved.steps)) setSteps(saved.steps)
            if (Array.isArray(saved.loras)) {
              setLoraSel(saved.loras
                .filter((item) => item && typeof item.name === 'string' && item.name.length > 0)
                .map((item) => ({ name: item.name, strength: Number.isFinite(item.strength) ? item.strength : 1 })))
            }
            if (typeof saved.lastPrompt === 'string' && saved.lastPrompt.length > 0) setText((current) => current || saved.lastPrompt)
            if (typeof saved.galleryFolder === 'string') setGenFolder(saved.galleryFolder)
            if (typeof saved.previewEnabled === 'boolean') setPreviewOn(saved.previewEnabled)
            if (typeof saved.previewMethod === 'string' && saved.previewMethod.length > 0) setPreviewMethod(saved.previewMethod)
            if (typeof saved.workflow === 'string' && (workflowView?.items ?? []).some((item) => item.id === saved.workflow)) {
              setWorkflowId(saved.workflow)
            }
          }
          setNotice(null)
        } catch (error) {
          setNotice({ kind: 'error', text: describe(error) })
        } finally {
          setBusy('')
        }
      }, [call])

      useEffect(() => {
        ensureCss()
        void load(false)
        return () => {
          if (pollRef.current !== null) clearInterval(pollRef.current)
          if (upscalePollRef.current !== null) clearInterval(upscalePollRef.current)
        }
      }, [load])

      // 出图轮询：1 秒一 tick，同时拉增量预览帧；进终态立刻停。
      useEffect(() => {
        const active = job !== null && typeof job.promptId === 'string' && job.promptId.length > 0
          && (job.state === 'running' || job.state === 'queued' || job.state === 'unknown')
        if (!active) {
          if (pollRef.current !== null) {
            clearInterval(pollRef.current)
            pollRef.current = null
          }
          return undefined
        }
        if (pollRef.current !== null) return undefined
        const promptId = job.promptId
        pollRef.current = setInterval(async () => {
          try {
            const [next, live] = await Promise.all([
              call('job', { promptId }),
              // 预览拿不到不该拖垮轮询：单独 catch 成 null。
              call('preview', { promptId, since: previewSinceRef.current }).catch(() => null),
            ])
            if (live !== null && live !== undefined) {
              previewSinceRef.current = Number.isFinite(live.nextSince) ? live.nextSince : previewSinceRef.current
              setPreview((previous) => mergePreview(previous, live))
            }
            setJob(next)
          } catch (error) {
            setJob({ promptId, state: 'failed', images: [], messages: [describe(error)] })
          }
        }, 1000)
        return undefined
      }, [job, call])

      // 放大轮询：同一个 job() 接口，只写 upscaleJob，不覆盖输出框的原图。
      useEffect(() => {
        const active = upscaleJob !== null && typeof upscaleJob.promptId === 'string' && upscaleJob.promptId.length > 0
          && (upscaleJob.state === 'running' || upscaleJob.state === 'queued' || upscaleJob.state === 'unknown')
        if (!active) {
          if (upscalePollRef.current !== null) {
            clearInterval(upscalePollRef.current)
            upscalePollRef.current = null
          }
          return undefined
        }
        if (upscalePollRef.current !== null) return undefined
        const promptId = upscaleJob.promptId
        upscalePollRef.current = setInterval(async () => {
          try {
            const next = await call('job', { promptId })
            setUpscaleJob(next)
            if (next.state === 'done' && !upscaleDoneRef.current) {
              upscaleDoneRef.current = true
              addLocal('info', '放大完成：' + (next.images?.length ?? 0) + ' 张')
              void load(true).catch(() => null)
            } else if ((next.state === 'failed' || next.state === 'timeout') && !upscaleDoneRef.current) {
              upscaleDoneRef.current = true
              addLocal('error', '放大失败：' + ((next.messages ?? []).join('；') || '看 ComfyUI 日志'))
            }
          } catch (error) {
            setUpscaleJob({ promptId, state: 'failed', images: [], messages: [describe(error)] })
          }
        }, 1500)
        return undefined
      }, [upscaleJob, call])

      // 输出框自动滚到底；用户勾了「暂停跟随」就不动。
      useEffect(() => {
        if (logPaused) return
        const node = logRef.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }, [preview, localEvents, logPaused])

      // LoRA 下拉：点面板外面、或按 Esc 就收起来。
      useEffect(() => {
        if (!loraOpen) return undefined
        const onDown = (event) => {
          const node = loraPopRef.current
          if (node !== null && !node.contains(event.target)) setLoraOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setLoraOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [loraOpen])

      // 思考框跟着最新一行走，不用手动滚。
      useEffect(() => {
        const node = thinkRef.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }, [thinkLog])

      const checkpoints = dirs?.files?.checkpoints ?? []
      const loras = dirs?.files?.loras ?? []
      const upscaleModels = dirs?.files?.upscale_models ?? []
      const bound = ws?.bound ?? null
      const providerOptions = useMemo(() => {
        const list = []
        for (const provider of models?.providers ?? []) {
          for (const model of provider.models ?? []) {
            list.push({ value: provider.id + '::' + model.id, label: provider.name + ' · ' + model.name })
          }
        }
        return list
      }, [models])

      const currentValue = pick.provider && pick.model ? pick.provider + '::' + pick.model : ''

      const run = async (key, action) => {
        setBusy(key)
        setNotice(null)
        try {
          const message = await action()
          if (message) setNotice({ kind: 'ok', text: message })
        } catch (error) {
          setNotice({ kind: 'error', text: describe(error) })
        } finally {
          setBusy('')
        }
      }

      const addLocal = (kind, text) => setLocalEvents((previous) => [...previous.slice(-49), { at: Date.now(), kind, text }])

      /** 思考框追加一行（最多留 60 条）。 */
      const appendThink = (kind, text) => setThinkLog((previous) => [...previous.slice(-59), { at: Date.now(), kind, text }])

      const clearThink = () => {
        setThinkLog([])
        setThinkInfo(null)
      }

      /** 宿主事件 + 页面事件，按时间合并——输出框的数据源。 */
      const allEvents = useMemo(
        () => [...(preview?.events ?? []), ...localEvents].sort((a, b) => a.at - b.at),
        [preview, localEvents],
      )

      const startService = () => run('start', async () => {
        const startedAt = Date.now()
        const result = await call('serviceStart', {})
        if (result?.alreadyRunning) {
          await load(true)
          return 'ComfyUI 已经在跑'
        }
        // detach 出去之后马上留个痕：有没有 pid、用没用兜底、日志在哪，用户当场就能看见。
        const pidText = result?.pid === null || result?.pid === undefined ? '无 pid' : 'pid ' + result.pid
        setNotice({
          kind: result?.pid ? 'ok' : 'error',
          text: '已提交拉起（' + pidText + (result?.fallback ? '，主脚本失败已改走 cmd start' : '') + '），最多等 120 秒；日志：' + (result?.launchLog ?? '（没有）'),
        })
        while (Date.now() - startedAt < 120_000) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
          const current = await call('probe', {})
          if (current?.service === 'up') {
            await load(true)
            return 'ComfyUI 已就绪（' + Math.round((Date.now() - startedAt) / 1000) + ' 秒）'
          }
        }
        throw new Error('120 秒内没起来。拉起日志：' + (result?.launchLog ?? '（无）') + '；ComfyUI 日志：' + (result?.log ?? 'C:\\Comfyui Driver\\ComfyUI\\comfyui-launch.log'))
      })

      /**
       * 关掉 ComfyUI 进程。
       *
       * 两步确认：第一次点只会亮起「确认关闭?」并留一行日志，4 秒内再点才真杀。
       * 杀完重新探一次服务，页面上的状态跟着变。
       */
      const stopService = () => run('stopService', async () => {
        const result = await call('serviceStop', {})
        await load(true)
        const pidText = Array.isArray(result?.pids) && result.pids.length > 0 ? '（pid ' + result.pids.join(', ') + '）' : ''
        if (result?.stopped === true) return '已关闭 ComfyUI' + pidText
        if (result?.note) return result.note
        return result?.reason ?? '没关掉（没查到原因）'
      })

      const bindDirectory = () => run('bind', async () => {
        const ui = bridge.ctx?.get?.('uiWorkspace')
        if (!ui || typeof ui.pickDirectory !== 'function') throw new Error('宿主没有 uiWorkspace 服务，无法选目录')
        const picked = await ui.pickDirectory()
        if (picked === null || picked === undefined) return null
        const result = await call('workspaceBind', { path: picked })
        await load(false)
        return '已绑定：' + (result?.bound?.path ?? picked)
      })

      const createDefault = () => run('bind', async () => {
        const result = await call('workspaceBind', { path: 'C:\\DSH\\Projects\\代码开发', title: '代码开发' })
        await load(false)
        return '已创建并绑定：' + (result?.bound?.path ?? '')
      })

      const saveFile = () => run('saveFile', async () => {
        const result = await call('submit', { text, mode: 'file' })
        return '已写入 ' + result.path
      })

      /** `override` 是给模型库抽屉用的：把安装建议整段写进草稿，而不是输入框里的提示词。 */
      const fillDraft = (override) => run('draft', async () => {
        const draftPrompt = typeof override === 'string' && override.trim().length > 0 ? override : text
        const ctx = bridge.ctx
        const store = ctx?.get?.('workspaces')
        const ui = ctx?.get?.('uiWorkspace')
        if (!ui || typeof ui.startSession !== 'function') throw new Error('宿主没有 uiWorkspace.startSession')
        if (!bound?.path) throw new Error('还没有绑定工作区')
        let workspaceId = bound.workspaceId
        if (!workspaceId) {
          const snap = store?.list?.getSnapshot?.()
          const rows = Array.isArray(snap?.items) ? snap.items : []
          const hit = rows.find((row) => row.path === bound.path)
          if (hit) workspaceId = hit.workspaceId ?? hit.id
          else if (store && typeof store.create === 'function') {
            const created = await store.create({ path: bound.path })
            workspaceId = created?.workspaceId ?? created?.id ?? null
          }
        }
        if (!workspaceId) throw new Error('拿不到工作区 id：先在宿主里打开一次该工作区')
        ui.startSession(workspaceId, { prompt: draftPrompt, whenDraftExists: 'replace' })
        return '已填入草稿（未发送）'
      })

      /**
       * 大模型改写：两阶段。
       * 阶段 A 判定要不要写反向提示词（要写才写），阶段 B 按工作流风格改写正向并覆盖原文。
       * 阶段 B 失败时反向框保留 A 的结果、原文不动——这是刻意的，别回滚成「什么都没发生」。
       */
      const rewrite = () => run('rewrite', async () => {
        const token = makeToken()
        rewriteTokenRef.current = token
        setUndoRef({ text, negative })
        setRewriteGif('/dsh-comfy/asset/thinking.gif?t=' + Date.now())
        setRewritePhase('plan')
        setThinkLog([])
        setThinkInfo({ phase: '判定中', policy: null, reason: '', model: '' })
        appendThink('info', '开始判定 · 工作流 ' + (workflowId.length > 0 ? workflowId : '（默认）'))
        /** 有没有真的写过框：没写过就别留一个点了也白点的「撤销改写」。 */
        let dirty = false
        try {
          const plan = await call('rewritePlan', {
            text,
            loras,
            workflowId: workflowId || undefined,
            stylePrompt: styleRef !== null ? styleRef.prompt : undefined,
            negativeCurrent: negative,
            provider: pick.provider || undefined,
            model: pick.model || undefined,
            token,
          })
          if (plan?.cancelled === true) {
            if (!dirty) setUndoRef(null)
            return '已取消改写'
          }
          const policy = plan?.policy ?? {}
          setThinkInfo({
            phase: plan?.need === true ? '已判定：写' : '已判定：不写',
            policy,
            reason: plan?.reason ?? '',
            model: plan?.model ?? '',
            reasoning: '',
            persona: plan?.persona ?? null,
          })
          appendThink('info', '工作流 ' + String(policy.title ?? policy.workflowId ?? '—')
            + ' · ' + (policy.cfgLinked === true ? 'cfg 连线' : 'cfg ' + String(policy.cfg ?? '未知'))
            + ' · 负面' + (policy.negativeEffective === true ? '生效' : '不生效'))
          appendThink('info', '人设：' + (plan?.persona?.applied === true
            ? '已接入全局内容尺度（' + String(plan.persona.chars) + ' 字）'
            : '未接入'))
          if (plan?.need === true && typeof plan.negative === 'string' && plan.negative.length > 0) {
            setNegative(plan.negative)
            dirty = true
            appendThink('ok', '反向提示词已' + (plan.action === 'append' ? '追加' : '写入') + '：' + plan.negative)
          } else {
            appendThink('info', '不写反向提示词：' + (plan?.reason ?? '（没给理由）'))
          }
          setRewritePhase('apply')
          const applied = await call('rewriteApply', {
            text,
            loras,
            workflowId: workflowId || undefined,
            negative: plan?.need === true ? (plan.negative ?? '') : '',
            planReason: plan?.reason ?? '',
            stylePrompt: styleRef !== null ? styleRef.prompt : undefined,
            provider: pick.provider || undefined,
            model: pick.model || undefined,
            token,
          })
          if (applied?.cancelled === true) {
            if (!dirty) setUndoRef(null)
            return '已取消改写'
          }
          setText(applied.positive)
          dirty = true
          appendThink('ok', '正向提示词已覆盖原文（' + String(applied.positive.length) + ' 字）')
          setThinkInfo((previous) => ({
            ...(previous ?? {}),
            phase: '完成',
            reasoning: applied.reasoning ?? '',
            model: applied.model ?? (previous?.model ?? ''),
          }))
          const cfgText = policy.cfgLinked === true
            ? 'cfg 由连线决定'
            : (policy.cfg === null || policy.cfg === undefined ? 'cfg 未知' : 'cfg=' + String(policy.cfg))
          const head = '已改写 · ' + (applied.model ?? '') + ' · ' + cfgText
          const why = typeof plan?.reason === 'string' ? plan.reason : ''
          return why.length > 0 ? head + String.fromCharCode(10) + '判定：' + why : head
        } catch (error) {
          if (!dirty) setUndoRef(null)
          appendThink('error', describe(error))
          setThinkInfo((previous) => ({ ...(previous ?? {}), phase: '失败' }))
          throw error
        } finally {
          setRewritePhase('')
          rewriteTokenRef.current = ''
        }
      })

      /** 取消：真正的中止在宿主半，页面只负责别再往两个框里写。 */
      const cancelRewrite = () => {
        const token = rewriteTokenRef.current
        if (token.length === 0) return
        void call('rewriteCancel', { token }).catch(() => null)
        appendThink('warn', '已请求取消改写')
      }

      /** 撤销：把点击前的两个框原样写回（受控 textarea 的 Ctrl+Z 不可靠）。 */
      const undoRewrite = () => {
        if (undoRef === null) return
        setText(undoRef.text)
        setNegative(undoRef.negative)
        setUndoRef(null)
        setNotice({ kind: 'ok', text: '已撤销改写：输入框与反向框都回到点击前' })
        appendThink('info', '已撤销改写')
      }

      const generateOne = () => run('generate', async () => {
        // 画风在前、画面在后：画风描述是整段风格句，放前面才不会被画面的主语截断。
        const composed = styleRef !== null && styleRef.prompt.length > 0
          ? styleRef.prompt + (text.trim().length > 0 ? '\n\n' + text.trim() : '')
          : text
        const result = await call('generate', {
          prompt: composed,
          workflowId: workflowId.length > 0 ? workflowId : undefined,
          negative,
          checkpoint: checkpoint || undefined,
          width: size.width,
          height: size.height,
          steps,
          // 勾选顺序就是槽位顺序；空数组 = 不动工作流自带的 LoRA。
          loras: loraSel.map((item) => ({ name: item.name, strength: item.strength })),
          folder: genFolder || undefined,
          preview: previewOn ? previewMethod : false,
        })
        // 新任务：预览游标与本地日志都清零，旧帧不能混进来。
        previewSinceRef.current = 0
        setPreview(null)
        setLocalEvents([])
        const short = result.promptId.slice(0, 8)
        addLocal('info', '已提交 ' + result.workflow + '（' + short + '）')
        if (loraSel.length > 0) addLocal('info', 'LoRA：' + loraSel.map((item) => item.name + '@' + item.strength).join(' → '))
        if (result.previewEnabled === false) addLocal('info', '本次没有开逐步预览')
        else if (result.previewConnected === false) addLocal('warn', '逐步预览连不上，本次只看成品图（出图不受影响）')
        setJob({
          promptId: result.promptId,
          state: 'running',
          images: [],
          previewConnected: result.previewConnected,
          previewMethod: result.previewMethod,
        })
        const notes = Array.isArray(result.notes) && result.notes.length > 0 ? '；' + result.notes.join('；') : ''
        const where = result.folder ? '，归入 ' + result.folder : ''
        return '已提交 ' + result.workflow + '（' + short + '）' + where + notes
      })

      /** 放大：输出框的成品图 + 输入框的画风图，一起交给宿主超分，成品回放大输出框。 */
      const upscaleOne = () => run('upscale', async () => {
        const items = []
        const outImage = job?.images?.[0] ?? null
        if (outImage !== null) {
          items.push({ source: 'output', rel: (outImage.subfolder ? outImage.subfolder + '/' : '') + outImage.filename })
        }
        if (styleRef !== null && typeof styleRef.rel === 'string' && styleRef.rel.length > 0) {
          items.push({ source: 'catalog', rel: styleRef.rel })
        }
        if (items.length === 0) throw new Error('没有可放大的图：先出一张，或在画风图库里套一个画风')
        const result = await call('upscale', { items, model: upscaleModel || undefined, scale: upscaleScale })
        upscaleDoneRef.current = false
        setUpscaleMeta(result)
        setUpscaleJob({ promptId: result.promptId, state: 'running', images: [] })
        const head = '已提交放大 · ' + result.model + ' · ' + result.scale + 'x · ' + items.length + ' 张'
        addLocal('info', head)
        if (Array.isArray(result.notes) && result.notes.length > 0) {
          addLocal('warn', result.notes.join('；'))
          return head + '（' + result.notes.join('；') + '）'
        }
        return head
      })

      const upscaleDownload = () => {
        const first = upscaleJob?.images?.[0]
        if (!first) return
        try {
          setNotice({ kind: 'ok', text: downloadFromUrl(first.url, first.filename) })
        } catch (error) {
          setNotice({ kind: 'error', text: describe(error) })
        }
      }

      const upscaleCopy = () => run('upscaleCopy', async () => {
        const first = upscaleJob?.images?.[0]
        if (!first) throw new Error('还没有放大成品')
        const message = await copyImageFromUrl(first.url)
        addLocal('info', message)
        return message
      })

      const upscaleSave = () => run('upscaleSave', async () => {
        const first = upscaleJob?.images?.[0]
        if (!first) throw new Error('还没有放大成品')
        const rel = (first.subfolder ? first.subfolder + '/' : '') + first.filename
        const saved = await call('saveImage', { rel })
        addLocal('info', '已存到 ' + saved.path)
        return '已存到 ' + saved.path
      })

      /** 停止：命中 /api/jobs/<id>/cancel，退不动走兼容两条；已完成不误报。 */
      const stopOne = () => run('stop', async () => {
        const promptId = job?.promptId
        if (!promptId) throw new Error('当前没有任务')
        const result = await call('stop', { promptId })
        if (result.outcome === 'already-done') {
          addLocal('info', '任务已经出完，无需停止')
          return '任务已经出完了'
        }
        if (result.outcome === 'not-running') {
          addLocal('info', '队列里没有这个任务')
          return '队列里没有这个任务'
        }
        addLocal('warn', '已发送停止请求（' + result.method + '）')
        setJob((previous) => (previous?.promptId === promptId ? { ...previous, state: 'interrupted' } : previous))
        setPreview((previous) => (previous === null ? previous : { ...previous, state: 'interrupted' }))
        return result.outcome === 'cancelled'
          ? '已停止' + (Number.isFinite(result.step) && result.step > 0 ? '（第 ' + result.step + ' 步）' : '')
          : '停止请求已发出'
      })

      /** 存到工作区白名单目录：`<工作区>\.dsh-comfy\images\<年-月>\`，不覆盖同名。 */
      const saveToWorkspace = () => run('save', async () => {
        const promptId = job?.promptId
        if (!promptId) throw new Error('还没有成品图')
        const saved = await call('saveImage', { promptId })
        addLocal('info', '已存到 ' + saved.path)
        return '已存到 ' + saved.path
      })

      /** 浏览器下载：插件不写盘，交给宿主下载机制。 */
      const downloadImage = () => {
        const first = job?.images?.[0]
        if (!first) return
        try {
          setNotice({ kind: 'ok', text: downloadFromUrl(first.url, first.filename) })
          addLocal('info', '已发起浏览器下载：' + first.filename)
        } catch (error) {
          setNotice({ kind: 'error', text: describe(error) })
        }
      }

      const copyImage = () => run('copy', async () => {
        const first = job?.images?.[0]
        if (!first) throw new Error('还没有成品图')
        const message = await copyImageFromUrl(first.url)
        addLocal('info', message)
        return message
      })

      const copyLog = () => run('copyLog', async () => {
        await navigator.clipboard.writeText(logText(allEvents))
        return '日志已复制'
      })

      /** 预览开关：只影响下一个任务（ComfyUI 的 preview_method 是任务级参数）。 */
      const changePreview = (value) => {
        const next = value === 'none' ? previewMethod : value
        const enabled = value !== 'none'
        setPreviewOn(enabled)
        setPreviewMethod(next)
        void call('config', { patch: { previewEnabled: enabled, previewMethod: next } }).catch(() => null)
        addLocal('info', enabled ? '预览方式已改为 ' + next + '（下一个任务生效）' : '已关闭逐步预览（下一个任务生效）')
      }

      const clearPreview = () => {
        previewSinceRef.current = 0
        setPreview(null)
      }

      const openStep = (frame) => {
        // 复用灯箱：把帧当成一张临时图。
        setLightboxImage({
          name: '第 ' + frame.step + ' 步',
          url: frame.url,
          rel: '',
          folder: '',
          size: frame.bytes,
          mtime: frame.at,
        })
      }

      const busyNow = busy.length > 0
      const serviceUp = env?.service === 'up'
      const promptReady = text.trim().length > 0 || (styleRef !== null && styleRef.prompt.length > 0)
      // 放大输出：这次会放大的图（输出框成品 + 输入框画风图），按钮与提示里都用它。
      const upscaleSourceLabels = []
      if ((job?.images?.length ?? 0) > 0) upscaleSourceLabels.push('输出框那张（' + job.images[0].filename + '）')
      if (styleRef !== null && typeof styleRef.rel === 'string' && styleRef.rel.length > 0) upscaleSourceLabels.push('输入框的画风图（' + styleRef.name + '）')

      // 工作流：清单来自 workflows/index.json，ready 是「模型够不够」的判定。
      const workflowItems = workflowList?.items ?? []
      const currentWorkflow = workflowItems.find((item) => item.id === workflowId) ?? null
      const workflowOptions = [
        h('option', { key: '', value: '' }, '（默认：anima 那份）'),
        ...workflowItems.map((item) => h('option', {
          key: item.id,
          value: item.id,
        }, (item.ready === false ? '⚠ ' : '') + item.skill.replace('comfyui-', '') + ' · ' + item.title)),
      ]
      // 底模候选跟着工作流的载入器走：UNETLoader 认 unet/+diffusion_models，CheckpointLoaderSimple 认 checkpoints/。
      const loaderKind = currentWorkflow?.summary?.loader ?? null
      const checkpointOptions = (() => {
        const lists = workflowList?.have ?? null
        if (lists === null) return checkpoints
        if (loaderKind === 'checkpoint') return lists.checkpoints ?? []
        if (loaderKind === 'unet') return lists.unet ?? []
        return [...new Set([...(lists.checkpoints ?? []), ...(lists.unet ?? [])])]
      })()
      const workflowHint = currentWorkflow === null
        ? (workflowItems.length > 0 ? workflowItems.length + ' 份已导入' : '还没导入工作流')
        : [
          currentWorkflow.summary?.unet?.[0] ?? currentWorkflow.summary?.checkpoints?.[0] ?? null,
          Number.isFinite(currentWorkflow.summary?.steps) ? currentWorkflow.summary.steps + ' 步' : null,
          currentWorkflow.summary?.width ? currentWorkflow.summary.width + '×' + currentWorkflow.summary.height : null,
        ].filter(Boolean).join(' · ')

      // ---- LoRA 多选 ----
      // 工作流的 LoraLoader 槽位与默认值：勾几个就按顺序写进前几个槽，剩下的槽保持工作流自带的那几个。
      const loraSlotDefaults = (() => {
        const source = currentWorkflow ?? workflowItems.find((item) => item.id === 'anima__Anima Aesthetic v1.1') ?? null
        const list = source?.summary?.loras
        if (!Array.isArray(list)) return []
        return list.filter((item) => item && typeof item.name === 'string')
      })()
      const loraSlotCount = loraSlotDefaults.length
      const loraBase = dirs?.files?.loras ?? []
      // 配置里记着、盘上却已经没有的 LoRA 也留在表里并标出来，别让选择静默消失。
      const loraChoices = [...loraBase, ...loraSel.map((item) => item.name).filter((name) => !loraBase.includes(name))]

      // LoRA 文件名也翻：中文名压上面、原始文件名留一行小字（点开面板才翻，省 token）。
      /** 这个 LoRA 有没有触发词（键按小写文件名查）。 */
      const triggerWordsFor = (name) => {
        const hit = triggerMap[String(name).toLowerCase()]
        return hit !== undefined && Array.isArray(hit.words) && hit.words.length > 0 ? hit.words : null
      }

      /** 面板上只给一小段，完整内容在 title 与复制结果里。 */
      const triggerLabel = (name) => {
        const words = triggerWordsFor(name)
        if (words === null) return ''
        const text = words.join(', ')
        return text.length > 16 ? text.slice(0, 16) + '…' : text
      }


      /** 拿文件名去 Civitai 回填触发词；查不到就如实说，不编。 */
      const lookupTriggers = async (names) => {
        const todo = [...new Set((Array.isArray(names) ? names : []).filter((name) => typeof name === 'string' && name.length > 0))].slice(0, 8)
        if (todo.length === 0) return
        if (triggerBusy.length > 0) return
        setTriggerBusy(todo[0])
        setNotice({ kind: 'ok', text: '正在 Civitai 查触发词：' + todo.join('、') })
        try {
          const answer = await call('hubLookupTriggers', { names: todo })
          if (answer !== null && answer !== undefined && answer.items && typeof answer.items === 'object') setTriggerMap(answer.items)
          const found = Array.isArray(answer?.found) ? answer.found : []
          const missed = Array.isArray(answer?.missed) ? answer.missed : []
          if (found.length > 0) {
            setNotice({ kind: 'ok', text: '已记下 ' + found.length + ' 个触发词：' + found.map((item) => item.name + ' → ' + item.words.join(', ')).join('；') + (missed.length > 0 ? '；没查到 ' + missed.join('、') : '') })
          } else {
            setNotice({ kind: 'warn', text: '没查到（文件名在 Civitai 对不上）：' + missed.join('、') })
          }
        } catch (failure) {
          setNotice({ kind: 'error', text: describe(failure) })
        } finally {
          setTriggerBusy('')
        }
      }

      /** 点一下复制到剪贴板，多个词按逗号拼好。 */
      const copyTrigger = async (name) => {
        const words = triggerWordsFor(name)
        if (words === null) return
        try {
          await navigator.clipboard.writeText(words.join(', '))
          setNotice({ kind: 'ok', text: '已复制触发词：' + words.join(', ') })
        } catch {
          setNotice({ kind: 'error', text: '复制失败，手动抄：' + words.join(', ') })
        }
      }
      useEffect(() => {
        if (!loraOpen || !zhLoraOn) return undefined
        const todo = [...new Set(loraChoices
          .filter((name) => zhLoras[name] === undefined)
          .map((name) => cleanLoraName(name)))]
          .filter((text) => text.length > 0)
          .slice(0, 24)
        if (todo.length === 0) return undefined
        let cancelled = false
        void (async () => {
          try {
            const answer = await call('hubTranslate', { texts: todo, style: 'lora' })
            if (cancelled) return
            const rows = Array.isArray(answer?.items) ? answer.items : []
            const map = new Map(rows.map((row) => [String(row?.source ?? ''), String(row?.zh ?? '')]))
            setZhLoras((current) => {
              const next = { ...current }
              for (const name of loraChoices) {
                const zh = map.get(cleanLoraName(name))
                if (typeof zh === 'string' && zh.length > 0) next[name] = zh
              }
              return next
            })
          } catch {
            /* 翻不出来就显示原名 */
          }
        })()
        return () => { cancelled = true }
      }, [loraOpen, zhLoraOn, loraChoices, zhLoras, call])
      /** 勾/取消一个 LoRA：勾上的追加到末尾，于是勾选顺序就是写入顺序。 */
      const toggleLora = (name, on) => setLoraSel((current) => {
        if (!on) return current.filter((item) => item.name !== name)
        if (current.some((item) => item.name === name)) return current
        // 新勾的按「它要占的那个槽」原本的强度起手（anima 的槽是 0.8），省得每次手改。
        const fallback = loraSlotDefaults[current.length]?.strength
        return [...current, { name, strength: Number.isFinite(fallback) ? fallback : 1 }]
      })
      const setLoraStrength = (name, value) => setLoraSel((current) => current.map((item) => (
        item.name === name ? { ...item, strength: Number.isFinite(value) ? value : item.strength } : item
      )))
      const loraButtonLabel = loraSel.length === 0
        ? 'LoRA ' + loraBase.length + ' 可用'
        : 'LoRA ' + loraSel.length + (loraSlotCount > 0 ? '/' + loraSlotCount : '') + ' 已选'
      const loraFooter = (() => {
        if (currentWorkflow !== null && loraSlotCount === 0) return '这份工作流里没有 LoraLoader 节点，勾了也写不进去。'
        if (loraSel.length === 0) {
          const defaults = loraSlotDefaults.map((item) => item.name + '@' + item.strength).join(' → ')
          return defaults.length > 0 ? '没勾＝完全按工作流自带的：' + defaults : '没勾＝完全按工作流自带的 LoRA。'
        }
        const applied = loraSel.slice(0, loraSlotCount > 0 ? loraSlotCount : loraSel.length)
          .map((item, index) => {
            const original = loraSlotDefaults[index]
            const replaced = original && original.name !== item.name ? '（替掉 ' + original.name + '）' : ''
            return '槽' + (index + 1) + ' ' + item.name + '@' + item.strength + replaced
          })
          .join(' · ')
        const overflow = loraSlotCount > 0 && loraSel.length > loraSlotCount
          ? '；工作流只有 ' + loraSlotCount + ' 个槽，多出的 ' + (loraSel.length - loraSlotCount) + ' 个不会写入'
          : ''
        // 4 步 / 蒸馏档的加速 LoRA 就占在这些槽里，被顶掉以后加速档会崩，得说清楚。
        const replacedAny = loraSlotDefaults.some((item, index) => index < loraSel.length && item.name !== loraSel[index]?.name)
        const warning = replacedAny ? '；被替掉的默认 LoRA 本次不加载（蒸馏加速 LoRA 也占这类槽，换掉它加速档会失效）' : ''
        return applied + overflow + warning
      })()

      return h('div', { className: 'cw-root' }, [
        h('div', { className: 'cw-head', key: 'head' }, [
          h('h2', { className: 'cw-title', key: 'title' }, 'ComfyUI 工作台'),
          h('span', {
            className: 'cw-badge ' + (serviceUp ? 'up' : 'down'),
            key: 'badge',
          }, serviceUp ? '服务在线' : '服务未启动'),
          h('span', { className: 'cw-spacer', key: 'sp' }),
          h('button', {
            className: 'cw-btn', key: 'refresh', disabled: busyNow,
            onClick: () => { void load(true) },
          }, busy === 'refresh' ? '刷新中…' : '刷新目录'),
          serviceUp ? h('button', {
            className: 'cw-btn' + (stopArm ? ' danger' : ''),
            key: 'stop',
            disabled: busyNow,
            title: stopArm ? '再点一次就杀掉 ComfyUI 进程（树）' : '关掉 ComfyUI 进程',
            onClick: () => {
              if (!stopArm) {
                setStopArm(true)
                // 4 秒内不确认就自动回到未上膛，免得误点后一直等着
                window.setTimeout(() => setStopArm(false), 4000)
                addLocal('warn', '再点一次「确认关闭?」就会杀掉 ComfyUI 进程（含子进程）')
                return
              }
              setStopArm(false)
              void stopService()
            },
          }, busy === 'stopService' ? '关闭中…' : (stopArm ? '确认关闭?' : '关闭 ComfyUI')) : null,
          serviceUp ? null : h('button', {
            className: 'cw-btn primary', key: 'start', disabled: busyNow,
            onClick: () => { void startService() },
          }, busy === 'start' ? '拉起中…' : '一键拉起'),
        ]),

        h('div', { className: 'cw-tabs', key: 'tabs' }, [
          h('button', { className: 'cw-tab' + (tab === 'work' ? ' active' : ''), key: 'work', onClick: () => setTab('work') }, '工作台'),
          h('button', { className: 'cw-tab' + (tab === 'gallery' ? ' active' : ''), key: 'gallery', onClick: () => setTab('gallery') }, '我的图库'),
          h('button', { className: 'cw-tab' + (tab === 'catalog' ? ' active' : ''), key: 'catalog', onClick: () => setTab('catalog') }, '画风图库'),
          h('button', { className: 'cw-tab' + (tab === 'hub' ? ' active' : ''), key: 'hub', onClick: () => setTab('hub') }, '模型库 · Civitai'),
        ]),

        tab === 'hub' ? h('div', { className: 'cw-body', key: 'hub' }, [
          h(HubPane, {
            key: 'hub',
            call,
            onLoraAdd: (name, strength) => setLoraSel((current) => (
              current.some((item) => item.name === name) ? current : [...current, { name, strength }]
            )),
            onRefreshDirs: () => { void load(true) },
            onDraft: (report) => { void fillDraft(report) },
            // 助手给的标签点一下就拼进工作台输入框；Prompt 也一起带过去，问「还缺什么」时它看得见。
            promptText: text,
            onInsertPrompt: (chunk) => setText((current) => (current.trim().length === 0 ? chunk : current.replace(/\s+$/, '') + ', ' + chunk)),
          }),
        ]) : tab === 'work' ? null : h('div', { className: 'cw-body', key: 'library' }, [
          tab === 'gallery'
            ? h(LibraryPane, { key: 'g', source: 'output', onPickFolder: (next) => setGenFolder(next) })
            : h(LibraryPane, {
              key: 'c',
              source: 'catalog',
              onPickFolder: () => {},
              onApplyStyle: (item) => {
                setStyleRef({
                  name: item.displayName ?? item.name,
                  category: item.category ?? null,
                  prompt: typeof item.prompt === 'string' ? item.prompt : '',
                  url: item.url,
                  // 放大要拿画风图本身：只记 url 宿主定位不到文件。
                  rel: typeof item.rel === 'string' ? item.rel : '',
                })
                setTab('work')
              },
            }),
        ]),

        tab === 'work' ? h('div', { className: 'cw-body', key: 'body' }, [
          notice ? h(Msg, { kind: notice.kind, key: 'notice' }, notice.text) : null,

          serviceUp ? null : h('div', { className: 'cw-card cw-warn', key: 'warn' }, [
            h('div', { className: 'cw-warn-line', key: 'line' }, [
              h('p', { className: 'cw-warn-text', key: 'w' }, 'ComfyUI 没在 ' + (env?.comfyUrl ?? '') + ' 上响应（' + (env?.serviceError ?? '未探到') + '）。目录仍可读，出图要等服务起来。'),
            ]),
          ]),

          h('div', { className: 'cw-card', key: 'env' }, [
            h('div', { className: 'cw-card-head', key: 'h' }, [h('h3', { className: 'cw-card-title', key: 't' }, '环境')]),
            h('dl', { className: 'cw-facts', key: 'facts' }, [
              h(Fact, { key: 'url', label: '服务地址', value: env?.comfyUrl ?? '—', mono: true }),
              h(Fact, { key: 'base', label: '模型根', value: dirs?.modelBase ?? '—', mono: true }),
              h(Fact, { key: 'ckpt', label: '底模 / LoRA', value: checkpoints.length + ' / ' + loras.length }),
              h(Fact, { key: 'out', label: '输出', value: (dirs?.output ?? '—') + ' → ' + (dirs?.outputReal ?? '—'), mono: true }),
              h(Fact, { key: 'in', label: '输入', value: dirs?.inputReal ?? '—', mono: true }),
            ]),
            h('div', { className: 'cw-row', key: 'wf' }, [
              h('span', { className: 'cw-label', key: 'l' }, '工作流'),
              h('select', {
                className: 'cw-select', value: workflowId, key: 's',
                style: { maxWidth: 'none', flex: '1 1 320px' },
                onChange: (event) => {
                  const next = event.target.value
                  setWorkflowId(next)
                  // 换工作流就把尺寸/步数对齐到它的默认值；不然上一份留下的值会悄悄盖掉新工作流。
                  const picked = workflowItems.find((item) => item.id === next)
                  const summary = picked?.summary ?? {}
                  if (Number.isFinite(summary.width) && Number.isFinite(summary.height)) {
                    setSize({ width: summary.width, height: summary.height })
                  }
                  if (Number.isFinite(summary.steps)) setSteps(summary.steps)
                  // 底模候选跟着 loader 类型变，换工作流就回到「工作流默认」。
                  setCheckpoint('')
                  // LoRA 槽也跟着换：anima 两个槽、moss 一个槽，上一份的勾选留着会顶掉新工作流自带的 LoRA。
                  setLoraSel([])
                  if (undoRef !== null) {
                    setNotice({ kind: 'warn', text: '输入框里的提示词是按上一份工作流改写的，换工作流后建议再点一次「大模型改写」' })
                  }
                },
              }, workflowOptions),
              h('span', { className: 'cw-chip', key: 'c' }, workflowHint),
            ]),
            currentWorkflow !== null && currentWorkflow.missing.length > 0
              ? h(Msg, { kind: 'error', key: 'wfmiss' }, '这份工作流缺模型（出图会被 ComfyUI 拒）：' + currentWorkflow.missing.join('、'))
              : null,
            h('div', { className: 'cw-grid', key: 'grid' }, [
              h('label', { className: 'cw-row', key: 'ckpt' }, [
                h('span', { className: 'cw-label', key: 'l' }, '底模'),
                h('select', {
                  className: 'cw-select', value: checkpoint, key: 's',
                  onChange: (event) => setCheckpoint(event.target.value),
                }, [h('option', { key: '', value: '' }, '（工作流默认）')].concat(
                  checkpointOptions.map((name) => h('option', { key: name, value: name }, name)),
                )),
              ]),
              h('label', { className: 'cw-row', key: 'size' }, [
                h('span', { className: 'cw-label', key: 'w' }, '尺寸'),
                h('input', {
                  className: 'cw-input cw-num', type: 'number', min: 256, max: 2048, step: 64, key: 'iw',
                  value: size.width,
                  onChange: (event) => setSize((current) => ({ ...current, width: Number(event.target.value) || current.width })),
                }),
                h('span', { className: 'cw-label', key: 'x' }, '×'),
                h('input', {
                  className: 'cw-input cw-num', type: 'number', min: 256, max: 2048, step: 64, key: 'ih',
                  value: size.height,
                  onChange: (event) => setSize((current) => ({ ...current, height: Number(event.target.value) || current.height })),
                }),
              ]),
              h('div', { className: 'cw-row', key: 'steps' }, [
                h('span', { className: 'cw-label', key: 'l' }, '步数'),
                h('input', {
                  className: 'cw-input cw-num', type: 'number', min: 1, max: 60, step: 1, key: 'i',
                  value: steps,
                  onChange: (event) => setSteps(Number(event.target.value) || steps),
                }),
                // LoRA 多选器：徽标就是开关，点开在它下面挂一个下拉面板。
                h('span', { className: 'cw-lora', key: 'lora', ref: loraPopRef }, [
                  h('button', {
                    className: 'cw-chip cw-chip-btn', key: 'c', type: 'button',
                    'aria-expanded': loraOpen ? 'true' : 'false',
                    title: '按勾选顺序写进工作流的 LoRA 槽；一个都不勾就用工作流自带的',
                    onClick: () => setLoraOpen((current) => !current),
                  }, loraButtonLabel + (loraOpen ? ' ▲' : ' ▼')),
                  loraOpen
                    ? h('div', { className: 'cw-lora-pop', key: 'pop' }, [
                    h('div', { className: 'cw-lora-head', key: 'h' }, [
                      h('span', { className: 'cw-card-title', key: 't' }, 'LoRA 多选'),
                      // 面板窄，槽位只留数字；完整说明在页脚。
                      h('span', { className: 'cw-chip', key: 'slot' }, loraSlotCount > 0 ? loraSlotCount + ' 槽' : '无槽'),
                      loraSel.length > 0
                        ? h('span', { className: 'cw-chip', key: 'n' }, '已选 ' + loraSel.length + (loraSlotCount > 0 ? ' / ' + loraSlotCount + ' 槽' : ' 个'))
                        : null,
                      h('span', { className: 'cw-spacer', key: 'sp' }),
                      loraSel.length > 0
                        ? h('button', { className: 'cw-btn', key: 'clear', type: 'button', onClick: () => setLoraSel([]) }, '清空')
                        : null,
                      h('label', { className: 'cw-hub-src', key: 'zh', title: '用宿主大模型把文件名翻成中文（同一句只翻一次）' }, [
                        h('input', { key: 'c', type: 'checkbox', checked: zhLoraOn, onChange: (event) => setZhLoraOn(event.target.checked) }),
                        h('span', { key: 't' }, '翻译'),
                      ]),
                      h('button', {
                        className: 'cw-btn', key: 'trg', type: 'button',
                        disabled: triggerBusy.length > 0,
                        title: '把还没有触发词记录的 LoRA 一次性拿去 Civitai 查（最多 8 个）',
                        onClick: () => {
                          const todo = loraChoices.filter((name) => triggerWordsFor(name) === null).slice(0, 8)
                          if (todo.length === 0) setNotice({ kind: 'ok', text: '列表里的 LoRA 都有触发词了' })
                          else void lookupTriggers(todo)
                        },
                      }, triggerBusy.length > 0 ? '查…' : '补触发词'),
                      h('button', {
                        className: 'cw-btn', key: 'ref', type: 'button',
                        onClick: () => { void load(true) },
                      }, '刷新'),
                      h('button', { className: 'cw-btn', key: 'close', type: 'button', onClick: () => setLoraOpen(false) }, '完成'),
                    ]),
                    loraChoices.length === 0
                      ? h('p', { className: 'cw-empty', key: 'e' }, '没读到 LoRA 文件：ComfyUI 没起来时靠扫 models/loras，目录空着就是没有。')
                      : h('div', { className: 'cw-lora-list', key: 'list' }, loraChoices.map((name) => {
                        const order = loraSel.findIndex((item) => item.name === name)
                        const on = order >= 0
                        const onDisk = loraBase.includes(name)
                        return h('div', { className: 'cw-lora-item' + (on ? ' on' : '') + (onDisk ? '' : ' missing'), key: name }, [
                          h('input', {
                            key: 'c', type: 'checkbox', checked: on,
                            onChange: (event) => toggleLora(name, event.target.checked),
                          }),
                          h('span', { className: 'cw-lora-idx' + (on ? '' : ' off'), key: 'i', title: on ? '写入第 ' + (order + 1) + ' 个 LoRA 槽' : '' }, on ? String(order + 1) : ''),
                          h('span', { className: 'cw-lora-name', key: 'n', title: name, onClick: () => toggleLora(name, !on) }, [
                        h('span', { key: 'zh' }, zhLoras[name] ?? name),
                        zhLoras[name] === undefined ? null : h('span', { className: 'cw-lora-en', key: 'en' }, name),
                      ]),
                          triggerWordsFor(name) === null
                        ? h('button', {
                          className: 'cw-lora-trigger missing', key: 'trg', type: 'button',
                          disabled: triggerBusy.length > 0,
                          title: '去 Civitai 按文件名查触发词，查到就记到本机',
                          onClick: () => { void lookupTriggers([name]) },
                        }, triggerBusy.length > 0 ? '查…' : '查触发词')
                        : h('button', {
                          className: 'cw-lora-trigger', key: 'trg', type: 'button',
                          title: '复制触发词：' + triggerWordsFor(name).join(', '),
                          onClick: () => { void copyTrigger(name) },
                        }, [
                          h('span', { key: 't' }, triggerLabel(name)),
                          h('span', { className: 'ic', key: 'i' }, '⧉'),
                        ]),
                      onDisk ? null : h('span', { className: 'cw-chip', key: 'm' }, '盘上没有'),
                          h('input', {
                            key: 's', className: 'cw-input cw-lora-str', type: 'number', step: 0.05, min: 0, max: 2,
                            value: on ? loraSel[order].strength : (loraSlotDefaults[order >= 0 ? order : 0]?.strength ?? 1),
                            disabled: !on,
                            title: '强度（model 与 clip 用同一个值）',
                            onChange: (event) => setLoraStrength(name, Number(event.target.value)),
                          }),
                        ])
                      })),
                      h('p', { className: 'cw-lora-foot', key: 'f' }, loraFooter),
                    ])
                    : null,
                ]),
              ]),
              h('label', { className: 'cw-row', key: 'model' }, [
                h('span', { className: 'cw-label', key: 'l' }, '大模型'),
                providerOptions.length === 0
                  ? h('span', { className: 'cw-chip', key: 'c' }, models?.reason ?? '无可用模型')
                  : h('select', {
                    className: 'cw-select', value: currentValue, key: 's',
                    onChange: (event) => {
                      const [provider, model] = event.target.value.split('::')
                      setPick({ provider, model })
                    },
                  }, providerOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label))),
              ]),
            ]),
          ]),

          h('div', { className: 'cw-split', key: 'editor' }, [
            h('div', { className: 'cw-card', key: 'editor-card' }, [
            h('div', { className: 'cw-card-head', key: 'h' }, [
              h('h3', { className: 'cw-card-title', key: 't' }, '输入框'),
              h('span', { className: 'cw-spacer', key: 'sp' }),
              h('span', { className: 'cw-label', key: 'n' }, text.length + ' 字'),
            ]),
            h('textarea', {
              className: 'cw-textarea',
              key: 'prompt',
              placeholder: '写画面。中文也行，点「大模型改写」会按当前工作流的风格改写这句话。这段话不占 DSH 聊天草稿。',
              value: text,
              spellCheck: false,
              onChange: (event) => setText(event.target.value),
            }),
            h('textarea', {
              className: 'cw-textarea',
              key: 'negative',
              style: { minHeight: '56px' },
              placeholder: '反向提示词（留空即用工作流里的默认值）',
              value: negative,
              spellCheck: false,
              onChange: (event) => setNegative(event.target.value),
            }),
            h('div', { className: 'cw-row', key: 'style' }, [
              h('span', { className: 'cw-label', key: 'l' }, '画风'),
              styleRef === null
                ? h('span', { className: 'cw-label', key: 'u' }, '未选（去「画风图库」挑一个，314 个画风各带提示词）')
                : [
                  h('img', { key: 'i', className: 'cw-style-thumb', src: styleRef.url, alt: styleRef.name }),
                  h('span', { className: 'cw-path', key: 'v', title: styleRef.prompt }, styleRef.name + (styleRef.category ? ' · ' + styleRef.category : '')),
                  h('button', { className: 'cw-btn', key: 'c', onClick: () => setStyleRef(null) }, '清除'),
                ],
              h('span', { className: 'cw-spacer', key: 'sp' }),
              h('button', { className: 'cw-btn', key: 'g', onClick: () => setTab('catalog') }, '去画风图库'),
            ]),
            h('div', { className: 'cw-row', key: 'bind' }, [
              h('span', { className: 'cw-label', key: 'l' }, '绑定工作区'),
              bound
                ? h('span', { className: 'cw-path', key: 'p' }, bound.alias + ' → ' + (bound.path ?? '（记录已失效）'))
                : h('span', { className: 'cw-label', key: 'u' }, '未绑定'),
              h('span', { className: 'cw-spacer', key: 'sp' }),
              h('button', { className: 'cw-btn', key: 'b', disabled: busyNow, onClick: () => { void bindDirectory() } }, busy === 'bind' ? '处理中…' : '更改'),
              bound ? null : h('button', { className: 'cw-btn', key: 'c', disabled: busyNow, onClick: () => { void createDefault() } }, '创建「代码开发」'),
            ]),
            h('div', { className: 'cw-row', key: 'folder' }, [
              h('span', { className: 'cw-label', key: 'l' }, '生图归入'),
              h('span', {
                className: genFolder.length > 0 ? 'cw-path' : 'cw-label',
                key: 'v',
              }, genFolder.length > 0 ? genFolder : '（自动：' + autoFolderHint(workflowId) + '）'),
              genFolder.length > 0
                ? h('button', { className: 'cw-btn', key: 'c', onClick: () => setGenFolder('') }, '清除')
                : null,
              h('span', { className: 'cw-spacer', key: 'sp' }),
              h('button', { className: 'cw-btn', key: 'g', onClick: () => setTab('gallery') }, '去图库选分类'),
            ]),
            h('div', { className: 'cw-row', key: 'actions' }, [
              h('button', { className: 'cw-btn', key: 'f', disabled: busyNow || text.trim().length === 0 || !bound, onClick: () => { void saveFile() } }, busy === 'saveFile' ? '写入中…' : '存为工作区文件'),
              h('button', { className: 'cw-btn', key: 'd', disabled: busyNow || text.trim().length === 0 || !bound, onClick: () => { void fillDraft() } }, busy === 'draft' ? '填入中…' : '填入会话草稿'),
              busy === 'rewrite'
                ? h('span', { key: 'r', className: 'cw-btn cw-btn-busy' }, h(ThinkIcon, {
                  src: rewriteGif,
                  phase: rewritePhase === 'apply' ? '思考中' : '判定中',
                }))
                : h('button', { className: 'cw-btn', key: 'r', disabled: busyNow || text.trim().length === 0 || providerOptions.length === 0, onClick: () => { void rewrite() } }, '大模型改写'),
              busy === 'rewrite'
                ? h('button', { className: 'cw-btn', key: 'cancel', onClick: () => { cancelRewrite() } }, '取消')
                : (undoRef !== null
                  ? h('button', { className: 'cw-btn', key: 'undo', disabled: busyNow, onClick: () => { undoRewrite() } }, '撤销改写')
                  : null),
              h('span', { className: 'cw-spacer', key: 'sp' }),
              h('button', { className: 'cw-btn primary', key: 'g', disabled: busyNow || !serviceUp || !promptReady, onClick: () => { void generateOne() } }, busy === 'generate' ? '提交中…' : '生成一张'),
            ]),
            ]),

            h('div', { className: 'cw-card cw-think-card', key: 'think' }, [
              h('div', { className: 'cw-card-head', key: 'h' }, [
                h('h3', { className: 'cw-card-title', key: 't' }, '思考'),
                thinkInfo !== null && thinkInfo.phase ? h('span', { className: 'cw-chip', key: 'p' }, thinkInfo.phase) : null,
                h('span', { className: 'cw-spacer', key: 'sp' }),
                thinkLog.length > 0 ? h('button', { className: 'cw-btn', key: 'c', onClick: clearThink }, '清空') : null,
              ]),
              thinkInfo === null && thinkLog.length === 0
                ? h('p', { className: 'cw-empty', key: 'e' }, '点「大模型改写」后，这里显示：判定要不要写负面、依据哪条工作流规则、模型给的理由、改完多少字。出图日志不在这里。')
                : null,
              thinkInfo !== null && thinkInfo.policy
                ? h('dl', { className: 'cw-facts', key: 'f' }, [
                  h(Fact, { key: 'wf', label: '工作流', value: thinkInfo.policy.title ?? thinkInfo.policy.workflowId ?? '—' }),
                  h(Fact, {
                    key: 'cfg',
                    label: 'cfg / 负面',
                    value: (thinkInfo.policy.cfgLinked === true ? '连线' : (thinkInfo.policy.cfg === null || thinkInfo.policy.cfg === undefined ? '未知' : String(thinkInfo.policy.cfg)))
                      + ' · ' + (thinkInfo.policy.negativeEffective === true ? '生效' : '不生效'),
                  }),
                  h(Fact, { key: 'need', label: '判定', value: thinkInfo.reason && thinkInfo.reason.length > 0 ? thinkInfo.reason : '（没有理由）' }),
                  h(Fact, { key: 'model', label: '模型', value: thinkInfo.model && thinkInfo.model.length > 0 ? thinkInfo.model : '—' }),
                  h(Fact, {
                    key: 'persona',
                    label: '人设',
                    value: thinkInfo.persona && thinkInfo.persona.applied === true
                      ? '已接入 · ' + String(thinkInfo.persona.chars) + ' 字'
                      : '未接入',
                  }),
                ])
                : null,
              thinkInfo !== null && thinkInfo.reasoning && thinkInfo.reasoning.length > 0
                ? h('p', { className: 'cw-note', key: 'r' }, '思考：' + thinkInfo.reasoning)
                : null,
              thinkLog.length > 0
                ? h('div', { className: 'cw-logbox', key: 'l', ref: thinkRef }, thinkLog.map((entry, index) => h('div', {
                  className: 'cw-logline' + (entry.kind ? ' ' + entry.kind : ''),
                  key: String(index) + '-' + String(entry.at),
                }, [
                  h('time', { key: 't' }, new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })),
                  h('span', { key: 'x' }, entry.text),
                ])))
                : null,
            ]),
          ]),

          h(StepPreview, {
            key: 'steps',
            preview,
            enabled: previewOn,
            steps: preview?.steps ?? [],
            total: preview?.total ?? 0,
            current: preview?.current ?? 0,
            note: preview?.note ?? null,
            dropped: preview?.dropped ?? 0,
            onOpenStep: openStep,
            onToggle: changePreview,
            onClear: clearPreview,
            busy: busyNow,
          }),

          h(OutputPane, {
            key: 'output',
            job,
            events: allEvents,
            logRef,
            paused: logPaused,
            onTogglePause: () => setLogPaused((value) => !value),
            onStop: () => { void stopOne() },
            onDownload: downloadImage,
            onSaveToWorkspace: () => { void saveToWorkspace() },
            onCopyImage: () => { void copyImage() },
            onCopyLog: () => { void copyLog() },
            onOpenImage: (image) => setLightboxImage({
              name: image.filename,
              url: image.url,
              rel: '',
              folder: image.subfolder ?? '',
              size: 0,
              mtime: Date.now(),
              fromJob: true,
            }),
            busy: busyNow,
            canStop: job !== null && typeof job.promptId === 'string' && (job.state === 'running' || job.state === 'queued'),
            canSave: job?.state === 'done' && (job.images?.length ?? 0) > 0,
          }),

          h(UpscalePane, {
            key: 'upscale',
            job: upscaleJob,
            meta: upscaleMeta,
            models: upscaleModels,
            model: upscaleModel,
            scale: upscaleScale,
            onModel: setUpscaleModel,
            onScale: setUpscaleScale,
            onRun: () => { void upscaleOne() },
            onOpenImage: (image) => setLightboxImage({
              name: image.filename,
              url: image.url,
              rel: (image.subfolder ? image.subfolder + '/' : '') + image.filename,
              folder: image.subfolder ?? '',
              size: 0,
              mtime: Date.now(),
            }),
            onDownload: upscaleDownload,
            onCopy: () => { void upscaleCopy() },
            onSave: () => { void upscaleSave() },
            busy: busyNow,
            running: busy === 'upscale',
            serviceUp,
            sources: upscaleSourceLabels,
          }),

          h('div', { className: 'cw-card', key: 'notes' }, [
            h('div', { className: 'cw-card-head', key: 'h' }, [h('h3', { className: 'cw-card-title', key: 't' }, '接口')]),
            h('p', { className: 'cw-empty', key: 'a' }, '同源 HTTP 给工作区脚本用：'),
            h('p', { className: 'cw-empty cw-path', key: 'b' }, 'GET  /dsh-comfy/v1/health · /v1/dirs · /v1/llm/models · /v1/workflows · /v1/gallery · /v1/catalog · /v1/preview · /v1/hub/status · /v1/hub/job · /dsh-comfy/preview/<步> · /dsh-comfy/hub/cover · /dsh-comfy/asset/thinking.gif'),
            h('p', { className: 'cw-empty cw-path', key: 'c' }, 'POST /dsh-comfy/v1/llm/complete · /v1/rewrite/plan · /v1/rewrite/apply · /v1/rewrite/cancel · /v1/workspace/submit · /v1/generate · /v1/upscale · /v1/stop · /v1/image/save · /v1/catalog/bind · /v1/hub/key · /v1/hub/search · /v1/hub/resolve · /v1/hub/download · /v1/hub/cancel · /v1/hub/advice · /v1/call'),
          ]),
        ]) : null,

        // 页面级灯箱：成品图与逐步预览帧共用，切标签页不丢。
        lightboxImage === null ? null : h(Lightbox, {
          key: 'lightbox',
          item: lightboxImage,
          onClose: () => setLightboxImage(null),
          onCopy: () => { void copyImageFromUrl(lightboxImage.url).then((message) => setNotice({ kind: 'ok', text: message }), (error) => setNotice({ kind: 'error', text: describe(error) })) },
          onSave: lightboxImage.fromJob === true ? () => { void saveToWorkspace() } : undefined,
        }),
      ])
    }

    // ------------------------------------------------------------------ apply

    function apply(ctx) {
      bridge.ctx = ctx
      ensureCss()
      const disposers = []
      disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL,
      }, Page)))
      disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL,
        order: 6,
        label: () => 'ComfyUI 工作台',
      }, Glyph)))
      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.()
          } catch {
            /* 卸载期失败不阻塞其它清理 */
          }
        }
        if (cssHandle !== null) {
          cssHandle.remove()
          cssHandle = null
        }
        bridge.ctx = null
      }
    }

    return { inject: ['slots'], apply }
  },
})
