/**
 * lib/triggers.js — LoRA 文件名 → 触发词 的本地映射。
 *
 * 触发词只有 Civitai 那边有（trainedWords），本地文件不带。下载时顺手把它们记下来，
 * 之后工台的 LoRA 面板要显示 / 复制，大模型改写也要知道「这段 LoRA 要哪些触发词」。
 *
 * 文件：<profile>/.dsh-comfy/lora-triggers.json，原子写（临时文件 + rename）。
 */

import fs from 'node:fs'
import path from 'node:path'

import { stateDir } from './state.js'

const FILE = 'lora-triggers.json'
const MAX_ENTRIES = 2000
const MAX_WORDS = 24

export function triggersFile() {
  return path.join(stateDir(), FILE)
}

/** 读映射；坏文件当作空，不让页面白屏。键是小写文件名。 */
export function readTriggers() {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(triggersFile(), 'utf8'))
  } catch {
    return {}
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const words = Array.isArray(value.words)
      ? value.words.filter((word) => typeof word === 'string' && word.trim().length > 0).map((word) => word.trim()).slice(0, MAX_WORDS)
      : []
    if (words.length === 0) continue
    out[String(key).toLowerCase()] = {
      words,
      name: typeof value.name === 'string' ? value.name.slice(0, 200) : '',
      updatedAt: Number(value.updatedAt) || 0,
    }
  }
  return out
}

/**
 * 合并写入：同一个文件名只加新词，不删旧的。
 * @param entries - `[{ name, words }]`
 * @returns `{ changed, count, items }`；写盘失败不算致命，返回内存里的结果。
 */
export function mergeTriggers(entries) {
  const current = readTriggers()
  let changed = 0
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
    if (name.length === 0) continue
    const incoming = Array.isArray(entry.words)
      ? entry.words.filter((word) => typeof word === 'string' && word.trim().length > 0).map((word) => word.trim()).slice(0, MAX_WORDS)
      : []
    if (incoming.length === 0) continue
    const key = name.toLowerCase()
    const before = current[key]?.words ?? []
    const merged = [...before]
    for (const word of incoming) if (!merged.includes(word)) merged.push(word)
    current[key] = { words: merged.slice(0, MAX_WORDS), name, updatedAt: Date.now() }
    if (JSON.stringify(before) !== JSON.stringify(current[key].words)) changed += 1
  }
  const keys = Object.keys(current)
  if (keys.length > MAX_ENTRIES) {
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete current[key]
  }
  try {
    fs.mkdirSync(stateDir(), { recursive: true })
    const target = triggersFile()
    const temp = target + '.tmp-' + String(process.pid)
    fs.writeFileSync(temp, JSON.stringify(current, null, 2) + '\n', 'utf8')
    fs.renameSync(temp, target)
  } catch {
    /* 写不了也把内存结果给出去，页面本次能用 */
  }
  return { changed, count: Object.keys(current).length, items: current }
}
