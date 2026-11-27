/**
 * tools/visual-check.mjs — 无头 Chrome 量真实布局（五尺寸 × 双主题）+ 截图。
 *
 *   node tools/visual-check.mjs              # 量尺寸 + 断言
 *   node tools/visual-check.mjs --no-shot    # 只量，不截图
 *
 * 为什么用 --dump-dom 而不是 CDP：样张里自带一段探针脚本，把布局事实写进
 * <pre id="cw-metrics">，`chrome --headless=new --dump-dom` 就能读回来。
 * 不装 puppeteer / 不连 WebSocket，零新依赖（本机 Chrome 20:21 实测可用）。
 *
 * 断言口径（对应方案书 §10 P1 响应式 / 动效）：
 *   1) .cw-root 与文档都不横向溢出；
 *   2) 所有卡片右边界不超根右边界；
 *   3) < 480px 时顶部标签让位给底部 tab bar，且内容不被底栏压住；
 *   4) 主按钮在 brand-primary=白色的皮肤上仍可读（对比度 ≥ 4.5）；
 *   5) prefers-reduced-motion 下动画/过渡时长被压到 0.01ms 级；
 *   6) pointer:coarse 下命中区 ≥ 44px；
 *   7) 抽掉全部 --dsw-alias-* 后落到兜底层，不白屏不黑字黑底。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { SIZES, THEMES, buildHtml } from './theme-check.mjs'

const BS = String.fromCharCode(92)
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate))
if (CHROME === undefined) {
  console.log('没找到 Chrome/Edge，跳过布局量测（不算失败：静态断言在 selftest-client / theme-check 里）')
  process.exit(0)
}

const DIR = path.join(os.tmpdir(), 'dsh-comfy-visual-check')
fs.mkdirSync(DIR, { recursive: true })
const WANT_SHOT = !process.argv.includes('--no-shot')

let failures = 0
let checks = 0
const warnings = []

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
function warn(message) {
  if (!warnings.includes(message)) warnings.push(message)
}

function url(file) {
  return 'file:///' + file.split(BS).join('/')
}

function unescapeHtml(text) {
  return text
    .split('&lt;').join('<')
    .split('&gt;').join('>')
    .split('&quot;').join('"')
    .split('&#39;').join(String.fromCharCode(39))
    .split('&amp;').join('&')
}

/** 跑一次 Chrome：--dump-dom 拿探针 JSON。 */
function measure(tag, options, extraFlags) {
  const html = path.join(DIR, tag + '.html')
  fs.writeFileSync(html, buildHtml(Object.assign({ metrics: true }, options)), 'utf8')
  const flags = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--hide-scrollbars',
    '--window-size=' + options.width + ',' + options.height,
    '--virtual-time-budget=2500',
  ].concat(extraFlags === undefined ? [] : extraFlags)
  const run = spawnSync(CHROME, flags.concat(['--dump-dom', url(html)]), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90000 })
  const dom = run.stdout === null ? '' : run.stdout
  const marker = '<pre id="cw-metrics">'
  const at = dom.indexOf(marker)
  if (at < 0) throw new Error('没读到探针输出（Chrome 退出码 ' + run.status + '）：' + String(run.stderr || '').slice(0, 300))
  const rest = dom.slice(at + marker.length)
  const end = rest.indexOf('</pre>')
  if (end < 0) throw new Error('探针 JSON 没闭合')
  return JSON.parse(unescapeHtml(rest.slice(0, end)))
}

function shoot(tag, options) {
  const html = path.join(DIR, tag + '.html')
  if (!fs.existsSync(html)) fs.writeFileSync(html, buildHtml(Object.assign({ metrics: true }, options)), 'utf8')
  const png = path.join(DIR, tag + '.png')
  // Windows 上 Chrome 有 ~512px 的最小窗口宽；面板宽度靠 body 宽度钉死，这里只保证窗口够装
  const shotWidth = Math.max(options.width, 520)
  spawnSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--hide-scrollbars',
    '--window-size=' + shotWidth + ',' + options.height,
    '--virtual-time-budget=2500',
    '--screenshot=' + png,
    url(html),
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 90000 })
  return fs.existsSync(png) ? png : null
}

const results = []

for (const themeName of Object.keys(THEMES)) {
  for (const size of SIZES) {
    const tag = 'shot-' + themeName + '-' + size.name
    const options = { theme: themeName, width: size.width, height: size.height }
    let metrics = null
    try {
      metrics = measure(tag, options)
    } catch (error) {
      failures += 1
      console.log('FAIL ' + tag + ' 渲染 → ' + (error && error.message ? error.message : error))
      continue
    }
    results.push({ tag, themeName, size, metrics })
  }
}

for (const row of results) {
  const tag = row.tag
  const size = row.size
  const m = row.metrics
  const narrow = size.width < 480

  check(tag + ' · 不横向溢出', () => {
    assert(m.root.scrollWidth <= m.root.clientWidth + 1, '.cw-root 溢出：scrollWidth ' + m.root.scrollWidth + ' > clientWidth ' + m.root.clientWidth)
    // 比 body 而不是 documentElement：body 宽度是钉死的面板宽度，视口差多少不重要
    assert(m.doc.bodyScrollWidth <= m.doc.bodyClientWidth + 1, '页面溢出：' + m.doc.bodyScrollWidth + ' > ' + m.doc.bodyClientWidth)
  })

  check(tag + ' · 卡片不越界', () => {
    const right = m.root.rect.r
    for (const card of m.cards) {
      assert(card.r <= right + 1, '卡片右边界 ' + card.r + ' 超根右边界 ' + right)
      assert(card.r - card.l > 0, '卡片宽度为 0（布局塌了）')
    }
  })

  check(tag + ' · 容器查询生效', () => {
    assert(String(m.root.containerType).includes('inline-size'), '.cw-root 没有 container-type:inline-size（实际 ' + m.root.containerType + '）')
    assert(Math.abs(m.root.clientWidth - size.width) <= 2, '面板宽度 ' + m.root.clientWidth + ' ≠ 目标 ' + size.width + '（容器查询量的是面板宽度，不是视口）')
  })

  check(tag + ' · 主按钮可读（brand-primary=白 的坑）', () => {
    assert(m.primary !== null, '样张里没有 .cw-btn.primary')
    assert(m.primary.rect.w > 0 && m.primary.rect.h > 0, '主按钮尺寸为 0（消失了）')
    assert(m.primary.contrast >= 4.5, '主按钮文字/底色只有 ' + m.primary.contrast + ':1')
  })

  check(tag + ' · 标签形态', () => {
    if (narrow) {
      assert(m.tabs !== null && m.tabs.display === 'none', '窄屏顶部标签没让位（display ' + (m.tabs === null ? '?' : m.tabs.display) + '）')
      assert(m.tabbar !== null && m.tabbar.display !== 'none', '窄屏底部 tab bar 没出现')
      assert(m.tabbar.rect.h >= 40, '底部 tab bar 高度只有 ' + m.tabbar.rect.h)
      assert(m.bodyRect !== null && m.bodyRect.b <= m.tabbar.rect.t + 1, '内容被底部 tab bar 压住：body 底 ' + m.bodyRect.b + ' > tabbar 顶 ' + m.tabbar.rect.t)
    } else {
      assert(m.tabs !== null && m.tabs.display !== 'none', '宽屏顶部标签不见了')
      assert(m.tabbar !== null && m.tabbar.display === 'none', '宽屏还显示底部 tab bar')
    }
  })

  check(tag + ' · 触控/文字对比', () => {
    assert(m.tab === null || m.tab.contrast >= 4, '标签文字对比度只有 ' + (m.tab === null ? '?' : m.tab.contrast))
    if (size.width >= 480) {
      const tiny = m.buttons.filter((b) => b.h > 0 && b.h < 20)
      assert(tiny.length === 0, '桌面档有 ' + tiny.length + ' 个按钮矮于 20px：' + tiny.map((b) => b.text).join(' / '))
    }
  })

  if (WANT_SHOT) {
    const png = shoot(tag, { theme: row.themeName, width: size.width, height: size.height })
    if (png === null) warn(tag + ' 截图失败')
    row.png = png
  }
}

// 触控档：pointer:coarse 下命中区 ≥ 44px
check('pointer:coarse · 命中区 ≥ 44px', () => {
  // Blink 的 PointerType：1=none / 2=coarse / 4=fine；用 blink-settings 模拟粗指针（实测有效）
  const m = measure('coarse-390', { theme: 'dark', width: 390, height: 844 }, ['--blink-settings=primaryPointerType=2,availablePointerTypes=2'])
  if (m.media.coarse !== true) {
    warn('这台 Chrome 不支持 primaryPointerType 模拟（pointer:coarse 仍为 false），触控档断言跳过')
    return
  }
  const small = m.buttons.filter((b) => b.h > 0 && b.h < 44)
  assert(small.length === 0, small.length + ' 个按钮命中区小于 44px：' + small.slice(0, 4).map((b) => b.text + '(' + b.h + ')').join(' / '))
})

// 动效档：prefers-reduced-motion 下时长被压到 0.01ms 级
check('prefers-reduced-motion · 动画时长归零', () => {
  const m = measure('rm-1024', { theme: 'dark', width: 1024, height: 768 }, ['--force-prefers-reduced-motion'])
  if (m.media.reducedMotion !== true) {
    warn('这台 Chrome 不认 --force-prefers-reduced-motion，降级断言跳过（CSS 侧由 selftest 静态钉住）')
    return
  }
  const parse = (text) => Math.max.apply(null, String(text).split(',').map((part) => parseFloat(part) || 0))
  const anim = parse(m.anim.animationDuration)
  const trans = parse(m.anim.transitionDuration)
  assert(anim <= 0.02, 'reduce 档动画还在跑：animationDuration ' + m.anim.animationDuration)
  assert(trans <= 0.02, 'reduce 档过渡还在跑：transitionDuration ' + m.anim.transitionDuration)
})

// 固定高度面板（真实形态）：高度被宿主限死时，头部与标签不允许被 flex 挤扁
check('固定高度 · 头部/标签不被挤扁，body 自己滚', () => {
  const m = measure('bounded-1024', { theme: 'dark', width: 1024, height: 768, bounded: true })
  assert(m.headRect !== null && m.headRect.h >= 40, '头部被挤到 ' + (m.headRect === null ? '?' : m.headRect.h) + 'px')
  assert(m.tabs.rect.h >= 30, '标签栏被挤到 ' + m.tabs.rect.h + 'px（overflow 让 min-height:auto 失效的经典坑）')
  assert(m.bodyRect.h > 120, '正文区只剩 ' + m.bodyRect.h + 'px')
  assert(m.bodyScroll !== null && m.bodyScroll.scrollHeight > m.bodyScroll.clientHeight, 'body 不是滚动容器，长内容会顶出面板')
  assert(m.root.scrollHeight <= m.root.clientHeight + 2, '.cw-root 自己被内容撑高了：' + m.root.scrollHeight + ' > ' + m.root.clientHeight)
})

check('输出卡 · 宽屏图与日志并排，窄屏才竖排', () => {
  const wide = measure('out-878', { theme: 'dark', width: 878, height: 700 })
  assert(wide.outPair.img !== null && wide.outPair.log !== null, '样张缺 .cw-out-img / .cw-log')
  assert(wide.outPair.img.r <= wide.outPair.log.l + 1, '878 档图与日志没并排（图右 ' + wide.outPair.img.r + ' / 日志左 ' + wide.outPair.log.l + '）')
  const narrow = measure('out-390', { theme: 'dark', width: 390, height: 760 })
  assert(narrow.outPair.log.t >= narrow.outPair.img.b - 1, '390 档该竖排（日志顶 ' + narrow.outPair.log.t + ' / 图底 ' + narrow.outPair.img.b + '）')
})
check('参数区 · 标签与控件永远同一行（挤压时不掉行）', () => {
  for (const width of [1024, 480]) {
    const m = measure('fields-' + width, { theme: 'dark', width, height: width === 480 ? 854 : 768, bounded: true })
    assert(m.fieldPairs.length >= 4, width + ' 档只有 ' + m.fieldPairs.length + ' 个 .cw-field，样张没覆盖参数区')
    for (const pair of m.fieldPairs) {
      assert(pair.label !== null && pair.control !== null, '.cw-field 里缺标签或控件')
      assert(pair.control.w >= 60, '控件只有 ' + pair.control.w + 'px 宽（被压扁了）')
      const labelMid = (pair.label.t + pair.label.b) / 2
      const controlMid = (pair.control.t + pair.control.b) / 2
      assert(Math.abs(labelMid - controlMid) <= 14, '标签和控件不在同一行：偏差 ' + Math.abs(labelMid - controlMid).toFixed(1) + 'px')
    }
  }
})
check('固定高度 · 480px 面板（顶栏还在的最窄档）不被挤扁', () => {
  // 真机上的现场就是这一档：面板 480×854、内容比面板长得多
  const m = measure('bounded-480', { theme: 'dark', width: 480, height: 854, bounded: true })
  assert(m.tabs.display !== 'none', '480 档顶部标签不该消失（还没到 479 断点）')
  assert(m.tabs.rect.h >= 30, '480 档标签被挤到 ' + m.tabs.rect.h + 'px')
  assert(m.headRect.h >= 40, '480 档头部被挤到 ' + m.headRect.h + 'px')
  assert(m.bodyRect.h > 100, '480 档正文区只剩 ' + m.bodyRect.h + 'px')
})
check('固定高度 · 窄屏底栏贴底且不压内容', () => {
  const m = measure('bounded-390', { theme: 'dark', width: 390, height: 844, bounded: true })
  assert(m.tabs.display === 'none', '窄屏顶部标签还在')
  assert(m.tabbar.display !== 'none', '窄屏底栏没出现')
  assert(Math.abs(m.tabbar.rect.b - m.viewport.h) <= 2, '底栏没贴底：' + m.tabbar.rect.b + ' vs ' + m.viewport.h)
  assert(m.bodyRect.b <= m.tabbar.rect.t + 1, '内容被底栏压住')
  assert(m.tabbar.rect.h >= 44, '底栏高度只有 ' + m.tabbar.rect.h)
})
// 兜底档：抽掉全部 --dsw-alias-* 后不许白屏 / 黑白颠倒
check('兜底档 · 没有宿主变量也不白屏', () => {
  const m = measure('fallback', { noVars: true, theme: 'light', width: 1024, height: 768 })
  assert(m.primary !== null && m.primary.contrast >= 4.5, '兜底档主按钮对比度 ' + (m.primary === null ? '?' : m.primary.contrast))
  assert(m.tab !== null && m.tab.contrast >= 4, '兜底档标签对比度 ' + (m.tab === null ? '?' : m.tab.contrast))
  assert(m.root.scrollWidth <= m.root.clientWidth + 1, '兜底档横向溢出')
})

console.log('')
console.log('样张与截图目录：' + DIR)
if (WANT_SHOT) {
  const shots = results.filter((row) => row.png !== undefined && row.png !== null).map((row) => row.png)
  console.log('截图 ' + shots.length + ' 张：' + shots.join('  '))
}
if (warnings.length > 0) {
  console.log('')
  console.log('提示：')
  for (const message of warnings) console.log('  · ' + message)
}
console.log('')
if (failures > 0) {
  console.log('有 ' + failures + ' 项没通过')
  process.exitCode = 1
} else {
  console.log('全部 ' + checks + ' 项通过')
}
