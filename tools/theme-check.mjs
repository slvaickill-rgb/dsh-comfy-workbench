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
    <div class="cw-card">
      <div class="cw-card-head">
        <h3 class="cw-card-title">环境 · LoRA 多选器</h3>
        <span class="cw-spacer"></span>
        <button class="cw-chip cw-chip-btn" aria-expanded="true">LoRA 2/2 已选 ▲</button>
        <button class="cw-chip cw-chip-btn" aria-expanded="false">LoRA 12 可用 ▼</button>
      </div>
      <div class="cw-grid">
        <label class="cw-row"><span class="cw-label">底模</span><select class="cw-select"><option>（工作流默认）</option></select></label>
        <label class="cw-row"><span class="cw-label">尺寸</span><input class="cw-input cw-num" value="960"><span class="cw-label">×</span><input class="cw-input cw-num" value="1280"></label>
        <div class="cw-row"><span class="cw-label">步数</span><input class="cw-input cw-num" type="number" value="20"><button class="cw-chip cw-chip-btn" aria-expanded="true">LoRA 2/2 已选 ▲</button></div>
        <label class="cw-row"><span class="cw-label">大模型</span><select class="cw-select"><option>DeepSeek · DeepSeek-V4.1-Flash</option></select></label>
      </div>
      <div class="cw-lora">
        <div class="cw-lora-head">
          <span class="cw-card-title">LoRA 多选</span>
          <span class="cw-chip">2 个 LoRA 槽 · 按勾选顺序写入</span>
          <span class="cw-chip">已选 2 / 2 槽</span>
          <span class="cw-spacer"></span>
          <button class="cw-btn">清空</button>
          <button class="cw-btn">收起</button>
        </div>
        <div class="cw-lora-list">
          <div class="cw-lora-item on"><input type="checkbox" checked><span class="cw-lora-idx">1</span><span class="cw-lora-name">deep_penetration_anima_v1.safetensors</span><input class="cw-input cw-lora-str" type="number" value="0.8"></div>
          <div class="cw-lora-item on"><input type="checkbox" checked><span class="cw-lora-idx">2</span><span class="cw-lora-name">real-disgust-anima.safetensors</span><input class="cw-input cw-lora-str" type="number" value="0.8"></div>
          <div class="cw-lora-item"><input type="checkbox"><span class="cw-lora-idx off"></span><span class="cw-lora-name">moss_image_sft_4step_v2.0.safetensors</span><input class="cw-input cw-lora-str" type="number" value="1" disabled></div>
          <div class="cw-lora-item missing"><input type="checkbox"><span class="cw-lora-idx off"></span><span class="cw-lora-name">old_deleted_style_lora.safetensors</span><span class="cw-chip">盘上没有</span><input class="cw-input cw-lora-str" type="number" value="1" disabled></div>
        </div>
        <p class="cw-lora-foot">槽1 deep_penetration_anima_v1.safetensors@0.8 · 槽2 real-disgust-anima.safetensors@0.8；被替掉的默认 LoRA 本次不加载（蒸馏加速 LoRA 也占这类槽，换掉它加速档会失效）</p>
      </div>
    </div>
    <div class="cw-card">
      <div class="cw-card-head">
        <h3 class="cw-card-title">模型库 · 大图网格</h3>
        <span class="cw-chip">3 个模型</span>
        <span class="cw-spacer"></span>
        <span style="font-size:12px;color:var(--dsw-alias-label-tertiary)">经本机代理 http://127.0.0.1:7897：封面几百毫秒</span>
      </div>
      <div class="cw-hub-grid">
        <button class="cw-hub-tile" type="button">
          <div class="cw-hub-tile-cover" style="background:linear-gradient(160deg,#2c3e56,#4a3a63)"></div>
          <div class="cw-hub-tile-body">
            <div class="cw-hub-tile-name">Abstract Painting · Style [LoRA]</div>
            <div class="cw-hub-tile-meta"><span>LoRA</span><span>Pony V6 XL</span><span>↓ 128,431</span></div>
          </div>
        </button>
        <button class="cw-hub-tile" type="button">
          <div class="cw-hub-tile-cover" style="background:linear-gradient(160deg,#4a2f43,#6b3a3a)"></div>
          <div class="cw-hub-tile-body">
            <div class="cw-hub-tile-name">Deepseek Whale Girl Maid（角色 LoRA）</div>
            <div class="cw-hub-tile-meta"><span>LoRA</span><span>Anima</span><span>↓ 3,120</span></div>
          </div>
        </button>
        <button class="cw-hub-tile" type="button">
          <div class="cw-hub-tile-cover" style="background:linear-gradient(160deg,#2f4a3d,#3a6b55)"></div>
          <div class="cw-hub-tile-body">
            <div class="cw-hub-tile-name">写实人像 Real Portrait</div>
            <div class="cw-hub-tile-meta"><span>Checkpoint</span><span>SDXL 1.0</span><span>↓ 89,002</span></div>
          </div>
        </button>
      </div>
    </div>

    <div class="cw-card">
      <div class="cw-card-head">
        <h3 class="cw-card-title">详情弹层（点卡片打开，点遮罩关闭）</h3>
      </div>
      <div class="cw-hub-detail" style="position:static;inset:auto;background:none;padding:0;display:block">
        <div class="cw-hub-detail-card">
          <div class="cw-card-head">
            <h3 class="cw-card-title">Abstract Painting · Style [LoRA]</h3>
            <span class="cw-chip">LoRA</span>
            <span class="cw-spacer"></span>
            <a class="cw-btn" href="#">在 Civitai 打开 ↗</a>
            <button class="cw-btn">关闭</button>
          </div>
          <div class="cw-hub-detail-top">
            <div class="cw-hub-detail-cover" style="background:linear-gradient(160deg,#2c3e56,#4a3a63)"></div>
            <div class="cw-hub-detail-info">
              <div class="cw-hub-meta"><span>by abstracter</span><span>↓ 128,431</span><span>♥ 4,218</span><span>★ 4.87</span><span>底模 Pony V6 XL / SDXL 1.0</span></div>
              <div class="cw-hub-meta"><span class="cw-chip">abstract</span><span class="cw-chip">painting</span><span class="cw-chip">style</span></div>
              <div class="cw-hub-file"><span style="opacity:.7">版本</span><select><option>v1.0 · Pony V6 XL</option></select><span style="opacity:.7">触发词 abstract20painting2020style</span></div>
              <p class="cw-hub-desc">作者简介（HTML 已剥成纯文本，段落与换行保留）：这是一段示例描述，讲画风来源、怎么用、权重建议 0.7–0.85 最稳。

第二段：用法与注意事项。太长就在这个框里滚动，不撑爆弹层。</p>
            </div>
          </div>
          <div class="cw-hub-ver">
            <div class="cw-hub-file"><input type="checkbox" checked><span class="nm">abstract20painting2020style.safetensors</span><span style="opacity:.7">72.4 MB</span><span style="opacity:.5">SafeTensor</span><select><option>LoRA</option></select></div>
            <div class="cw-hub-file"><input type="checkbox"><span class="nm">abstract20_painting_v2.safetensors</span><span style="opacity:.7">144.8 MB</span><span style="opacity:.5">SafeTensor</span><select><option>LoRA</option></select></div>
          </div>
          <div class="cw-hub-actions">
            <span class="cw-hub-meta">已选 1 个 · 72.4 MB</span>
            <span class="cw-spacer"></span>
            <button class="cw-btn primary">下载选中</button>
          </div>
        </div>
      </div>
    </div>
    <div class="cw-card">
      <div class="cw-card-head"><h3 class="cw-card-title">助手对话框 · 标签 / 配置</h3></div>
      <div class="cw-hub-chat" style="position:static;inset:auto;background:none;padding:0;display:block">
        <div class="cw-hub-chat-card" style="max-height:none">
          <div class="cw-card-head">
            <h3 class="cw-card-title">模型助手 · 标签 / 配置</h3>
            <span class="cw-chip">Abstract Painting · Style [LoRA]</span>
            <span class="cw-spacer"></span>
            <button class="cw-btn">清空</button>
            <button class="cw-btn">关闭</button>
          </div>
          <div class="cw-hub-chat-log">
            <div class="cw-hub-msg user"><div class="cw-hub-msg-text">帮我找这个模型的触发词和常用标签</div></div>
            <div class="cw-hub-msg">
              <div class="cw-hub-msg-text">触发词就是作者挂在版本上的那串，先抄它；通用画风词只补质感：
1. abstract20painting2020style —— 必带，0.7–0.85
2. oil painting, thick brush stroke —— 通用词，压到 0.5 以下做质感
负面建议：photo, 3d render, smooth shading</div>
              <div class="cw-hub-msg-tags">
                <button class="cw-hub-tag">+abstract20painting2020style</button>
                <button class="cw-hub-tag">+oil painting</button>
                <button class="cw-hub-tag">+thick brush stroke</button>
                <span class="cw-hub-meta">权重 0.8</span>
                <span class="cw-hub-meta">目录 LoRA</span>
              </div>
              <div class="cw-hub-note">deepseek · DeepSeek-V4.1-Flash</div>
            </div>
            <div class="cw-hub-msg user"><div class="cw-hub-msg-text">这套文件该放哪、权重给多少</div></div>
            <div class="cw-hub-msg error"><div class="cw-hub-msg-text">模型没接上：没有可用的 provider（在宿主里挑一个模型再试）</div></div>
          </div>
          <div class="cw-hub-quick">
            <button class="cw-hub-tag">帮我找这个模型的触发词和常用标签</button>
            <button class="cw-hub-tag">这套文件该放哪、权重给多少</button>
            <button class="cw-hub-tag">和本机底模兼容吗，占工作流第几个槽</button>
          </div>
          <div class="cw-hub-chat-input">
            <textarea placeholder="问标签 / 问配置。Enter 发送，Shift+Enter 换行。"></textarea>
            <button class="cw-btn primary">发送</button>
          </div>
        </div>
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
