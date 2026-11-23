/**
 * lib/catalogIndex.js — 读画风库自带的清单 `user_catalog.json`，抽出 314 个画风与 8 个分类。
 *
 * 为什么需要它：官方 release 把每张样本放在 `app/outputs/user_items/<hash>/` 下，
 * 文件名恒为 `original.webp`。只扫文件系统只能看到一堆 hash 目录和同名文件，
 * 图表里没有「画风」这个概念；画风名、分类、提示词都只写在 98 MB 的清单里。
 *
 * 只做只读投影：解析一次清单，折成紧凑索引（几百 KB 到几 MB），
 * 按清单的 mtime + size 缓存到状态目录，release 换了才重建。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { stateDir } from './state.js'

/** 索引结构版本；字段形状变了就加一，旧缓存自动作废。 */
const INDEX_VERSION = 1

/** 清单在 release 里的位置（不同版本放过两层）。 */
function manifestCandidates(root) {
  return [
    path.join(root, 'app', 'outputs', 'user_catalog.json'),
    path.join(root, 'outputs', 'user_catalog.json'),
    path.join(root, 'user_catalog.json'),
  ]
}

/** 8 分类映射列表。 */
function categoryCandidates(root) {
  return [
    path.join(root, 'docs', 'style-categories.json'),
    path.join(root, 'app', 'docs', 'style-categories.json'),
    path.join(root, 'style-categories.json'),
  ]
}

function firstExisting(list) {
  for (const candidate of list) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function statOrNull(file) {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

/** 内存缓存：根 → { stamp, index }。只留最近一个根，画风库通常只有一个。 */
let memory = null

function cacheFile(root) {
  const digest = crypto.createHash('sha1').update(root).digest('hex').slice(0, 12)
  return path.join(stateDir(), 'catalog-index-' + digest + '.json')
}

function readCache(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed?.version !== INDEX_VERSION) return null
    return parsed
  } catch {
    return null
  }
}

function writeCache(file, payload) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = file + '.tmp-' + process.pid
    fs.writeFileSync(temp, JSON.stringify(payload), 'utf8')
    fs.renameSync(temp, file)
  } catch {
    /* 缓存写不进去不影响功能，下次重建而已。 */
  }
}

/**
 * 解析清单，折成索引。
 * @param root - 已验证的画风库根。
 * @param prefix - 清单所在目录相对根的路径前缀（`app/outputs/`）。
 */
/** 上游 8 个画风大类的中文名（`docs/style-categories.json` 的 id → 中文）。 */
const CATEGORY_ZH = {
  anime: '动画与漫画',
  western: '欧美动画与漫画',
  drawing: '手绘与版画',
  digital: '3D／数字／摄影',
  craft: '工艺／雕塑／民间',
  traditional: '世界各国传统美术',
  contemporary: '当代／波普／街头／超现实',
  painting: '古典与现代绘画',
}

function buildIndex(root, manifest, prefix) {
  const data = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  const items = Array.isArray(data?.items) ? data.items : []

  const labels = new Map()
  const assignments = new Map()
  const catsFile = firstExisting(categoryCandidates(root))
  if (catsFile !== null) {
    try {
      const doc = JSON.parse(fs.readFileSync(catsFile, 'utf8'))
      for (const category of doc?.categories ?? []) {
        // 上游只给 en / ja：界面按中文习惯列一份，认不出的 id 仍用 en 兜底。
        const id = String(category.id)
        labels.set(id, CATEGORY_ZH[id] ?? String(category.en ?? category.ja ?? id))
      }
      for (const [key, id] of Object.entries(doc?.assignments ?? {})) assignments.set(key, String(id))
    } catch {
      /* 分类文件坏了就只丢分类，画风清单照出。 */
    }
  }

  const byRel = Object.create(null)
  const styles = []
  const counts = new Map()
  let characters = 0
  for (const item of items) {
    const image = item?.files?.image
    if (typeof image !== 'string' || image.length === 0) continue
    const rel = prefix + image.split('\\').join('/')
    const name = String(item.name ?? '')
    if (item.kind === 'style') {
      const categoryId = assignments.get('user/' + String(item.id ?? '')) ?? null
      const label = categoryId === null ? null : (labels.get(categoryId) ?? categoryId)
      if (categoryId !== null) counts.set(categoryId, (counts.get(categoryId) ?? 0) + 1)
      const tags = String(item.copy_tags ?? '')
      const prompt = String(item.copy_prompt ?? item.generation_prompt ?? '')
      byRel[rel] = { k: 'style', n: name, c: label, t: tags, p: prompt }
      styles.push({ rel, name, category: label })
    } else {
      characters += 1
      byRel[rel] = { k: 'character', n: name }
    }
  }

  const categories = [...labels.entries()]
    .map(([id, label]) => ({ id, label, count: counts.get(id) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'))

  return {
    available: true,
    manifest,
    categoriesFile: catsFile,
    counts: { style: styles.length, character: characters, all: styles.length + characters },
    categories,
    styles,
    items: byRel,
  }
}

/**
 * 取索引：内存 → 磁盘缓存 → 重建。
 * @param root - 已验证的画风库根。
 * @returns 索引对象；清单缺失时 `{ available:false, reason }`，不抛。
 */
export function loadIndex(root) {
  try {
    return loadIndexInner(root)
  } catch (error) {
    return { available: false, reason: '读清单失败：' + (error instanceof Error ? error.message : String(error)) }
  }
}

function loadIndexInner(root) {
  const manifest = firstExisting(manifestCandidates(root))
  if (manifest === null) {
    return { available: false, reason: '这个目录里没有 user_catalog.json：要么是旧版 release，要么只解压了一半。' }
  }
  const stat = statOrNull(manifest)
  if (stat === null) return { available: false, reason: '清单读不到：' + manifest }
  const catsFile = firstExisting(categoryCandidates(root))
  const catsStat = catsFile === null ? null : statOrNull(catsFile)
  const stamp = [manifest, stat.mtimeMs, stat.size, catsFile ?? '', catsStat?.mtimeMs ?? 0, INDEX_VERSION].join('|')

  if (memory !== null && memory.root === root && memory.stamp === stamp) return memory.index

  const file = cacheFile(root)
  const cached = readCache(file)
  if (cached !== null && cached.stamp === stamp && cached.root === root) {
    memory = { root, stamp, index: cached.index }
    return cached.index
  }

  const prefix = (() => {
    const rel = path.relative(root, path.dirname(manifest)).split(path.sep).join('/')
    return rel.length === 0 ? '' : rel + '/'
  })()
  const index = buildIndex(root, manifest, prefix)
  memory = { root, stamp, index }
  writeCache(file, { version: INDEX_VERSION, root, stamp, builtAt: Date.now(), index })
  return index
}

/** 只给测试和诊断用：把内存缓存扔掉。 */
export function resetIndexCache() {
  memory = null
}
