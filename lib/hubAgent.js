/**
 * lib/hubAgent.js — 下载完成后那份「安装建议」的编排。
 *
 * 只做三件事：把**结构化事实**拼成 prompt、把模型的输出解析成固定字段、输出不合法时降级成事实卡片。
 * 真正的补全调用交给 `lib/llm.js`（那边管 provider / 超时 / 流拼接），这里不重复实现。
 *
 * 为什么不让模型自由发挥：它不知道本机装的是 MOSS / anima 还是 Pony 底模，也不知道
 * `C:\Comfyui model\loras` 里已经有哪 9 个文件。把事实喂进去、只让它判断，
 * 输出的 `targetDir` / `suggestedStrength` / `actions` 还要再过一遍白名单与 clamp。
 */

import { MODEL_CATEGORIES } from './dirs.js'

/** 允许模型建议的一键动作。 */
export const ADVICE_ACTIONS = ['selectLora', 'refreshDirs', 'fillDraft', 'copyReport']

export const SYSTEM_PROMPT_HUB = [
  '你是 ComfyUI 的模型安装助手。用户刚把一个 Civitai 上的模型文件下载到本机。',
  '下面会给你一组**结构化事实**，你只能基于事实判断，不要编造文件、路径或版本。',
  '严格只输出一个 JSON 对象，不要代码块、不要解释、不要前后缀。字段如下：',
  '{"compatible":"yes|no|unknown","reason":"一句话理由",',
  '"targetDir":"必须是给定的类别名之一","triggerWords":["英文触发词"],',
  '"suggestedStrength":0.8,"checkpoint":"底模建议，没有就给空串",',
  '"warnings":["需要注意的事"],"actions":["selectLora|refreshDirs|fillDraft|copyReport"]}',
  '判断兼容性时看 LoRA 的 baseModel 与本机底模是否同族；不确定就填 unknown，不要猜。',
  'triggerWords 只能从事实里的 trainedWords 与模型名抄，不要自己造。',
].join('')

/**
 * 拼事实。
 * @param args - `{ job, dirs, workflows, question }`
 *   job：`hubJob` 快照；dirs：`collectDirs()` 快照；workflows：`listWorkflows()` 结果。
 */
export function buildFacts(args = {}) {
  const job = args.job ?? { items: [] }
  const dirs = args.dirs ?? {}
  const workflows = args.workflows ?? { items: [] }
  const done = (job.items ?? []).filter((item) => item.state === 'done')
  const checkpoints = Array.isArray(dirs.files?.checkpoints) ? dirs.files.checkpoints : []
  const loras = Array.isArray(dirs.files?.loras) ? dirs.files.loras : []
  return {
    files: done.map((item) => ({
      name: item.name,
      category: item.targetCategory,
      path: item.path,
      sizeBytes: Number(item.sizeBytes) || 0,
      sha256: item.sha256 ?? null,
      sha256Ok: item.sha256Ok ?? null,
    })),
    model: args.model ?? null,
    host: {
      modelBase: dirs.modelBase ?? null,
      checkpoints: checkpoints.slice(0, 12),
      loraCount: loras.length,
      loras: loras.slice(0, 24),
      categories: MODEL_CATEGORIES,
    },
    workflows: (workflows.items ?? []).map((item) => ({
      id: item.id,
      title: item.title,
      loraSlots: Array.isArray(item.summary?.loras) ? item.summary.loras.length : 0,
      steps: item.summary?.steps ?? null,
      cfg: item.summary?.cfg ?? null,
    })),
    question: typeof args.question === 'string' ? args.question.slice(0, 400) : '',
  }
}

/** 把事实压成一段紧凑 JSON 给模型；不塞路径以外的任何凭据。 */
export function factsPrompt(facts) {
  return '事实：\n' + JSON.stringify(facts, null, 1)
}

/**
 * 解析模型输出。容错去围栏、去前后废话。
 * @param text - 模型原文。
 * @returns 归一后的建议对象。
 * @throws `hub-advice-invalid`：解析不出来或字段整体不像。
 */
export function parseAdvice(text) {
  const raw = String(text ?? '').trim()
  if (raw.length === 0) throw invalid('模型返回空内容')
  const body = stripFence(raw)
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw invalid('模型输出里没有 JSON 对象')
  let parsed
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch {
    throw invalid('模型输出的 JSON 解析失败')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid('模型输出不是对象')
  const compatibleRaw = String(parsed.compatible ?? '').toLowerCase()
  const compatible = ['yes', 'no', 'unknown'].includes(compatibleRaw) ? compatibleRaw : 'unknown'
  const targetDir = MODEL_CATEGORIES.includes(String(parsed.targetDir ?? ''))
    ? String(parsed.targetDir)
    : null
  const strength = Number(parsed.suggestedStrength)
  return {
    compatible,
    reason: clip(String(parsed.reason ?? ''), 400),
    targetDir,
    triggerWords: strings(parsed.triggerWords, 20, 60),
    suggestedStrength: Number.isFinite(strength) ? Math.min(Math.max(strength, 0), 2) : null,
    checkpoint: clip(String(parsed.checkpoint ?? ''), 200),
    warnings: strings(parsed.warnings, 8, 200),
    actions: strings(parsed.actions, 4, 40).filter((action) => ADVICE_ACTIONS.includes(action)),
  }
}

/**
 * 降级：模型没有 / 输出不合法时给纯事实卡片，字段齐、不带任何模型结论。
 * @param facts - `buildFacts()` 的结果。
 * @param reason - 为什么降级（给用户看的一句）。
 */
export function fallbackAdvice(facts, reason) {
  const first = Array.isArray(facts.files) ? facts.files[0] : null
  return {
    compatible: 'unknown',
    reason: reason ?? '没有拿到模型结论，下面是纯事实',
    targetDir: first?.category ?? null,
    triggerWords: [],
    suggestedStrength: null,
    checkpoint: '',
    warnings: first === null ? ['没有已完成的文件'] : ['ComfyUI 的 LoraLoader 列表可能是启动时缓存的，认不出新文件就刷新节点或重启 8188'],
    actions: ['refreshDirs', 'copyReport'],
  }
}

/** 给「复制报告」用的纯文本。 */
export function adviceReport(advice, facts) {
  const lines = []
  const label = { yes: '兼容', no: '不兼容', unknown: '未判定' }
  lines.push('安装建议（' + (label[advice.compatible] ?? '未判定') + '）：' + (advice.reason || '—'))
  for (const file of facts.files ?? []) {
    lines.push('文件：' + file.name)
    lines.push('位置：' + file.path)
    if (file.sizeBytes > 0) lines.push('大小：' + fmt(file.sizeBytes))
    if (file.sha256) lines.push('SHA256：' + file.sha256 + (file.sha256Ok === true ? '（已校验）' : ''))
  }
  if (advice.targetDir) lines.push('目标类别：' + advice.targetDir)
  if (advice.triggerWords.length > 0) lines.push('触发词：' + advice.triggerWords.join(', '))
  if (advice.suggestedStrength !== null) lines.push('推荐权重：' + advice.suggestedStrength)
  if (advice.checkpoint) lines.push('底模建议：' + advice.checkpoint)
  for (const warning of advice.warnings) lines.push('注意：' + warning)
  return lines.join('\n')
}

/**
 * 对话框模式的系统提示词：只答「标签」和「配置」两件事。
 * 跟一次性安装建议的区别：允许追问，所以事实只喂一次，历史由页面带上来。
 */
export const SYSTEM_PROMPT_CHAT = [
  '你是 ComfyUI 模型库里的配置助手，只做两件事：',
  '① 帮用户找标签：LoRA 触发词、画风词、角色词、负面结构词；只能是事实里出现过的英文词，或明确标注「常见通用词」，不许编造。',
  '② 帮用户决定配置：目标目录、LoRA 权重、底模是否同族、占工作流第几个槽、要不要配负面词。',
  '下面给你本机与所选模型的结构化事实，只能基于事实说话，不要编造文件、路径、版本或权重。',
  '回答用中文，分点、不超过 200 字；用户问标签时把可直接粘贴的标签写成英文、逗号分隔。',
  '最后单独输出一行 JSON（不要代码块）：{"tags":["英文标签"],"targetDir":"类别或空串","suggestedStrength":0.8}',
  'tags 只放这次能直接粘进提示词的词，没有就空数组；拿不准 targetDir 就空串，拿不准权重就 null。',
].join('\n')

/**
 * 解析对话回复：正文 + 末尾那行 JSON（标签 / 目标目录 / 权重）。
 * JSON 解析不出来不算错——当纯文本回复，标签留空，页面照样能聊天。
 * @param text - 模型原文。
 * @returns `{ text, tags, targetDir, suggestedStrength }`。
 * @throws `hub-advice-invalid`：模型返回空内容。
 */
export function parseChat(text) {
  const raw = String(text ?? '').trim()
  if (raw.length === 0) throw invalid('模型返回空内容')
  const body = stripFence(raw)
  let reply = body
  let payload = null
  const start = body.lastIndexOf('{')
  const end = body.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(body.slice(start, end + 1))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        && ('tags' in parsed || 'targetDir' in parsed || 'suggestedStrength' in parsed)) {
        payload = parsed
        reply = body.slice(0, start).trim()
      }
    } catch {
      /* 没给 JSON 就按纯文本算 */
    }
  }
  const strength = Number(payload?.suggestedStrength)
  return {
    text: clip(reply.length > 0 ? reply : body, 4000),
    tags: strings(payload?.tags, 24, 60),
    targetDir: payload !== null && MODEL_CATEGORIES.includes(String(payload.targetDir ?? '')) ? String(payload.targetDir) : null,
    suggestedStrength: Number.isFinite(strength) ? Math.min(Math.max(strength, 0), 2) : null,
  }
}

/**
 * 自动翻译的提示词：只做英→中，不改专有名词。
 * 为什么走大模型而不是翻译 API：本机直连外网翻译服务基本都挂（hosts 劫 + SNI 被墙），
 * 宿主里的 `ctx.llm` 才是稳定通道。
 */
export const SYSTEM_PROMPT_TRANSLATE = [
  '你是翻译。把用户给的每一行英文翻成简体中文。',
  '只输出一个 JSON 字符串数组，顺序与输入一一对应：["第一行译文","第二行译文"]。',
  '不要解释、不要编号、不要代码块。模型名、LoRA 触发词、人名、作品名保留原文不译。',
].join('\n')

/**
 * 解析翻译结果：优先 JSON 数组，解不出来按行拆（去编号）。
 * @param text - 模型原文。
 * @param count - 期望条数，短了补空串。
 * @returns 长度等于 count 的译文数组。
 * @throws `hub-advice-invalid`：一条都没解析出来。
 */
export function parseTranslations(text, count) {
  const raw = String(text ?? '').trim()
  const body = stripFence(raw)
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  let list = []
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(body.slice(start, end + 1))
      if (Array.isArray(parsed)) list = parsed
    } catch {
      /* 退回按行拆 */
    }
  }
  if (list.length === 0) {
    list = body.split('\n').map((line) => line.replace(/^\s*\d+[.;:)]\s*/, '').trim()).filter((line) => line.length > 0)
  }
  const total = Number.isFinite(count) && count > 0 ? Math.trunc(count) : list.length
  const out = []
  for (let index = 0; index < total; index += 1) {
    const value = list[index]
    out.push(typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 400) : '')
  }
  if (out.every((item) => item.length === 0)) throw invalid('翻译结果解析失败')
  return out
}
function stripFence(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return fenced === null ? text : fenced[1]
}

function strings(value, max, maxLength) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = clip(item.trim(), maxLength)
    if (text.length > 0 && !out.includes(text)) out.push(text)
    if (out.length >= max) break
  }
  return out
}

function clip(text, max) {
  return text.length > max ? text.slice(0, max) : text
}

function invalid(message) {
  const error = new Error(message)
  error.code = 'hub-advice-invalid'
  return error
}

function fmt(bytes) {
  const value = Number(bytes) || 0
  if (value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(2) + ' GB'
  if (value >= 1024 ** 2) return (value / 1024 ** 2).toFixed(1) + ' MB'
  return Math.round(value / 1024) + ' KB'
}
