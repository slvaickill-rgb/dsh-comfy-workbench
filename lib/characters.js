/**
 * lib/characters.js — 把 comfyui-moss skill 的「角色外貌锚定」搬进插件。
 *
 * 为什么要有这个：MOSS 没有角色库，提示词里只写「樋口円香」四个字等于没写，
 * 底模会按「成熟少妇」自由发挥。skill 的规矩是：画面里有指定角色，先查知识库拿
 * 外貌锚定串（作品名 - 罗马音 - 外貌补充），插在画风句之后、动作之前。
 * 这一步以前只有走 skill 的人肉流程才做，工作台里出不来自动做——现在补上。
 *
 * 只读知识库（C:\RP专用目录\萌娘百科知识库，可通过配置或 DSH_COMFY_CHAR_KB 覆盖），
 * 不联网、不写库；回存使用记录仍然是 moegirl.mjs 的事。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 知识库默认位置（与 comfyui-moss 的 moegirl.mjs 一致）。 */
export const DEFAULT_KB_ROOT = 'C:\\RP专用目录\\萌娘百科知识库'

/** 不是角色的条目：索引、模板、画风库。 */
const SKIP_FILES = new Set(['readme.md', '_模板.md', '画风库.md', 'index.md', '索引.md'])

/** 画风句的判别词：只在开头那一句里出现这些词，才认定它是画风句。 */
const STYLE_HINTS = ['风格', '画风', '厚涂', '水彩', '写实', '动漫', '平涂', '水墨', '赛璐璐', '胶片', '照片', '伪厚涂', '半厚涂', '像素', '3d']

/** 单字角色名（如「光」）太容易误伤，自动锚定跳过；要锚就手写。 */
const MIN_CJK_NAME = 2

/** 反引号围栏，用字符拼出来免得本文件自己被围栏截断。 */
const FENCE = String.fromCharCode(96, 96, 96)

/**
 * 知识库根目录：环境变量 > 配置 > 默认值。
 * @param configured - 配置里的 characterKbRoot。
 */
export function kbRoot(configured = null) {
  const env = process.env.DSH_COMFY_CHAR_KB
  if (typeof env === 'string' && env.trim().length > 0) return env.trim()
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return DEFAULT_KB_ROOT
}

/** 从「## 角色生成串」小节里抠出那一段：优先围栏代码块，其次纯文本行。 */
function extractAnchor(text) {
  const at = text.indexOf('## 角色生成串')
  if (at < 0) return ''
  const rest = text.slice(at)
  const fenced = rest.match(new RegExp(FENCE + '[a-zA-Z0-9_-]*\\n([\\s\\S]*?)' + FENCE))
  if (fenced !== null) {
    return fenced[1].split('\n').map((line) => line.trim()).filter((line) => line.length > 0).join(' ').trim()
  }
  const lines = rest.split('\n').slice(1)
  const out = []
  for (const line of lines) {
    const token = line.trim()
    if (token.startsWith('#') || token.startsWith('>')) break
    if (token.length === 0) { if (out.length > 0) break; continue }
    out.push(token)
  }
  return out.join(' ').trim()
}

/**
 * 解析一份角色档案。
 * @param markdown - 文件内容。
 * @param fileName - 文件名（兜底当名字用）。
 * @returns `{ file, id, workEn, nameEn, nameZh, nameJp, kana, anchor }`；不是角色档案返回 null。
 */
export function parseCharacterFile(markdown, fileName) {
  const text = String(markdown ?? '')
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end < 0) return null
  const fields = {}
  for (const line of text.slice(3, end).split('\n')) {
    const hit = line.match(/^([a-z_]+)\s*:\s*(.*)$/i)
    if (hit !== null) fields[hit[1].toLowerCase()] = hit[2].trim()
  }
  const anchor = extractAnchor(text.slice(end))
  const file = String(fileName ?? '')
  const entry = {
    file,
    id: fields.id ?? '',
    workEn: fields.work_en ?? '',
    nameEn: fields.name_en ?? '',
    nameZh: fields.name_zh ?? file.replace(/\.md$/i, ''),
    nameJp: fields.name_jp ?? '',
    kana: fields.kana ?? '',
    anchor,
  }
  if (entry.nameZh.length === 0 && entry.nameEn.length === 0) return null
  return entry
}

/** 一条档案能被提示词命中的写法：中文名、日文名、假名、英文名、文件名。 */
function namesOf(entry) {
  const out = []
  const push = (value) => {
    const token = String(value ?? '').trim()
    if (token.length > 0 && !out.includes(token)) out.push(token)
  }
  push(entry.nameZh); push(entry.nameJp); push(entry.kana); push(entry.nameEn)
  push(entry.file.replace(/\.md$/i, ''))
  return out
}

function escapeRe(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

let cache = { root: '', stamp: '', entries: [] }

/**
 * 读整个知识库（按每份文件的 mtime+size 缓存）。
 * @param configured - 配置里的 characterKbRoot。
 * @returns 角色档案数组；目录不存在返回空数组。
 */
export function loadKb(configured = null) {
  const root = kbRoot(configured)
  let names = []
  try {
    names = fs.readdirSync(root).filter((name) => name.toLowerCase().endsWith('.md'))
  } catch {
    return []
  }
  const stamp = names.map((name) => {
    try {
      const stat = fs.statSync(path.join(root, name))
      return name + ':' + String(stat.mtimeMs) + ':' + String(stat.size)
    } catch {
      return name
    }
  }).join('|')
  if (cache.root === root && cache.stamp === stamp) return cache.entries
  const entries = []
  for (const name of names) {
    if (SKIP_FILES.has(name.toLowerCase())) continue
    try {
      const entry = parseCharacterFile(fs.readFileSync(path.join(root, name), 'utf8'), name)
      if (entry !== null && entry.anchor.length > 0) entries.push(entry)
    } catch {
      /* 单份坏掉不影响整库 */
    }
  }
  cache = { root, stamp, entries }
  return entries
}

/**
 * 在提示词里找知识库中的角色。
 * @returns `[{ entry, name, at }]`，按首次出现位置排，同名去重。
 */
export function matchCharacters(text, entries) {
  const hay = String(text ?? '')
  if (hay.length === 0) return []
  const lower = hay.toLowerCase()
  const hits = []
  for (const entry of entries) {
    for (const name of namesOf(entry)) {
      const cjk = /[^\x00-\x7F]/.test(name)
      if (cjk) {
        const compact = name.replace(/\s+/g, '')
        if ([...compact].length < MIN_CJK_NAME) continue
        const at = hay.replace(/\s+/g, '').indexOf(compact)
        if (at < 0) continue
        hits.push({ entry, name, at })
        break
      }
      if (name.length < 3) continue
      const re = new RegExp('(^|[^a-z0-9])' + escapeRe(name) + '([^a-z0-9]|$)', 'i')
      const found = lower.search(re)
      if (found < 0) continue
      hits.push({ entry, name, at: found })
      break
    }
  }
  hits.sort((left, right) => left.at - right.at)
  const seen = new Set()
  const out = []
  for (const hit of hits) {
    const key = hit.entry.id.length > 0 ? hit.entry.id : hit.entry.file
    if (seen.has(key)) continue
    seen.add(key)
    out.push(hit)
  }
  return out
}

/** 开头那一句是不是画风句（skill 规矩：画风恰好一句、永远放最前）。 */
export function splitStyleLead(text) {
  const hit = String(text ?? '').match(/^([^。\n]{1,40}。)([\s\S]*)$/)
  if (hit === null) return { style: '', body: String(text ?? '') }
  const lead = hit[1].toLowerCase()
  if (!STYLE_HINTS.some((hint) => lead.includes(hint))) return { style: '', body: String(text ?? '') }
  return { style: hit[1], body: hit[2].trim() }
}

/**
 * 出图前把外貌串插进提示词。
 * @param text - 用户（或大模型）给的提示词。
 * @param options - `{ kbRoot?, entries?, limit? }`。
 * @returns `{ text, inserted, skipped, root }`；inserted 每项 `{ name, id, anchor }`。
 */
export function anchorPrompt(text, options = {}) {
  const raw = String(text ?? '')
  const root = kbRoot(options.kbRoot)
  const entries = Array.isArray(options.entries) ? options.entries : loadKb(options.kbRoot)
  const inserted = []
  const skipped = []
  if (raw.trim().length === 0) return { text: raw, inserted, skipped, root }
  const matches = matchCharacters(raw, entries)
  if (matches.length === 0) return { text: raw, inserted, skipped, root }
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.trunc(options.limit) : 4
  const lower = raw.toLowerCase()
  const anchors = []
  for (const hit of matches.slice(0, limit)) {
    const anchor = hit.entry.anchor
    const name = hit.entry.nameZh.length > 0 ? hit.entry.nameZh : hit.name
    if (lower.includes(anchor.toLowerCase())) { skipped.push({ name, reason: '提示词里已经有这条外貌串' }); continue }
    if (hit.entry.nameEn.length >= 3 && lower.includes(hit.entry.nameEn.toLowerCase())) {
      skipped.push({ name, reason: '提示词里已经有英文名，按已锚定处理' })
      continue
    }
    anchors.push(anchor)
    inserted.push({ name, id: hit.entry.id, anchor })
  }
  if (anchors.length === 0) return { text: raw, inserted, skipped, root }
  const lead = splitStyleLead(raw.trim())
  const glued = anchors.join('，')
  // 画风句自己带标点（。！？）时不要再补一个逗号，否则会出现「厚涂风格。，THE ...」。
  const sep = lead.style.length === 0 ? '' : (/[。！？，、；.!?]$/.test(lead.style) ? '' : '，')
  const body = lead.body.length > 0 ? lead.style + sep + glued + '，' + lead.body : lead.style + sep + glued
  return { text: body, inserted, skipped, root }
}

/** 给页面 / 调试看的摘要：目录、角色数、名字列表。 */
export function kbSummary(configured = null) {
  const root = kbRoot(configured)
  const entries = loadKb(configured)
  return {
    root,
    exists: entries.length > 0,
    count: entries.length,
    characters: entries.map((entry) => entry.nameZh),
  }
}

export default { anchorPrompt, kbRoot, kbSummary, loadKb, matchCharacters, parseCharacterFile, splitStyleLead }
