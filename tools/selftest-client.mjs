/**
 * tools/selftest-client.mjs — 浏览器半的静态断言（不需要 React，不启宿主）。
 *
 * 为什么不上 SSR：本机没有独立可用的 react/react-dom（只有宿主 asar 里那份），
 * 装一份属于「装软件」，不做。这里改为断言真正会出错的那几件事：
 * 契约集合、CSS 变量、两阶段调用顺序、方法名拼写、写死的浅色背景。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ENDPOINTS } from '../lib/typert.host.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')

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

function cssBlock() {
  const marker = 'const CSS = ' + String.fromCharCode(96)
  const start = source.indexOf(marker)
  assert(start >= 0, '没找到 CSS 模板')
  const from = start + marker.length
  const end = source.indexOf(String.fromCharCode(96), from)
  assert(end > from, 'CSS 模板没闭合')
  return source.slice(from, end)
}

check('CSS 模板能完整抽出', () => {
  const css = cssBlock()
  assert(css.length > 5000, 'CSS 太短：' + css.length)
})

check('动图贴纸与三点降级样式都在', () => {
  const css = cssBlock()
  for (const token of ['.cw-think-gif', '.cw-think-sticker', '.cw-think-dots', '@keyframes cw-think-dot', '.cw-btn-busy']) {
    assert(css.includes(token), 'CSS 缺 ' + token)
  }
})

check('notice 支持两行（pre-wrap）', () => {
  const css = cssBlock()
  assert(css.includes('white-space:pre-wrap'), '.cw-note 没开 pre-wrap，判定理由的第二行会被吃掉')
})

check('写死的浅色底只剩 GIF 贴纸那几处', () => {
  const css = cssBlock()
  // 只数「背景色」：#fff 当文字色（缩略图上叠的标题）本来就有，不在此列。
  const hits = css.match(/background:#fff\b/gi) ?? []
  assert(hits.length === 3, 'background:#fff 出现 ' + hits.length + ' 次，期望 3（贴纸底 + 悬停 + 忙碌按钮）')
  const light = [...css.matchAll(/background:(#f[0-9a-f]{2}|#fff|white)\b/gi)].map((m) => m[1])
  assert(light.length <= 3, '还有别的写死浅色底：' + light.join(', '))
})

check('METHODS 与 typert ENDPOINTS 同序同集（25 个）', () => {
  const start = source.indexOf('const METHODS = [')
  const end = source.indexOf(']', start)
  const methods = [...source.slice(start, end).matchAll(/'([A-Za-z]\w*)'/g)].map((m) => m[1])
  assert(methods.length === 25, 'METHODS 条数 ' + methods.length)
  assert(methods.join(',') === ENDPOINTS.join(','), '顺序或集合不一致' + String.fromCharCode(10) + 'client: ' + methods.join(',') + String.fromCharCode(10) + 'host:   ' + ENDPOINTS.join(','))
})

check('页面调用的方法名都在 METHODS 里', () => {
  const start = source.indexOf('const METHODS = [')
  const end = source.indexOf(']', start)
  const methods = new Set([...source.slice(start, end).matchAll(/'([A-Za-z]\w*)'/g)].map((m) => m[1]))
  const used = new Set([...source.matchAll(/call\('([A-Za-z]\w*)'/g)].map((m) => m[1]))
  const unknown = [...used].filter((name) => !methods.has(name))
  assert(unknown.length === 0, '页面调了没声明的通道方法：' + unknown.join(', '))
})

check('改写换成两阶段：先 rewritePlan 再 rewriteApply', () => {
  const planAt = source.indexOf("call('rewritePlan'")
  const applyAt = source.indexOf("call('rewriteApply'")
  assert(planAt > 0 && applyAt > 0, '没找到两阶段调用')
  assert(planAt < applyAt, '调用顺序反了')
  assert(!source.includes("mode: 'llm'"), '旧的单次 submit(mode:llm) 还在')
})

check('先写反向框再覆盖原文（源码顺序）', () => {
  const planAt = source.indexOf("call('rewritePlan'")
  const applyAt = source.indexOf("call('rewriteApply'")
  const setNegAt = source.indexOf('setNegative(plan.negative)', planAt)
  assert(setNegAt > planAt && setNegAt < applyAt, 'setNegative 不在两阶段之间')
  const setTextAt = source.indexOf('setText(applied.positive)', applyAt)
  assert(setTextAt > applyAt, 'setText 不在 rewriteApply 之后')
})

check('撤销与取消都在页面上', () => {
  for (const token of ['const cancelRewrite', 'const undoRewrite', "call('rewriteCancel'", "'撤销改写'", "'取消'"]) {
    assert(source.includes(token), '缺 ' + token)
  }
  assert(source.includes('setUndoRef({ text, negative })'), '点击时没存快照')
})

check('busy 状态换成 GIF 贴纸', () => {
  assert(source.includes('function ThinkIcon'), '没有 ThinkIcon')
  assert(source.includes('/dsh-comfy/asset/thinking.gif?t='), '没有动图路由')
  assert(source.includes('setRewritePhase('), '没有阶段状态')
  assert(source.includes("rewritePhase === 'apply' ? '思考中' : '判定中'"), '阶段文案没接上')
})

check('五个卡片 / 三个标签页仍在', () => {
  const cards = (source.match(/className: 'cw-card/g) ?? []).length
  assert(cards >= 5, 'cw-card 只有 ' + cards + ' 个')
  for (const tab of ["setTab('work')", "setTab('gallery')", "setTab('catalog')"]) {
    assert(source.includes(tab), '缺标签 ' + tab)
  }
})

check('接口说明卡片列出新路由', () => {
  for (const route of ['/dsh-comfy/asset/thinking.gif', '/v1/rewrite/plan', '/v1/rewrite/apply', '/v1/rewrite/cancel']) {
    assert(source.includes(route), '接口卡没写 ' + route)
  }
})

check('输入框与思考框并排（两列），输入框缩小了', () => {
  const css = cssBlock()
  assert(css.includes('.cw-split{display:grid'), 'CSS 缺 .cw-split')
  assert(css.includes('.cw-split{display:grid;grid-template-columns:minmax(0,1.55fr)'), '.cw-split 不是两列')
  assert(css.includes('min-height:104px'), '输入框没缩小')
  assert(source.includes("className: 'cw-split'") && source.includes("key: 'think'"), '页面没把两块并排')
})

check('改写过程写进思考框，不写进输出框', () => {
  assert(source.includes('const appendThink ='), '没有 appendThink')
  assert(source.includes('const clearThink ='), '没有清空')
  assert(source.includes("className: 'cw-card cw-think-card'"), '没有思考卡')
  assert(source.includes('className: \'cw-logbox\''), '没有思考日志容器')
  assert(!/addLocal\('[a-z]+', '改写/.test(source), '改写仍在往输出框写 addLocal')
  assert(!source.includes("addLocal('info', '反向提示词已"), '反向词日志仍在输出框')
  assert(!source.includes("addLocal('info', '正向提示词已覆盖原文"), '正向日志仍在输出框')
})

check('思考卡显示人设接没接', () => {
  assert(source.includes("label: '人设'"), '思考卡没显示人设')
  assert(source.includes('已接入全局内容尺度'), '思考框日志里没人设那一行')
})

check('思考卡显示判定依据与思考摘要', () => {
  for (const token of ['thinkInfo', 'cfg / 负面', '判定', "'思考：' + thinkInfo.reasoning"]) {
    assert(source.includes(token), '思考卡缺 ' + token)
  }
})

check('LoRA 多选器：勾选顺序写进槽位', () => {
  const css = cssBlock()
  for (const token of ['cw-chip-btn', 'cw-lora-list', 'cw-lora-item', 'cw-lora-idx', 'cw-lora-name', 'cw-lora-str', 'cw-lora-foot']) {
    assert(css.includes('.' + token), 'CSS 缺 .' + token)
  }
  assert(source.includes('const [loraSel, setLoraSel] = useState([])'), '没有 LoRA 选择状态')
  assert(source.includes('const toggleLora ='), '没有勾选处理')
  assert(source.includes('loras: loraSel.map((item) => ({ name: item.name, strength: item.strength }))'), '出图没把勾选传给宿主')
  assert(source.includes('setLoraSel([])'), '换工作流没清空勾选')
})

console.log('')
if (failures > 0) {
  console.log('有 ' + failures + ' 项没通过')
  process.exitCode = 1
} else {
  console.log('全部 ' + checks + ' 项通过')
}
