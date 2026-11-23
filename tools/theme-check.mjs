import os from 'node:os'
import path from 'node:path'
/**
 * tools/theme-check.mjs — 主题可读性样张。
 *
 *   node tools/theme-check.mjs            # 生成 HTML 到系统临时目录，打印路径
 *   node tools/theme-check.mjs --shoot    # 再用本机 Chrome 截图（可选）
 *
 * 为什么需要它：本机这套皮肤把 --dsw-alias-brand-primary 解析成**白色**，早先用
 * 「品牌色打底 + #fff 文字」的按钮直接消失。这个样张故意把 brand-primary 设成白色，
 * 用真实 CSS 渲染主按钮 / 选中分类 / 链接按钮，肉眼一眼就能看出还有没有同色文字。
 */
import fs from 'node:fs'

const source = fs.readFileSync('C:/DSH/Projects/dsh-comfy-workbench/lib/client.js', 'utf8')
const start = source.indexOf('const CSS = `')
// 闭合反引号：从模板开头往后找第一个反引号，不依赖换行符（文件可能是 CRLF）。
const cssStart = start + 'const CSS = `'.length
const end = source.indexOf('`', cssStart)
if (start < 0 || end < 0) throw new Error('没抓到 CSS')
const css = source.slice(cssStart, end)

const theme = `
:root{
  --dsw-alias-bg-base:#17181a; --dsw-alias-bg-layer-1:#1c1d20; --dsw-alias-bg-layer-2:#242629; --dsw-alias-bg-layer-3:#2a2c30;
  --dsw-alias-label-primary:#f2f3f5; --dsw-alias-label-secondary:#b9bcc2; --dsw-alias-label-tertiary:#8b8f97;
  --dsw-alias-border-l2:rgba(255,255,255,.10); --dsw-alias-border-l3:rgba(255,255,255,.16); --dsw-alias-border-l4:rgba(255,255,255,.22);
  --dsw-alias-brand-primary:#ffffff;      /* 本机皮肤实测为白色，问题就出在这 */
  --dsw-alias-interactive-bg-hover:rgba(255,255,255,.08);
  --dsw-alias-state-success-primary:#3ecf8e; --dsw-alias-state-warn-primary:#f5a524; --dsw-alias-state-error-primary:#f26d6d;
  --dsw-radius-sm:6px; --dsw-radius-md:8px; --dsw-radius-lg:12px;
}
body{margin:0;padding:16px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:"Microsoft YaHei",system-ui,sans-serif;}
`

const body = `
<div class="cw-root" style="height:auto">
  <div class="cw-head">
    <h2 class="cw-title">ComfyUI 工作台</h2>
    <span class="cw-badge down">服务未启动</span>
    <span class="cw-spacer"></span>
    <button class="cw-btn">刷新目录</button>
    <button class="cw-btn primary">一键拉起</button>
  </div>
  <div class="cw-body" style="overflow:visible">
    <div class="cw-card">
      <div class="cw-card-head">
        <h3 class="cw-card-title">画风图库</h3>
        <span class="cw-chip">34,709 / 34,709 张 · 120 个文件夹</span>
        <span class="cw-spacer"></span>
        <button class="cw-btn">刷新</button>
      </div>
      <div class="cw-toolbar">
        <input class="cw-input cw-search" placeholder="搜文件名或路径">
        <button class="cw-btn">搜索</button>
        <span class="cw-label">自动探测</span>
        <span class="cw-spacer"></span>
        <span class="cw-label">当前分类：全部</span>
      </div>
      <div class="cw-folders">
        <button class="cw-folder active">全部<span class="n"> · 34709</span></button>
        <button class="cw-folder">anima/2026-11<span class="n"> · 918</span></button>
        <button class="cw-folder">moss/2026-11<span class="n"> · 471</span></button>
      </div>
      <div class="cw-row">
        <a class="cw-btn primary" href="#">下载完整 ZIP ↗</a>
        <button class="cw-btn">绑定本地目录</button>
        <button class="cw-btn primary">生成一张</button>
        <button class="cw-btn" disabled>已禁用</button>
      </div>
    </div>

    <div class="cw-card">
      <div class="cw-card-head">
        <h3 class="cw-card-title">逐步预览</h3>
        <span class="cw-chip">12 / 16 步</span>
        <span class="cw-spacer"></span>
        <label class="cw-toggle"><span>预览</span>
          <select class="cw-select"><option>近似色彩（latent2rgb）</option></select>
        </label>
        <button class="cw-btn">清空</button>
      </div>
      <div class="cw-steps">
        <button class="cw-step"><span style="display:block;width:100%;height:100%;background:#2b3340"></span><em>1</em></button>
        <button class="cw-step active"><span style="display:block;width:100%;height:100%;background:#3a4a63"></span><em>12</em></button>
        <button class="cw-step"><span style="display:block;width:100%;height:100%;background:#2b3340"></span><em>13</em></button>
        <button class="cw-step empty">等待</button>
      </div>
      <p class="cw-empty">只在本次生成期间有效、不写盘（当前保留 12 帧）。</p>
    </div>

    <div class="cw-card">
      <div class="cw-card-head">
        <h3 class="cw-card-title">输出</h3>
        <span class="cw-chip">已完成</span>
        <span class="cw-spacer"></span>
        <label class="cw-toggle"><input type="checkbox"><span>暂停跟随</span></label>
        <button class="cw-btn">复制日志</button>
      </div>
      <div class="cw-out">
        <div class="cw-out-img"><span>成品图占位</span></div>
        <textarea class="cw-log" readonly>13:42:01 信息 已提交 anima__Anima Aesthetic v1.1（a1b2c3d4）
13:42:03 执行 节点 3 开始执行
13:42:04 步进 第 1 / 16 步（节点 3）</textarea>
      </div>
      <div class="cw-actions">
        <button class="cw-btn danger">停止生图</button>
        <button class="cw-btn">保存图像</button>
        <button class="cw-btn">存到工作区</button>
        <button class="cw-btn">复制图像</button>
      </div>
    </div>
  </div>
</div>
`

/** 输出到系统临时目录，不往包根里丢文件。 */
const outFile = path.join(os.tmpdir(), 'dsh-comfy-theme-check.html')
fs.writeFileSync(outFile,
  '<!doctype html><html><head><meta charset="utf-8"><style>' + theme + css + '</style></head><body>' + body + '</body></html>', 'utf8')
console.log('样张已生成：' + outFile + '（CSS ' + css.length + ' 字符）')
if (process.argv.includes('--shoot')) {
  const chrome = [
    'C:////Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:////Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((candidate) => fs.existsSync(candidate))
  if (chrome === undefined) {
    console.log('没找到 Chrome/Edge，跳过截图')
  } else {
    const png = outFile.replace(/\.html$/, '.png')
    const { spawnSync } = await import('node:child_process')
    spawnSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--window-size=980,1500', '--virtual-time-budget=3000',
      '--screenshot=' + png, 'file:///' + outFile.replace(/\\/g, '/'),
    ], { stdio: 'ignore' })
    console.log('截图：' + png)
  }
}
