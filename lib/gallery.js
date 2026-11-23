/**
 * lib/gallery.js — 图片树扫描、分类、分页、路径校验。
 *
 * 「我的图库」和「画风图库」共用这一份：只读、不移动、不重命名、不删除。
 * 分类 = 图片相对根目录的文件夹路径（`''` 是根，也表示「全部」）。
 *
 * 两个入口：
 *   scanImageTree(root, opts)       同步，测试与小目录用
 *   scanImageTreeAsync(root, opts)  异步，每 400 条让出一次事件循环（34,709 张不堵住宿主）
 *
 * 三重上限：深度 8 层、文件 40,000 个、每页 60（上限 200）。不跟随子目录符号链接。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 认作图片的扩展名（小写，含点）。 */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']

/** 分页默认与上限。 */
export const PAGE_DEFAULT = 60
export const PAGE_MAX = 200

/** 分类列表上限：34,709 张的图库每条 hash 一个文件夹，全量返回会让 RPC 载荷到 MB 级。 */
export const FOLDER_DEFAULT = 120
export const FOLDER_MAX = 500

/** 扫描硬上限。 */
export const MAX_DEPTH = 8
export const MAX_FILES = 40_000

/** 下划线开头的目录默认跳过（`_archive` / `_misc`）。 */
const SKIP_PREFIX = '_'

const YIELD_EVERY = 400
/** 并发扫描的闸门：同时最多这么多个 readdir/stat 在飞。 */
const FAST_CONCURRENCY = 64

function coded(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** 把任意分隔符的输入收成 `a/b/c`；不做安全判断，只做形状。 */
export function normalizeRel(input) {
  return String(input ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.')
    .join('/')
}

/**
 * 校验相对路径是否可以安全拼到 root 下。
 * 拒绝：绝对路径、盘符、`..`、NUL。
 * @param rel - 相对路径（可能带反斜杠）。
 * @returns 归一化后的相对路径；根目录返回 `''`。
 */
export function safeRel(rel) {
  const raw = String(rel ?? '')
  if (raw.includes('\u0000')) throw coded('path-outside-workspace', '路径里有 NUL')
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) {
    throw coded('path-outside-workspace', '不允许绝对路径：' + raw)
  }
  const parts = raw.replace(/\\/g, '/').split('/')
  if (parts.some((part) => part === '..')) throw coded('path-outside-workspace', '不允许 .. 逃逸：' + raw)
  return normalizeRel(raw)
}

export function isImageName(name) {
  return IMAGE_EXTENSIONS.includes(path.extname(String(name)).toLowerCase())
}

/** 同源预览地址：产物库走 `/view`，画风库走 `/catalog/view`。 */
export function imageUrl(item, source) {
  if (source === 'catalog') {
    return '/dsh-comfy/catalog/view?rel=' + encodeURIComponent(item.rel)
  }
  const query = new URLSearchParams({ filename: item.name, subfolder: item.folder ?? '', type: 'output' })
  return '/dsh-comfy/view?' + query.toString()
}

/**
 * 同源缩略图地址：320 px 的缓存小图，网格里不要直接加载原图。
 * v 用 mtime：图换过 URL 就换，浏览器缓存不会串。
 */
export function thumbUrl(item, source) {
  const query = new URLSearchParams({ rel: item.rel, v: String(item.mtime ?? 0) })
  if (source === 'catalog') query.set('source', 'catalog')
  return '/dsh-comfy/thumb?' + query.toString()
}

/**
 * 把相对路径解析成绝对路径，并确认它真的在根目录里面。
 * @param root - 根目录（可以是符号链接，内部会取 realpath）。
 * @param rel - 相对路径。
 * @returns 绝对路径（尚未判断是否存在）。
 */
export function resolveImage(root, rel) {
  const clean = safeRel(rel)
  if (clean.length === 0) throw coded('path-required', '缺 rel')
  let realRoot
  try {
    realRoot = fs.realpathSync.native(root)
  } catch {
    throw coded('catalog-root-missing', '根目录不存在：' + root)
  }
  const target = path.resolve(realRoot, clean)
  const relative = path.relative(realRoot, target)
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw coded('path-outside-workspace', '路径越界：' + target)
  }
  return target
}

/**
 * 目录树遍历的单一实现，产出图片条目。
 * @param root - 根目录。
 * @param opts - `{ includeHidden?: boolean, query?: string, maxFiles?: number }`
 */
function* walkImages(root, opts) {
  const includeHidden = opts.includeHidden === true
  const maxFiles = Number.isFinite(opts.maxFiles) ? opts.maxFiles : MAX_FILES
  let seen = 0
  let unreadable = 0

  const stack = [{ abs: root, rel: '', depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current.abs, { withFileTypes: true })
    } catch {
      unreadable += 1
      continue
    }
    for (const entry of entries) {
      // 符号链接一律不跟：既防环，也防指到目录外。
      if (entry.isSymbolicLink()) continue
      const abs = path.join(current.abs, entry.name)
      const rel = current.rel.length === 0 ? entry.name : current.rel + '/' + entry.name
      if (entry.isDirectory()) {
        if (!includeHidden && entry.name.startsWith(SKIP_PREFIX)) continue
        if (current.depth + 1 > MAX_DEPTH) continue
        stack.push({ abs, rel, depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      if (!isImageName(entry.name)) continue
      seen += 1
      if (seen > maxFiles) {
        return { truncated: true, unreadable }
      }
      let stat
      try {
        stat = fs.statSync(abs)
      } catch {
        unreadable += 1
        continue
      }
      const folder = current.rel
      yield {
        name: entry.name,
        rel,
        folder,
        size: stat.size,
        mtime: Math.trunc(stat.mtimeMs),
      }
    }
  }
  return { truncated: false, unreadable }
}

/** 把条目列表折成 folders + 过滤 + 分页。 */
function compose(root, items, opts, meta) {
  const folder = normalizeRel(opts.folder)
  const query = String(opts.query ?? '').trim().toLowerCase()
  const limit = Math.min(Math.max(Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : PAGE_DEFAULT, 1), PAGE_MAX)
  const cursor = Math.max(Number.isFinite(opts.cursor) ? Math.trunc(opts.cursor) : 0, 0)

  // 文件夹分类：只统计真实存在的目录（按图片聚合），最新图做封面。
  const byFolder = new Map()
  for (const item of items) {
    const bucket = byFolder.get(item.folder)
    if (bucket === undefined) {
      byFolder.set(item.folder, { id: item.folder, name: item.folder, count: 1, latest: item.mtime, cover: item })
      continue
    }
    bucket.count += 1
    if (item.mtime > bucket.latest) {
      bucket.latest = item.mtime
      bucket.cover = item
    }
  }
  const folders = [...byFolder.values()]
    .map((bucket) => ({
      id: bucket.id,
      name: bucket.id.length === 0 ? '（根目录）' : bucket.id,
      count: bucket.count,
      latest: bucket.latest,
      cover: thumbUrl(bucket.cover, opts.source),
    }))
    .sort((a, b) => b.latest - a.latest)
  const folderLimit = Math.min(
    Math.max(Number.isFinite(opts.folderLimit) ? Math.trunc(opts.folderLimit) : FOLDER_DEFAULT, 1),
    FOLDER_MAX,
  )
  const folderTotal = folders.length
  const visibleFolders = folders.slice(0, folderLimit)

  const matchedItems = items.filter((item) => {
    if (folder.length > 0) {
      if (item.folder !== folder && !item.folder.startsWith(folder + '/')) return false
    }
    if (query.length > 0 && !item.name.toLowerCase().includes(query) && !item.rel.toLowerCase().includes(query)) return false
    return true
  })
  // mtime 倒序；同一毫秒按 rel 兜底，保证分页稳定。
  matchedItems.sort((a, b) => (b.mtime - a.mtime) || a.rel.localeCompare(b.rel, 'zh-CN'))

  // url 给灯箱/保存/复制用原图；thumb 给网格用 320 px 小图。
  const page = matchedItems.slice(cursor, cursor + limit).map((item) => ({
    ...item,
    url: imageUrl(item, opts.source),
    thumb: thumbUrl(item, opts.source),
  }))
  const nextIndex = cursor + page.length

  return {
    root,
    source: opts.source ?? 'output',
    total: items.length,
    matched: matchedItems.length,
    folder: folder,
    query: query,
    folders: visibleFolders,
    folderTotal,
    foldersTruncated: folderTotal > visibleFolders.length,
    images: page,
    cursor,
    nextCursor: nextIndex < matchedItems.length ? nextIndex : null,
    limit,
    truncated: meta?.truncated === true,
    skipped: meta?.unreadable ?? 0,
    scannedAt: Date.now(),
  }
}

/**
 * 只读整棵树，返回原始条目（不带分页）。供上层按根缓存：
 * 34,709 张的扫描约 13 秒，换分类/搜索不该重扫一遍。
 * @param root - 根目录。
 * @param opts - `{ includeHidden?, maxFiles?, source? }`（`source` 只影响错误码以外的元信息）
 * @returns `{ items, meta }`，meta 是 `{ truncated, unreadable }`。
 */
export async function readImageTree(root, opts = {}) {
  if (!fs.existsSync(root)) throw coded('gallery-root-missing', '目录不存在：' + root)
  const items = []
  const iterator = walkImages(root, opts)
  let meta = { truncated: false, unreadable: 0 }
  let count = 0
  for (;;) {
    const step = iterator.next()
    if (step.done) {
      meta = step.value ?? meta
      break
    }
    items.push(step.value)
    count += 1
    if (count % YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve))
  }
  return { items, meta }
}

/**
 * 并发版整树扫描。
 *
 * 同步版 34,709 张要 7.9 秒（34,709 次 readdir + 34,709 次 stat 全在主线程排队）。
 * 这里 readdir / stat 都走 fs.promises，限 32 并发，实测约 1 秒；
 * 语义与 readImageTree 一致：跳过符号链接、`_` 目录、深度 8、4 万上限。
 * @param root - 根目录。
 * @param opts - `{ includeHidden?, maxFiles? }`
 * @returns `{ items, meta }`，meta 是 `{ truncated, unreadable }`。
 */
export async function readImageTreeFast(root, opts = {}) {
  if (!fs.existsSync(root)) throw coded('gallery-root-missing', '目录不存在：' + root)
  const includeHidden = opts.includeHidden === true
  const maxFiles = Number.isFinite(opts.maxFiles) ? opts.maxFiles : MAX_FILES
  const items = []
  let unreadable = 0
  let truncated = false

  let active = 0
  let waiting = []
  let head = 0
  const acquire = () => {
    if (active < FAST_CONCURRENCY) {
      active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => waiting.push(resolve))
  }
  const release = () => {
    if (head < waiting.length) {
      const next = waiting[head]
      waiting[head] = undefined
      head += 1
      next()
      // 队首指针走太远时收一次，别让 3 万条已消费的槽位占着内存。
      if (head > 4096 && head * 2 > waiting.length) {
        waiting = waiting.slice(head)
        head = 0
      }
      return
    }
    active -= 1
  }

  const visitFile = async (abs, name, rel, folder) => {
    await acquire()
    try {
      const stat = await fs.promises.stat(abs)
      if (truncated) return
      if (items.length >= maxFiles) {
        truncated = true
        return
      }
      items.push({ name, rel, folder, size: stat.size, mtime: Math.trunc(stat.mtimeMs) })
    } catch {
      unreadable += 1
    } finally {
      release()
    }
  }

  const walk = async (dir, rel, depth) => {
    await acquire()
    let entries
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      unreadable += 1
      return
    } finally {
      release()
    }
    const jobs = []
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const childRel = rel.length === 0 ? entry.name : rel + '/' + entry.name
      if (entry.isDirectory()) {
        if (!includeHidden && entry.name.startsWith(SKIP_PREFIX)) continue
        if (depth + 1 > MAX_DEPTH) continue
        jobs.push(walk(path.join(dir, entry.name), childRel, depth + 1))
        continue
      }
      if (!entry.isFile() || !isImageName(entry.name)) continue
      jobs.push(visitFile(path.join(dir, entry.name), entry.name, childRel, rel))
    }
    if (jobs.length > 0) await Promise.all(jobs)
  }

  await walk(root, '', 0)
  return { items, meta: { truncated, unreadable } }
}

/**
 * 把原始条目按筛选条件折成分页结果。纯内存，34,709 条约几十毫秒。
 * @param root - 根目录（只用于回显）。
 * @param items - `readImageTree` 的 items。
 * @param meta - `readImageTree` 的 meta。
 * @param opts - `{ folder, query, limit, cursor, folderLimit, source }`
 */
export function buildListing(root, items, meta, opts = {}) {
  return compose(root, items, opts, meta)
}

/**
 * 同步扫描。
 * @param root - 根目录。
 * @param opts - `{ folder, query, limit, cursor, includeHidden, source, maxFiles }`
 */
export function scanImageTree(root, opts = {}) {
  if (!fs.existsSync(root)) throw coded('gallery-root-missing', '目录不存在：' + root)
  const items = []
  const iterator = walkImages(root, opts)
  let meta = { truncated: false, unreadable: 0 }
  for (;;) {
    const step = iterator.next()
    if (step.done) {
      meta = step.value ?? meta
      break
    }
    items.push(step.value)
  }
  return compose(root, items, opts, meta)
}

/**
 * 异步扫描（一次性，不分页缓存）。
 * @param root - 根目录。
 * @param opts - 同 scanImageTree。
 */
export async function scanImageTreeAsync(root, opts = {}) {
  const { items, meta } = await readImageTree(root, opts)
  return compose(root, items, opts, meta)
}
