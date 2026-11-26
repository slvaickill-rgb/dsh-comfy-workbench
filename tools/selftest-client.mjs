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

check('METHODS 与 typert ENDPOINTS 同序同集（37 个）', () => {
  const start = source.indexOf('const METHODS = [')
  const end = source.indexOf(']', start)
  const methods = [...source.slice(start, end).matchAll(/'([A-Za-z]\w*)'/g)].map((m) => m[1])
  assert(methods.length === 37, 'METHODS 条数 ' + methods.length)
  assert(methods.join(',') === ENDPOINTS.join(','), '顺序或集合不一致' + String.fromCharCode(10) + 'client: ' + methods.join(',') + String.fromCharCode(10) + 'host:   ' + ENDPOINTS.join(','))
})

check('网关 method-unavailable 退到 HTTP /v1/call（只这一种）', () => {
  assert(source.includes('method-unavailable|has no callable method'), '没有 method-unavailable 的兜底匹配')
  assert(source.includes('return httpCall(method, args)'), '兜底没走 HTTP')
  // 其余业务错误不能重试：文案里得留着这句约定。
  assert(source.includes('绝不换通道重试'), '丢了「业务错误不换通道」的注释/约定')
})

check('宿主服务实现了每个 ENDPOINTS（防 gateway/method-unavailable）', () => {
  // 这个坑踩过：ENDPOINTS 里加了 hubChat，忘了在 index.js 的 Service 类上补转发方法，
  // 页面就只拿到 `[gateway/method-unavailable] ... has no callable method "hubChat"`。
  const indexSource = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  const apiSource = fs.readFileSync(path.join(ROOT, 'lib', 'api.js'), 'utf8')
  const missing = []
  for (const name of ENDPOINTS) {
    if (!new RegExp('\\n    ' + name + '\\(args\\) \\{').test(indexSource)) missing.push(name + '（index.js 没转发）')
    if (!apiSource.includes('\n    ' + name + ',')) missing.push(name + '（api.js 没导出）')
  }
  assert(missing.length === 0, '宿主半缺：' + missing.join('、'))
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

check('五个卡片 / 四个标签页仍在', () => {
  const cards = (source.match(/className: 'cw-card/g) ?? []).length
  assert(cards >= 5, 'cw-card 只有 ' + cards + ' 个')
  for (const tab of ["setTab('work')", "setTab('gallery')", "setTab('catalog')", "setTab('hub')"]) {
    assert(source.includes(tab), '缺标签 ' + tab)
  }
  assert(source.includes("'模型库 · Civitai'"), '第四个标签文案没接上')
  assert(source.includes('https://civitai.red/models'), '模型库没显示来源地址')
})

check('模型库：key 三态 + 记住本机 + 不回显', () => {
  assert(source.includes("type: 'password'"), 'key 输入框不是 password')
  assert(source.includes("autoComplete: 'off'"), 'key 输入框没关自动填充')
  assert(source.includes('记住在本机'), '缺「记住在本机」勾选框')
  assert(source.includes('仅本次有效'), '缺「仅本次有效」这一态')
  assert(source.includes('已保存 '), '缺「已保存 + 时间」这一态')
  assert(!source.includes('setKeyInput(next.key'), '页面把 key 原文读回来了')
  assert(source.includes("call('hubKey', { key: text, persist: remember })"), '保存没带 persist')
  assert(source.includes("call('hubKey', { key: '' })"), '清除没走空串')
})

check('组件作用域：setX 必须在同一个组件里声明（黑屏回归二）', () => {
  // 踩过两回：批量删代码把 paste/pollRef 删了；又把 zhDesc 删了、zhLoras 声明错组件。
  // 这里按组件切段，逐个检查「用到的 setter」是否在段内声明过。
  const lineList = source.split(/\r?\n/)
  const starts = []
  lineList.forEach((line, index) => {
    const hit = /^    function ([A-Za-z0-9_$]+)\(/.exec(line)
    if (hit) starts.push({ name: hit[1], line: index })
  })
  const allow = new Set(['setInterval', 'setTimeout', 'setAttribute', 'setImmediate'])
  const problems = []
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1].line : lineList.length
    const body = lineList.slice(starts[index].line, end).join('\n')
    const declared = new Set([...body.matchAll(/\bconst \[[^,\]]+,\s*([A-Za-z0-9_$]+)\]/g)].map((m) => m[1]))
    for (const m of body.matchAll(/\bconst (set[A-Za-z0-9_$]+) =/g)) declared.add(m[1])
    for (const m of body.matchAll(/\b(set[A-Z][A-Za-z0-9_$]*)\(/g)) {
      if (!declared.has(m[1]) && !allow.has(m[1])) problems.push(starts[index].name + ' → ' + m[1])
    }
  }
  assert(problems.length === 0, '跨组件用了没声明的 setter：' + [...new Set(problems)].join('、'))
})
check('模型库：HubPane 自己用到的基础状态都有声明（黑屏回归）', () => {
  // 踩过：批量删助手代码时把 paste / pollRef 的声明一起删了，进模型库整页黑屏
  // （React 渲染时 ReferenceError）。这里只钉最容易漏的那几个。
  for (const token of ["const [paste, setPaste] = useState('')", 'const pollRef = useRef(null)']) {
    assert(source.includes(token), 'HubPane 缺声明：' + token)
  }
  assert(source.includes('pollRef.current = setInterval'), '下载轮询还在用 pollRef')
  // 踩过第二回：zhLoras 声明在 HubPane、却被 Page 的 LoRA 面板用，整页黑屏。
  const pageAt = source.indexOf('function Page()')
  const hubAt = source.indexOf('function HubPane(')
  const zhAt = source.indexOf('const [zhLoras, setZhLoras] = useState({})')
  assert(zhAt > pageAt && pageAt > 0, 'zhLoras 没声明在 Page 里（Page 起点 ' + pageAt + '，声明 ' + zhAt + '）')
  assert(source.indexOf('const [zhLoras, setZhLoras] = useState({})', zhAt + 1) === -1, 'zhLoras 重复声明')
  assert(hubAt > 0 && pageAt > hubAt, '组件顺序变了，检查这条断言')
})

check('模型库：模型助手已下线，改自动翻译', () => {
  // 助手那套 UI 全删了：图标按钮、对话框、标签插入都不该再出现。
  for (const token of ['模型助手 · 标签 / 配置', 'cw-hub-chat-log', 'cw-hub-chat-input', "call('hubChat'"]) {
    assert(!source.includes(token), '助手残留：' + token)
  }
  assert(!source.includes('问助手'), '「问助手」按钮还在')
  // 自动翻译：结果里的英文名走 hubTranslate，译文压在上面、英文留小字。
  for (const token of ["call('hubTranslate'", 'autoTranslate', 'zhNames', 'zhDesc', 'cw-hub-tile-en', 'cw-hub-desc-head']) {
    assert(source.includes(token), '缺 ' + token)
  }
  assert(source.includes('看原文') && source.includes('看译文'), '详情没有原文/译文切换')
  // 下载进度：底栏一条、每个文件一条，都带百分比。
  assert(source.includes('cw-hub-foot-bar'), '底栏没有进度条')
  assert(source.includes('cw-hub-item-bar'), '每个文件没有进度条')
  // LoRA 文件名也要翻：中文名在上、原名小字。
  assert(source.includes('zhLoras'), 'LoRA 列表没翻译')
  assert(source.includes('cleanLoraName'), '文件名没清洗成可翻的短语')
  assert(source.includes('cw-lora-en'), 'LoRA 原名小字样式缺')
  assert(source.includes("style: 'lora'"), 'LoRA 翻译没走文件名专用口吻')
  // 触发词：宿主持久化 + 面板 chip 复制 + 改写带上 loras。
  for (const token of ["call('hubTriggers'", "call('hubLookupTriggers'", 'triggerMap', 'cw-lora-trigger', 'copyTrigger', 'triggerWordsFor', 'lookupTriggers']) {
    assert(source.includes(token), '缺 ' + token)
  }
  assert((source.match(/^\s+loras,$/gm) ?? []).length >= 2, '改写两次调用没都带上 loras')
  assert(source.includes('jobPercent'), '没有总进度百分比')
})

check('模型库：勾选 → 目标目录 → 下载', () => {
  for (const token of ['toggleFile', 'setTarget', "call('hubDownload'", "call('hubJob'", "call('hubCancel'", "call('hubSearch'", "call('hubResolve'"]) {
    assert(source.includes(token), '缺 ' + token)
  }
  assert(source.includes('targetCategory'), '勾选项没带目标目录')
  assert(source.includes("'/dsh-comfy/hub/cover'") || source.includes('hub/cover'), '封面没走同源反代')
})

check('模型库样式只用主题变量', () => {
  const css = cssBlock()
  for (const token of ['.cw-hub-drawer', '.cw-hub-progress', '.cw-hub-grid', '.cw-hub-tile', '.cw-hub-detail', '.cw-hub-file']) {
    assert(css.includes(token), 'CSS 缺 ' + token)
  }
  // 不写正则：逐条规则扫，模型库的选择器里不许出现写死的浅色底。
  const rules = css.split('}')
  for (const rule of rules) {
    if (!rule.includes('.cw-hub')) continue
    const lower = rule.toLowerCase()
    assert(!lower.includes('background:#f'), '模型库样式里写死了浅色底：' + rule.slice(0, 80))
    assert(!lower.includes('background:#fff'), '模型库样式里写死了白底：' + rule.slice(0, 80))
    assert(!lower.includes('background:white'), '模型库样式里写死了白底：' + rule.slice(0, 80))
  }
})

check('模型库：已下载标记 + 只看已下载', () => {
  for (const token of ['onlyDownloaded', 'shownItems', '只看已下载', 'cw-hub-installed', 'cw-hub-tile-check', 'M4 12.5 9.5 18 20 6.5']) {
    assert(source.includes(token), '缺 ' + token)
  }
  assert(source.includes('installedCount'), '结果头没显示已下载数量')
})

check('模型库：底模下拉含 MOSS，并会记住结果里的新底模', () => {
  assert(source.includes("'MOSS Image'"), '底模下拉没有 MOSS Image')
  assert(source.includes('extraBases'), '没有把结果里出现的底模补进下拉')
  assert(source.includes('HUB_BASE_MODELS.concat(extraBases'), '下拉没合并动态项')
})

check('模型库：大图网格 + 点开看详情', () => {
  for (const token of ['cw-hub-grid', "className: 'cw-hub-tile'", 'cw-hub-detail-card', 'cw-hub-desc', 'detailId']) {
    assert(source.includes(token), '缺 ' + token)
  }
  assert(source.includes('setDetailId(model.id)'), '卡片没接详情入口')
  assert(source.includes('detail.description'), '详情没显示简介')
  assert(source.includes("'在 Civitai 打开 ↗'"), '详情没给外链')
  // 代理提示要走 host 报上来的 status.proxy，不能写死文案。
  assert(source.includes('status?.proxy'), '页面没显示代理状态')
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
  for (const token of ['cw-chip-btn', 'cw-lora-pop', 'cw-lora-list', 'cw-lora-item', 'cw-lora-idx', 'cw-lora-name', 'cw-lora-str', 'cw-lora-foot']) {
    assert(css.includes('.' + token), 'CSS 缺 .' + token)
  }
  assert(source.includes('const [loraSel, setLoraSel] = useState([])'), '没有 LoRA 选择状态')
  assert(source.includes('const toggleLora ='), '没有勾选处理')
  assert(source.includes('loras: loraSel.map((item) => ({ name: item.name, strength: item.strength }))'), '出图没把勾选传给宿主')
  assert(source.includes('setLoraSel([])'), '换工作流没清空勾选')
  // 下拉：挂在那枚徽标下面，点外面 / Esc 收起。
  assert(source.includes("className: 'cw-lora-pop'"), 'LoRA 面板没做成下拉')
  assert(source.includes('loraPopRef'), '下拉没挂锚点')
  assert(source.includes("event.key === 'Escape'"), 'Esc 收不起下拉')
  assert(source.includes('HUB_BASE_MODEL_LABELS'), '底模下拉没汉化标签')
  // 下完要自动重扫目录，不然新下的 LoRA 不进选择菜单。
  assert(source.includes('refreshTokenRef'), '下完没自动刷新目录')
  assert(source.includes('onRefreshDirs()'), '没触发目录刷新')
  assert(source.includes("'刷新'"), 'LoRA 面板里没有手动刷新')
})

console.log('')
if (failures > 0) {
  console.log('有 ' + failures + ' 项没通过')
  process.exitCode = 1
} else {
  console.log('全部 ' + checks + ' 项通过')
}
