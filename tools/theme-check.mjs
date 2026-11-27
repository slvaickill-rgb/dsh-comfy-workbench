/**
 * tools/theme-check.mjs — 主题可读性样张（v1.7：2 主题 × 5 尺寸 = 10 张 + 1 张兜底）
 *
 *   node tools/theme-check.mjs            # 生成 HTML 到系统临时目录，打印路径
 *   node tools/theme-check.mjs --shoot    # 再用本机 Chrome 逐张截图
 *
 * 为什么需要它：本机这套皮肤把 --dsw-alias-brand-primary 解析成**白色**，早先用
 * 「品牌色打底 + #fff 文字」的按钮直接消失。样张故意把 brand-primary 留成白色，
 * 用真实 CSS 渲染主按钮 / 选中分类 / 链接按钮，肉眼一眼就能看出还有没有同色文字。
 *
 * buildHtml / SIZES / THEMES 导出给 tools/visual-check.mjs 复用：同一份样张，
 * 静态断言（本文件）与无头量尺寸（visual-check）两条路，不重复维护两套 HTML。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUTTON = String.fromCharCode(96)
const LF = String.fromCharCode(10)
const BS = String.fromCharCode(92)

export const SIZES = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '390x844', width: 390, height: 844 },
  { name: '320x640', width: 320, height: 640 },
]

/** 两套宿主变量：dark 是本机实测那套（brand-primary 故意留白），light 是同一皮肤的浅色。 */
export const THEMES = {
  dark: {
    '--dsw-alias-bg-base': '#17181a',
    '--dsw-alias-bg-layer-1': '#1c1d20',
    '--dsw-alias-bg-layer-2': '#242629',
    '--dsw-alias-bg-layer-3': '#2a2c30',
    '--dsw-alias-label-primary': '#f2f3f5',
    '--dsw-alias-label-secondary': '#b9bcc2',
    '--dsw-alias-label-tertiary': '#8b8f97',
    '--dsw-alias-border-l2': 'rgba(255,255,255,.10)',
    '--dsw-alias-border-l3': 'rgba(255,255,255,.16)',
    '--dsw-alias-border-l4': 'rgba(255,255,255,.22)',
    '--dsw-alias-brand-primary': '#ffffff',
    '--dsw-alias-interactive-bg-hover': 'rgba(255,255,255,.08)',
    '--dsw-alias-state-success-primary': '#3ecf8e',
    '--dsw-alias-state-warn-primary': '#f5a524',
    '--dsw-alias-state-error-primary': '#f26d6d',
    '--dsw-radius-sm': '6px',
    '--dsw-radius-md': '8px',
    '--dsw-radius-lg': '12px',
    '--dsw-font-mono': '"Cascadia Mono", ui-monospace, Menlo, monospace',
  },
  light: {
    '--dsw-alias-bg-base': '#fafaf7',
    '--dsw-alias-bg-layer-1': '#ffffff',
    '--dsw-alias-bg-layer-2': '#f2f1ec',
    '--dsw-alias-bg-layer-3': '#e8e7e0',
    '--dsw-alias-label-primary': '#1a1a17',
    '--dsw-alias-label-secondary': '#45453f',
    '--dsw-alias-label-tertiary': '#6b6b63',
    '--dsw-alias-border-l2': 'rgba(0,0,0,.10)',
    '--dsw-alias-border-l3': 'rgba(0,0,0,.16)',
    '--dsw-alias-border-l4': 'rgba(0,0,0,.22)',
    '--dsw-alias-brand-primary': '#ffffff',
    '--dsw-alias-interactive-bg-hover': 'rgba(0,0,0,.05)',
    '--dsw-alias-state-success-primary': '#2f6b3a',
    '--dsw-alias-state-warn-primary': '#8a5a00',
    '--dsw-alias-state-error-primary': '#a61b1b',
    '--dsw-radius-sm': '6px',
    '--dsw-radius-md': '8px',
    '--dsw-radius-lg': '12px',
    '--dsw-font-mono': '"Cascadia Mono", ui-monospace, Menlo, monospace',
  },
}

/** 从 client.js 里抽 CSS 模板（不依赖换行符，CRLF 也能抓）。 */
export function extractCss() {
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  const marker = 'const CSS = ' + BUTTON
  const start = source.indexOf(marker)
  if (start < 0) throw new Error('没抓到 CSS')
  const from = start + marker.length
  const end = source.indexOf(BUTTON, from)
  if (end < 0) throw new Error('CSS 模板没闭合')
  return source.slice(from, end)
}

const BODY_CSS = [
  'html,body{height:100%;}',
  'body{margin:0;padding:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:"Microsoft YaHei",system-ui,sans-serif;}',
].join(LF)

/** 生成 :root 那段宿主变量（noVars 时不生成，测兜底层）。 */
export function themeCss(name) {
  const vars = THEMES[name]
  if (vars === undefined) throw new Error('未知主题：' + name)
  const lines = ['  --dsw-focus-ring-width:2px;']
  for (const key of Object.keys(vars)) lines.push('  ' + key + ':' + vars[key] + ';')
  return ':root{' + LF + lines.join(LF) + LF + '}' + LF + BODY_CSS
}

/** 无头量尺寸用的探针：把布局事实塞进 <pre id="cw-metrics">，配 --dump-dom 读回来。 */
const METRICS_SCRIPT = [
  '<script>',
  '(function(){',
  '  function px(v){return Math.round(parseFloat(v||"0")*100)/100}',
  '  function rect(el){var r=el.getBoundingClientRect();return {l:px(r.left),r:px(r.right),t:px(r.top),b:px(r.bottom),w:px(r.width),h:px(r.height)}}',
  '  function rgb(text){var m=String(text).replace(/[^0-9.,]/g,"").split(",");return [parseFloat(m[0]),parseFloat(m[1]),parseFloat(m[2])]}',
  '  function lum(c){function ch(v){var s=v/255;return s<=0.03928?s/12.92:Math.pow((s+0.055)/1.055,2.4)}return 0.2126*ch(c[0])+0.7152*ch(c[1])+0.0722*ch(c[2])}',
  '  function ratio(a,b){var la=lum(rgb(a)),lb=lum(rgb(b));var hi=Math.max(la,lb),lo=Math.min(la,lb);return Math.round(((hi+0.05)/(lo+0.05))*100)/100}',
  '  var root=document.querySelector(".cw-root")',
  '  var body=document.querySelector(".cw-body")',
  '  var tabbar=document.querySelector(".cw-tabbar")',
  '  var tabs=document.querySelector(".cw-tabs")',
  '  var head=document.querySelector(".cw-head")',
  '  var card=document.querySelector(".cw-card")',
  '  var primary=document.querySelector(".cw-btn.primary")',
  '  var tab=document.querySelector(".cw-tab")',
  '  var cs=primary?getComputedStyle(primary):null',
  '  var out={',
  '    viewport:{w:window.innerWidth,h:window.innerHeight},',
  '    root:{scrollWidth:root.scrollWidth,clientWidth:root.clientWidth,scrollHeight:root.scrollHeight,clientHeight:root.clientHeight,rect:rect(root),containerType:getComputedStyle(root).containerType},',
  '    doc:{scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,bodyScrollWidth:document.body.scrollWidth,bodyClientWidth:document.body.clientWidth},',
  '    tabbar:tabbar?{display:getComputedStyle(tabbar).display,rect:rect(tabbar)}:null,',
  '    tabs:tabs?{display:getComputedStyle(tabs).display,scrollWidth:tabs.scrollWidth,clientWidth:tabs.clientWidth,rect:rect(tabs)}:null,',
  '    headRect:head?rect(head):null,',
  '    bodyScroll:body?{scrollHeight:body.scrollHeight,clientHeight:body.clientHeight}:null,',
  '    fieldPairs:[].slice.call(document.querySelectorAll(".cw-field")).map(function(el){var l=el.querySelector(".cw-label");var c=el.lastElementChild;return {label:l?rect(l):null,control:c?rect(c):null}}),',
  '    outPair:(function(){var a=document.querySelector(".cw-out-img");var b=document.querySelector(".cw-log");return {img:a?rect(a):null,log:b?rect(b):null}})(),',
  '    lb:(function(){var lb=document.querySelector(".cw-lightbox");if(!lb)return null;var w=document.querySelector(".cw-lightbox-wrap");var i=document.querySelector(".cw-lightbox img");var n=document.querySelector(".cw-lightbox-info");var c=document.querySelector(".cw-lightbox-close");var hit=null;var cHit=null;if(w){var wr=w.getBoundingClientRect();var el=document.elementFromPoint(wr.left+8,wr.top+8);hit=el?(el.className||el.tagName):null}if(c){var cr=c.getBoundingClientRect();var ce=document.elementFromPoint(cr.left+cr.width/2,cr.top+cr.height/2);cHit=ce?(ce.className||ce.tagName):null}var iHit=null;if(i){var ir=i.getBoundingClientRect();var ie=document.elementFromPoint(ir.left+ir.width/2,ir.top+ir.height/2);iHit=ie?(ie.className||ie.tagName):null}return {lightbox:rect(lb),wrap:w?rect(w):null,img:i?rect(i):null,info:n?rect(n):null,close:c?rect(c):null,scrimHit:hit,closeHit:cHit,imgHit:iHit}})(),',
  '    stack:(function(){var p=document.querySelector(".cw-lora-pop");if(!p)return null;var r=p.getBoundingClientRect();var hit=document.elementFromPoint(r.left+40,r.top+40);return {inPop:p.contains(hit),hit:hit?(hit.className||hit.tagName):null}})(),',
  '    bodyRect:body?rect(body):null,',
  '    cards:[].slice.call(document.querySelectorAll(".cw-card,.cw-hub-tile")).map(rect),',
  '    buttons:[].slice.call(document.querySelectorAll(".cw-btn,.cw-chip,.cw-folder")).map(function(el){var r=rect(el);return {w:r.w,h:r.h,text:(el.textContent||"").slice(0,12)}}),',
  '    primary:cs?{bg:cs.backgroundColor,color:cs.color,contrast:ratio(cs.color,cs.backgroundColor),rect:rect(primary)}:null,',
  '    tab:tab?{color:getComputedStyle(tab).color,contrast:ratio(getComputedStyle(tab).color,getComputedStyle(root).backgroundColor)}:null,',
  '    anim:card?{animationDuration:getComputedStyle(card).animationDuration,transitionDuration:getComputedStyle(card).transitionDuration}:null,',
  '    media:{reducedMotion:matchMedia("(prefers-reduced-motion: reduce)").matches,coarse:matchMedia("(pointer: coarse)").matches,dark:matchMedia("(prefers-color-scheme: dark)").matches},',
  '    motion:document.documentElement.getAttribute("data-cw-motion")',
  '  }',
  '  var pre=document.createElement("pre");pre.id="cw-metrics";pre.textContent=JSON.stringify(out);document.body.appendChild(pre)',
  '})()',
  '</script>',
].join(LF)

const SAMPLE_BODY = [
  '<div class="cw-root" style="height:auto">',
  '  <div class="cw-head">',
  '    <h2 class="cw-title">ComfyUI 工作台</h2>',
  '    <span class="cw-badge down">服务未启动</span>',
  '    <span class="cw-spacer"></span>',
  '    <button class="cw-btn">刷新目录</button>',
  '    <button class="cw-btn primary">一键拉起</button>',
  '  </div>',
  '  <div class="cw-tabs">',
  '    <button class="cw-tab active">工作台</button>',
  '    <button class="cw-tab">我的图库</button>',
  '    <button class="cw-tab">画风图库</button>',
  '    <button class="cw-tab">模型库 · Civitai</button>',
  '  </div>',
  '  <div class="cw-body" style="overflow:visible">',
  '    <div class="cw-card">',
  '      <div class="cw-card-head">',
  '        <h3 class="cw-card-title">画风图库</h3>',
  '        <span class="cw-chip">34,709 / 34,709 张 · 120 个文件夹</span>',
  '        <span class="cw-spacer"></span>',
  '        <button class="cw-btn">刷新</button>',
  '      </div>',
  '      <div class="cw-toolbar">',
  '        <input class="cw-input cw-search" placeholder="搜文件名或路径">',
  '        <button class="cw-btn">搜索</button>',
  '        <span class="cw-label">自动探测</span>',
  '        <span class="cw-spacer"></span>',
  '        <span class="cw-label">当前分类：全部</span>',
  '      </div>',
  '      <div class="cw-folders">',
  '        <button class="cw-folder active">全部<span class="n"> · 34709</span></button>',
  '        <button class="cw-folder">anima/2026-11<span class="n"> · 918</span></button>',
  '        <button class="cw-folder">moss/2026-11<span class="n"> · 471</span></button>',
  '      </div>',
  '      <div class="cw-row">',
  '        <a class="cw-btn primary" href="#">下载完整 ZIP ↗</a>',
  '        <button class="cw-btn">绑定本地目录</button>',
  '        <button class="cw-btn primary">生成一张</button>',
  '        <button class="cw-btn" disabled>已禁用</button>',
  '      </div>',
  '    </div>',
  '    <div class="cw-card">',
  '      <div class="cw-card-head">',
  '        <h3 class="cw-card-title">逐步预览</h3>',
  '        <span class="cw-chip">12 / 16 步</span>',
  '        <span class="cw-spacer"></span>',
  '        <label class="cw-toggle"><span>预览</span>',
  '          <select class="cw-select"><option>近似色彩（latent2rgb）</option></select>',
  '        </label>',
  '        <button class="cw-btn">清空</button>',
  '      </div>',
  '      <div class="cw-steps">',
  '        <button class="cw-step"><span style="display:block;width:100%;height:100%;background:#2b3340"></span><em>1</em></button>',
  '        <button class="cw-step active"><span style="display:block;width:100%;height:100%;background:#3a4a63"></span><em>12</em></button>',
  '        <button class="cw-step"><span style="display:block;width:100%;height:100%;background:#2b3340"></span><em>13</em></button>',
  '        <button class="cw-step empty">等待</button>',
  '      </div>',
  '      <p class="cw-empty">只在本次生成期间有效、不写盘（当前保留 12 帧）。</p>',
  '    </div>',
  '    <div class="cw-card">',
  '      <div class="cw-card-head">',
  '        <h3 class="cw-card-title">输出</h3>',
  '        <span class="cw-chip">已完成</span>',
  '        <span class="cw-spacer"></span>',
  '        <label class="cw-toggle"><input type="checkbox"><span>暂停跟随</span></label>',
  '        <button class="cw-btn">复制日志</button>',
  '      </div>',
  '      <div class="cw-out">',
  '        <div class="cw-out-img"><span>成品图占位</span></div>',
  '        <textarea class="cw-log" readonly>13:42:01 信息 已提交 anima__Anima Aesthetic v1.1（a1b2c3d4）',
  '13:42:03 执行 节点 3 开始执行',
  '13:42:04 步进 第 1 / 16 步（节点 3）</textarea>',
  '      </div>',
  '      <div class="cw-actions">',
  '        <button class="cw-btn danger">停止生图</button>',
  '        <button class="cw-btn">保存图像</button>',
  '        <button class="cw-btn">存到工作区</button>',
  '        <button class="cw-btn">复制图像</button>',
  '      </div>',
  '    </div>',
  '    <div class="cw-card">',
  '      <div class="cw-card-head">',
  '        <h3 class="cw-card-title">环境 · LoRA 多选器</h3>',
  '        <span class="cw-spacer"></span>',
  '        <button class="cw-chip cw-chip-btn" aria-expanded="true">LoRA 2/2 已选 ▲</button>',
  '        <button class="cw-chip cw-chip-btn" aria-expanded="false">LoRA 12 可用 ▼</button>',
  '      </div>',
  '      <div class="cw-fields">',
  '        <label class="cw-field"><span class="cw-label">底模</span><select class="cw-select"><option>（工作流默认）</option><option>moss_refined_realism_int8_v3.0.safetensors</option></select></label>',
  '        <label class="cw-field cw-field-size"><span class="cw-label">尺寸</span><input class="cw-input cw-num" type="number" value="960"><span class="cw-label">×</span><input class="cw-input cw-num" type="number" value="1280"></label>',
  '        <div class="cw-field cw-field-steps"><span class="cw-label">步数</span><input class="cw-input cw-num" type="number" value="20"><span class="cw-lora"><button class="cw-chip cw-chip-btn" aria-expanded="false">LoRA 1 已选 ▼</button></span></div>',
  '        <label class="cw-field"><span class="cw-label">大模型</span><select class="cw-select"><option>DeepSeek · DeepSeek-V4.1-Flash</option></select></label>',
  '      </div>',
  '      <div class="cw-lora">',
  '        <button class="cw-chip cw-chip-btn" aria-expanded="true">LoRA 2/2 已选 ▲</button>',
  '        <div class="cw-lora-pop" style="position:static;transform:none;width:min(430px,100%);box-shadow:none">',
  '        <div class="cw-lora-head">',
  '          <span class="cw-card-title">LoRA 多选</span>',
  '          <span class="cw-chip">2 槽</span>',
  '          <span class="cw-chip">已选 2 / 2 槽</span>',
  '          <span class="cw-spacer"></span>',
  '          <button class="cw-btn">清空</button>',
  '          <button class="cw-btn">完成</button>',
  '        </div>',
  '        <div class="cw-lora-list">',
  '          <div class="cw-lora-item on"><input type="checkbox" checked><span class="cw-lora-idx">1</span><span class="cw-lora-name"><span>深插 · anima</span><span class="cw-lora-en">deep_penetration_anima_v1.safetensors</span></span><button class="cw-lora-trigger" type="button"><span>deep penetration, v1</span><span class="ic">⧉</span></button><input class="cw-input cw-lora-str" type="number" value="0.8"></div>',
  '          <div class="cw-lora-item on"><input type="checkbox" checked><span class="cw-lora-idx">2</span><span class="cw-lora-name">real-disgust-anima.safetensors</span><input class="cw-input cw-lora-str" type="number" value="0.8"></div>',
  '          <div class="cw-lora-item"><input type="checkbox"><span class="cw-lora-idx off"></span><span class="cw-lora-name"><span>MOSS 图像 4 步蒸馏 v2.0</span><span class="cw-lora-en">moss_image_sft_4step_v2.0.safetensors</span></span><input class="cw-input cw-lora-str" type="number" value="1" disabled></div>',
  '          <div class="cw-lora-item missing"><input type="checkbox"><span class="cw-lora-idx off"></span><span class="cw-lora-name">old_deleted_style_lora.safetensors</span><span class="cw-chip">盘上没有</span></div>',
  '        </div>',
  '        <p class="cw-lora-foot">槽1 deep_penetration_anima_v1.safetensors@0.8 · 槽2 real-disgust-anima.safetensors@0.8；被替掉的默认 LoRA 本次不加载（蒸馏加速 LoRA 也占这类槽，换掉它加速档会失效）</p>',
  '        </div>',
  '      </div>',
  '    </div>',
  '    <div class="cw-card">',
  '      <div class="cw-card-head">',
  '        <h3 class="cw-card-title">模型库 · 大图网格</h3>',
  '        <span class="cw-chip">3 个模型（只看已下载）</span>',
  '        <span class="cw-chip">已下载 1</span>',
  '        <span class="cw-spacer"></span>',
  '        <span style="font-size:12px;color:var(--dsw-alias-label-tertiary)">经本机代理 http://127.0.0.1:7897：封面几百毫秒</span>',
  '      </div>',
  '      <div class="cw-hub-grid">',
  '        <button class="cw-hub-tile" type="button">',
  '          <div class="cw-hub-tile-cover" style="background:linear-gradient(160deg,#2c3e56,#4a3a63)"><span class="cw-hub-tile-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5 9.5 18 20 6.5"/></svg></span></div>',
  '          <div class="cw-hub-tile-body">',
  '            <div class="cw-hub-tile-name">Abstract Painting · Style [LoRA]</div>',
  '            <div class="cw-hub-tile-meta"><span>LoRA</span><span>Pony V6 XL</span><span>↓ 128,431</span><span class="cw-hub-installed">已下载</span></div>',
  '          </div>',
  '        </button>',
  '        <button class="cw-hub-tile" type="button">',
  '          <div class="cw-hub-tile-cover" style="background:linear-gradient(160deg,#4a2f43,#6b3a3a)"></div>',
  '          <div class="cw-hub-tile-body">',
  '            <div class="cw-hub-tile-name">Deepseek Whale Girl Maid（角色 LoRA）</div>',
  '            <div class="cw-hub-tile-en">Deepseek Whale Girl Maid</div>',
  '            <div class="cw-hub-tile-meta"><span>LoRA</span><span>Anima</span><span>↓ 3,120</span></div>',
  '          </div>',
  '        </button>',
  '        <button class="cw-hub-tile" type="button">',
  '          <div class="cw-hub-tile-cover" style="background:linear-gradient(160deg,#2f4a3d,#3a6b55)"></div>',
  '          <div class="cw-hub-tile-body">',
  '            <div class="cw-hub-tile-name">写实人像 Real Portrait</div>',
  '            <div class="cw-hub-tile-meta"><span>Checkpoint</span><span>SDXL 1.0</span><span>↓ 89,002</span></div>',
  '          </div>',
  '        </button>',
  '      </div>',
  '      <div class="cw-hub-progress"><i style="width:67%"></i></div>',
  '    </div>',
  '    <div class="cw-card">',
  '      <div class="cw-card-head"><h3 class="cw-card-title">模型库抽屉（1279 以下拍平）</h3></div>',
  '      <div class="cw-hub with-drawer">',
  '        <div class="cw-hub-main">',
  '          <div class="cw-hub-grid">',
  '            <button class="cw-hub-tile" type="button"><div class="cw-hub-tile-cover" style="background:linear-gradient(160deg,#2c3e56,#4a3a63)"></div><div class="cw-hub-tile-body"><div class="cw-hub-tile-name">乳尻 / 胸部挤压</div><div class="cw-hub-tile-en">乳尻/breasts squeeze</div><div class="cw-hub-tile-meta"><span>LoRA</span><span>MOSS 图像</span><span>↓ 14,217</span></div></div></button>',
  '            <button class="cw-hub-tile" type="button"><div class="cw-hub-tile-cover" style="background:linear-gradient(160deg,#4a2f43,#6b3a3a)"></div><div class="cw-hub-tile-body"><div class="cw-hub-tile-name">深水鲸鱼女仆</div><div class="cw-hub-tile-en">Deepseek Whale Girl Maid</div><div class="cw-hub-tile-meta"><span>LoRA</span><span>Anima</span><span>↓ 3,120</span></div></div></button>',
  '          </div>',
  '        </div>',
  '        <div class="cw-hub-drawer">',
  '          <h3>下载器</h3>',
  '          <div class="cw-hub-actions"><span class="cw-hub-badge yes">key 可用</span><span class="cw-hub-badge no">未绑定目录</span></div>',
  '          <p class="cw-hub-note">C:/Comfyui model/loras/PenisLoraMossNoTriggerwords.safetensors</p>',
  '          <div class="cw-hub-progress"><i style="width:34%"></i></div>',
  '        </div>',
  '      </div>',
  '    </div>',
  '    <div class="cw-card">',
  '      <div class="cw-card-head"><h3 class="cw-card-title">三态（空 / 加载 / 错误）</h3></div>',
  '      <div class="cw-state empty"><p>这个筛选条件下没有图片</p></div>',
  '      <div class="cw-state loading"><p>读取中…</p><span class="cw-skel"></span><span class="cw-skel row"><i></i><i></i><i></i></span></div>',
  '      <div class="cw-state error"><p>读取失败：ECONNREFUSED 127.0.0.1:8188</p><button class="cw-btn">重试</button></div>',
  '      <p class="cw-note error">服务没起来时，目录仍可读，出图要等它响应。</p>',
  '    </div>',
  '    <div class="cw-card">',
  '      <div class="cw-card-head"><h3 class="cw-card-title">详情弹层（点卡片打开，点遮罩关闭）</h3></div>',
  '      <div class="cw-hub-detail" style="position:static;inset:auto;background:none;padding:0;display:block;animation:none">',
  '        <div class="cw-hub-detail-card" style="animation:none">',
  '          <div class="cw-card-head">',
  '            <h3 class="cw-card-title">Abstract Painting · Style [LoRA]</h3>',
  '            <span class="cw-chip">LoRA</span>',
  '            <span class="cw-spacer"></span>',
  '            <a class="cw-btn" href="#">在 Civitai 打开 ↗</a>',
  '            <button class="cw-btn">关闭</button>',
  '          </div>',
  '          <div class="cw-hub-detail-top">',
  '            <div class="cw-hub-detail-cover" style="background:linear-gradient(160deg,#2c3e56,#4a3a63)"></div>',
  '            <div class="cw-hub-detail-info">',
  '              <div class="cw-hub-meta"><span>by abstracter</span><span>↓ 128,431</span><span>♥ 4,218</span><span>★ 4.87</span><span>底模 Pony V6 XL / SDXL 1.0</span></div>',
  '              <div class="cw-hub-meta"><span class="cw-chip">abstract</span><span class="cw-chip">painting</span><span class="cw-chip">style</span></div>',
  '              <div class="cw-hub-file"><span style="opacity:.7">版本</span><select><option>v1.0 · Pony V6 XL</option></select><span style="opacity:.7">触发词 abstract20painting2020style</span></div>',
  '              <p class="cw-hub-desc">作者简介（HTML 已剥成纯文本，段落与换行保留）：这是一段示例描述，讲画风来源、怎么用、权重建议 0.7–0.85 最稳。',
  '',
  '第二段：用法与注意事项。太长就在这个框里滚动，不撑爆弹层。</p>',
  '            </div>',
  '          </div>',
  '          <div class="cw-hub-ver">',
  '            <div class="cw-hub-file"><input type="checkbox" checked><span class="nm">abstract20painting2020style.safetensors</span><span style="opacity:.7">72.4 MB</span><span style="opacity:.5">SafeTensor</span><select><option>LoRA</option></select></div>',
  '            <div class="cw-hub-file"><input type="checkbox"><span class="nm">abstract20_painting_v2.safetensors</span><span style="opacity:.7">144.8 MB</span><span style="opacity:.5">SafeTensor</span><select><option>LoRA</option></select></div>',
  '          </div>',
  '          <div class="cw-hub-actions">',
  '            <span class="cw-hub-meta">已选 1 个 · 72.4 MB</span>',
  '            <span class="cw-spacer"></span>',
  '            <button class="cw-btn primary">下载选中</button>',
  '          </div>',
  '        </div>',
  '      </div>',
  '    </div>',
  '    <div class="cw-card">',
  '      <div class="cw-card-head">',
  '        <h3 class="cw-card-title">下载进度</h3>',
  '        <span class="cw-chip">下载中</span>',
  '        <span class="cw-spacer"></span>',
  '        <span class="cw-hub-meta">56.0 MB / 83.7 MB · 67%</span>',
  '      </div>',
  '      <div class="cw-hub-file"><span class="nm">PenisLoraMossNoTriggerwords.safetensors</span><span>下载中</span><span>56.0 MB / 83.7 MB</span><span>67%</span>',
  '        <div class="cw-hub-progress cw-hub-item-bar"><i style="width:67%"></i></div></div>',
  '      <div class="cw-hub-foot" style="position:static">',
  '        <span>已选 2 个 · 合计 95.7 MB</span>',
  '        <div class="cw-hub-progress cw-hub-foot-bar"><i style="width:67%"></i></div>',
  '        <span class="cw-hub-meta">下载中 · 67%</span>',
  '        <span class="cw-spacer"></span>',
  '        <button class="cw-btn primary">下载选中</button>',
  '      </div>',
  '    </div>',
  '  </div>',
  '  <div class="cw-tabbar">',
  '    <button class="cw-tab active">工作台</button>',
  '    <button class="cw-tab">图库</button>',
  '    <button class="cw-tab">画风</button>',
  '    <button class="cw-tab">模型库</button>',
  '  </div>',
  '</div>',
].join(LF)


/**
 * 层叠顺序样张：一张卡里开着 .cw-lora-pop，紧跟一张卡。
 * 关键在 <style> 里的 animation-delay:-10s —— 把入场动画直接推到「已结束」，
 * 于是 fill-mode:both 留下的层叠上下文会当场暴露（下拉被后一张卡盖住）。
 * 虚拟时间下动画不前进，所以必须这样钉住终态才测得准。
 */
const OVERLAY_BODY = [
  '<style>.cw-root *{animation-delay:-10s !important;}</style>',
  '<div class="cw-root" style="height:auto">',
  '  <div class="cw-body" style="overflow:visible">',
  '    <div class="cw-card">',
  '      <div class="cw-card-head"><h3 class="cw-card-title">环境 · LoRA 面板打开</h3></div>',
  '      <div class="cw-field cw-field-steps"><span class="cw-label">步数</span><input class="cw-input cw-num" type="number" value="20">',
  '        <span class="cw-lora"><button class="cw-chip cw-chip-btn" aria-expanded="true">LoRA 1 已选 ▲</button>',
  '          <div class="cw-lora-pop">',
  '            <div class="cw-lora-head"><span class="cw-card-title">LoRA 多选</span></div>',
  '            <div class="cw-lora-list"><div class="cw-lora-item on"><span class="cw-lora-name">SKP_MOS_Dv1.safetensors</span></div></div>',
  '          </div>',
  '        </span>',
  '      </div>',
  '    </div>',
  '    <div class="cw-card">',
  '      <div class="cw-card-head"><h3 class="cw-card-title">思考</h3></div>',
  '      <p class="cw-empty">后面这张卡如果盖住下拉，就是入场动画用了 fill-mode:both。</p>',
  '    </div>',
  '  </div>',
  '</div>',
].join(LF)

/** 灯箱样张：1024² 假图 + 230px 信息卡，检查大图有没有被裁。 */
const LIGHTBOX_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#3a5"/></svg>')
const LIGHTBOX_BODY = [
  '<div class="cw-root" style="height:auto">',
  '  <div class="cw-lightbox">',
  '    <div class="cw-lightbox-wrap"><img src="' + LIGHTBOX_SVG + '" alt="大图"></div>',
  '    <div class="cw-lightbox-info">',
  '      <div class="cw-lightbox-name">moss-standard_00080_.png</div>',
  '      <div class="cw-path">moss/2026-11</div>',
  '      <div style="margin-top:6px">1.4 MB · 2026-11-27 21:46</div>',
  '      <div class="cw-row" style="margin-top:10px"><button class="cw-btn">保存图像</button><button class="cw-btn">复制图像</button></div>',
  '      <button class="cw-btn cw-lightbox-close" type="button" aria-label="关闭预览">关闭预览</button>',
  '      <div style="margin-top:8px;opacity:.6">点图、点背景或按 Esc 也能关</div>',
  '    </div>',
  '  </div>',
  '</div>',
].join(LF)
export function buildHtml(options) {
  const opts = options === undefined ? {} : options
  const css = extractCss()
  const base = opts.noVars === true ? BODY_CSS : themeCss(opts.theme === undefined ? 'dark' : opts.theme)
  // 面板宽度 ≠ 视口宽度：Chrome 在 Windows 上有 ~512px 的最小窗口宽，
  // 所以窄档不靠 --window-size，直接把 body 宽度钉死，容器查询量到的就是面板宽度。
  const width = typeof opts.width === 'number' ? LF + 'body{width:' + opts.width + 'px;}' : ''
  const metrics = opts.metrics === true ? METRICS_SCRIPT : ''
  // bounded：模拟真实面板——高度被宿主限死，靠 .cw-body 自己滚（样张默认 height:auto，测不出挤压）
  const body = opts.lightbox === true
    ? LIGHTBOX_BODY
    : opts.overlay === true
      ? OVERLAY_BODY
      : (opts.bounded === true
        ? SAMPLE_BODY.split('style="height:auto"').join('').split('style="overflow:visible"').join('')
        : SAMPLE_BODY)
  return '<!doctype html><html><head><meta charset="utf-8"><style>' + base + width + css + '</style></head><body>' + body + metrics + '</body></html>'
}

// ---------------------------------------------------------------- 静态断言

let failures = 0
let checks = 0
function check(name, fn) {
  try {
    fn()
    checks += 1
    console.log('ok   ' + name)
  } catch (error) {
    failures += 1
    console.log('FAIL ' + name + ' → ' + (error && error.message ? error.message : error))
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}
function parseHex(value) {
  const text = String(value).trim()
  if (text.length !== 7 || text.charAt(0) !== '#') return null
  return [parseInt(text.slice(1, 3), 16), parseInt(text.slice(3, 5), 16), parseInt(text.slice(5, 7), 16)]
}
function channel(value) {
  const s = value / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
function luminance(rgb) {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
}
export function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

function main() {
  const css = extractCss()

  check('两套宿主变量都留着 brand-primary=白色的坑', () => {
    for (const name of Object.keys(THEMES)) {
      assert(THEMES[name]['--dsw-alias-brand-primary'] === '#ffffff', name + ' 样张没把 brand-primary 设成白色，测不出主按钮消失')
    }
  })

  check('对比度：正文 / 次要字在三个面层上都 ≥ 4.5:1', () => {
    for (const name of Object.keys(THEMES)) {
      const theme = THEMES[name]
      const pairs = [
        ['label-primary', 'bg-base'],
        ['label-primary', 'bg-layer-1'],
        ['label-primary', 'bg-layer-2'],
        ['label-secondary', 'bg-layer-1'],
      ]
      for (const pair of pairs) {
        const fg = parseHex(theme['--dsw-alias-' + pair[0]])
        const bg = parseHex(theme['--dsw-alias-' + pair[1]])
        const value = contrast(fg, bg)
        assert(value >= 4.5, name + ' ' + pair[0] + ' / ' + pair[1] + ' 只有 ' + value.toFixed(2) + ':1')
      }
    }
  })

  check('状态色对底色的对比度 ≥ 3:1（色块 + 文字都靠它）', () => {
    for (const name of Object.keys(THEMES)) {
      const theme = THEMES[name]
      for (const key of ['state-success-primary', 'state-warn-primary', 'state-error-primary']) {
        const value = contrast(parseHex(theme['--dsw-alias-' + key]), parseHex(theme['--dsw-alias-bg-layer-1']))
        assert(value >= 3, name + ' ' + key + ' 只有 ' + value.toFixed(2) + ':1')
      }
    }
  })

  check('组件区只剩四类豁免色', () => {
    const a = css.indexOf('/* §A token')
    const b = css.indexOf('/* §B base')
    const f = css.indexOf('/* §F fallback')
    assert(a >= 0 && b > a && f > b, '缺 §A / §B / §F 分段标记')
    const components = css.slice(b, f)
    const rest = components.split('background:#fff').join('')
    assert(rest.split('#').length - 1 === 0, '组件区还有 #hex 硬编码色')
    assert(rest.split('rgb(').length - 1 + rest.split('rgba(').length - 1 === 0, '组件区还有 rgb()/rgba() 硬编码色')
  })

  check('样张能抽出 CSS 且带六段标记', () => {
    assert(css.length > 20000, 'CSS 太短：' + css.length)
    for (const token of ['§A token', '§D motion', '§E responsive', '§F fallback']) assert(css.includes(token), 'CSS 缺 ' + token)
  })

  // ------------------------------------------------------------ 写样张
  const dir = path.join(os.tmpdir(), 'dsh-comfy-theme-check')
  fs.mkdirSync(dir, { recursive: true })
  const samples = []
  for (const themeName of Object.keys(THEMES)) {
    for (const size of SIZES) {
      const file = path.join(dir, 'sample-' + themeName + '-' + size.name + '.html')
      fs.writeFileSync(file, buildHtml({ theme: themeName }), 'utf8')
      samples.push({ file, theme: themeName, size })
    }
  }
  const fallback = path.join(dir, 'sample-fallback-light.html')
  fs.writeFileSync(fallback, buildHtml({ noVars: true, theme: 'light' }), 'utf8')
  console.log('')
  console.log('样张目录：' + dir)
  console.log('生成 ' + samples.length + ' 张（' + Object.keys(THEMES).length + ' 主题 × ' + SIZES.length + ' 尺寸）+ 1 张兜底（无宿主变量）')

  if (process.argv.includes('--shoot')) {
    const chrome = [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ].find((candidate) => fs.existsSync(candidate))
    if (chrome === undefined) {
      console.log('没找到 Chrome/Edge，跳过截图')
    } else {
      for (const sample of samples) {
        const png = sample.file.replace('.html', '.png')
        spawnSync(chrome, [
          '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
          '--window-size=' + sample.size.width + ',' + sample.size.height,
          '--virtual-time-budget=3000',
          '--screenshot=' + png,
          'file:///' + sample.file.split(BS).join('/'),
        ], { stdio: 'ignore' })
        console.log('截图：' + png)
      }
    }
  }

  console.log('')
  if (failures > 0) {
    console.log('有 ' + failures + ' 项没通过')
    process.exitCode = 1
  } else {
    console.log('全部 ' + checks + ' 项通过')
  }
}

const INVOKED = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (INVOKED) main()
