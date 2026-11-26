/**
 * lib/localCatalog.js — 本机模型文件 → Civitai 元数据（封面 / 模型名 / 触发词）的缓存。
 *
 * 只为了「已下载」视图能把本地文件画成带封面的卡片；按文件名去 Civitai 查一次就记账，
 * 过期（7 天）或没查到的留空，页面照常显示占位封面。
 * 文件：<profile>/.dsh-comfy/local-catalog.json，原子写。
 */

import fs from 'node:fs'
import path from 'node:path'

import { stateDir } from './state.js'

const FILE = 'local-catalog.json'
const MAX_ENTRIES = 4000
export const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function catalogFile() {
  return path.join(stateDir(), FILE)
}

/** 读缓存：小写文件名 → { modelId, modelName, typeLabel, versionId, versionName, baseModel, cover, words, at }。 */
export function readCatalog() {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(catalogFile(), 'utf8'))
  } catch {
    return {}
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    out[String(key).toLowerCase()] = {
      modelId: Number(value.modelId) || 0,
      modelName: typeof value.modelName === 'string' ? value.modelName.slice(0, 200) : '',
      typeLabel: typeof value.typeLabel === 'string' ? value.typeLabel.slice(0, 40) : '',
      versionId: Number(value.versionId) || 0,
      versionName: typeof value.versionName === 'string' ? value.versionName.slice(0, 120) : '',
      baseModel: typeof value.baseModel === 'string' ? value.baseModel.slice(0, 80) : null,
      cover: typeof value.cover === 'string' ? value.cover.slice(0, 600) : null,
      words: Array.isArray(value.words) ? value.words.filter((word) => typeof word === 'string').slice(0, 24) : [],
      at: Number(value.at) || 0,
    }
  }
  return out
}

/** 合并写入（同键覆盖）。 */
export function mergeCatalog(entries) {
  const current = readCatalog()
  let changed = 0
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = String(entry?.name ?? '').trim().toLowerCase()
    if (key.length === 0) continue
    const next = {
      modelId: Number(entry.modelId) || 0,
      modelName: typeof entry.modelName === 'string' ? entry.modelName.slice(0, 200) : '',
      typeLabel: typeof entry.typeLabel === 'string' ? entry.typeLabel.slice(0, 40) : '',
      versionId: Number(entry.versionId) || 0,
      versionName: typeof entry.versionName === 'string' ? entry.versionName.slice(0, 120) : '',
      baseModel: typeof entry.baseModel === 'string' ? entry.baseModel.slice(0, 80) : null,
      cover: typeof entry.cover === 'string' ? entry.cover.slice(0, 600) : null,
      words: Array.isArray(entry.words) ? entry.words.filter((word) => typeof word === 'string').slice(0, 24) : [],
      at: Date.now(),
    }
    const before = current[key]
    if (before !== undefined && String(before.cover) === String(next.cover) && String(before.modelName) === String(next.modelName)) continue
    current[key] = next
    changed += 1
  }
  const keys = Object.keys(current)
  if (keys.length > MAX_ENTRIES) {
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete current[key]
  }
  try {
    fs.mkdirSync(stateDir(), { recursive: true })
    const target = catalogFile()
    const temp = target + '.tmp-' + String(process.pid)
    fs.writeFileSync(temp, JSON.stringify(current, null, 2) + '\n', 'utf8')
    fs.renameSync(temp, target)
  } catch {
    /* 写不了也给内存结果 */
  }
  return { changed, items: current }
}
