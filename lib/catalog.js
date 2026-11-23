/**
 * lib/catalog.js — 画风图库（MOSS-Image-Character-Catalog）的根目录解析与 release 信息。
 *
 * 只做三件事：认目录、给缺包时的下载信息、给内嵌官方应用的入口。
 * 不解析官方应用私有的 JS 数据格式，不复制它的提示词库，不自动下载任何东西。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 上游 release 事实（2026-11-22 12:00 从 GitHub API / README 取）。 */
export const RELEASE = Object.freeze({
  repo: 'ukr8b3g-cmyk/MOSS-Image-Character-Catalog',
  tag: 'v0.1.2',
  title: 'v0.1.2 — 34,709 samples (Classic Cartoon update)',
  releasedAt: '2026-10-22',
  updatedAt: '2026-11-10',
  characters: 34_395,
  styles: 314,
  images: 34_709,
  bytes: 2_088_706_015,
  sizeText: '1.95 GiB',
  uncompressedText: '约 2.86 GB',
  sha256: '770746780a507fb2ae561b52a5370f6003a5e71587ca4a8a205451bc092def31',
  zipName: 'MOSS-Image-Character-Catalog-v0.1.2.zip',
  zipUrl: 'https://github.com/ukr8b3g-cmyk/MOSS-Image-Character-Catalog/releases/download/v0.1.2/MOSS-Image-Character-Catalog-v0.1.2.zip',
  notice: '样本未筛选（uncurated），目录名只当参考，不代表画风准确。仅本机参考，不二次发布。',
})

/** 首选根目录：用户 12:16 指定。 */
export const PRIMARY_ROOT = 'C:\\Moss本地画风库'

/** 自动探测列表，首位是首选根。 */
export const CANDIDATES = Object.freeze([
  PRIMARY_ROOT,
  'C:\\Moss图库',
  'C:\\MOSS-Image-Character-Catalog',
  'D:\\Moss本地画风库',
  path.join(os.homedir(), 'Moss本地画风库'),
])

/** 认「像图库」的文件与目录名。 */
const APP_FILES = ['index.html', 'catalog.json', 'style-categories.json', 'SHA256SUMS.txt']
const CONTENT_DIRS = ['images', 'characters', 'styles', 'data', 'app', 'workflows']
const IMAGE_PROBE_EXT = ['.webp', '.png', '.jpg']

function statOf(target) {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

function listNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 判断一个目录像不像解压后的图库。
 * 任一命中即可：有 index.html 之类清单文件 / 有内容子目录 / 顶层就躺着 webp。
 * @param dir - 待判目录。
 */
export function validateCatalogRoot(dir) {
  const stat = statOf(dir)
  if (stat === null) return { exists: false, valid: false, kind: 'missing', hasApp: false, markers: [] }
  if (!stat.isDirectory()) return { exists: true, valid: false, kind: 'file', hasApp: false, markers: [] }

  const entries = listNames(dir)
  const names = new Set(entries.map((entry) => entry.name))
  const markers = []

  for (const file of APP_FILES) {
    if (names.has(file)) markers.push(file)
  }
  const dirs = CONTENT_DIRS.filter((name) => names.has(name))
  markers.push(...dirs)

  let looseImage = null
  if (dirs.length === 0) {
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (IMAGE_PROBE_EXT.includes(path.extname(entry.name).toLowerCase())) {
        looseImage = entry.name
        break
      }
    }
    if (looseImage !== null) markers.push(looseImage)
  }

  const hasApp = names.has('index.html')
  const kind = hasApp ? 'app' : (markers.length > 0 ? 'images' : 'unknown')
  return { exists: true, valid: markers.length > 0, kind, hasApp, markers }
}

/**
 * 认目录时向下一层：ZIP 常自带宽一层同名目录。
 * @param dir - 候选目录。
 * @returns `{ root, valid, kind, hasApp, markers, descended }`
 */
export function probeRoot(dir) {
  const own = validateCatalogRoot(dir)
  if (own.valid || !own.exists || own.kind !== 'unknown') {
    return { root: dir, descended: false, ...own }
  }
  const entries = listNames(dir).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  if (entries.length !== 1) return { root: dir, descended: false, ...own }
  const child = path.join(dir, entries[0].name)
  const nested = validateCatalogRoot(child)
  if (!nested.valid) return { root: dir, descended: false, ...own }
  return { root: child, descended: true, ...nested }
}

/**
 * 解析画风图库根：配置优先，其次自动探测。
 * @param state - 插件配置（读 `catalogRoot`）。
 * @returns `{ root, source:'config'|'auto'|'none', valid, candidates }`
 */
export function resolveCatalogRoot(state) {
  const configured = typeof state?.catalogRoot === 'string' && state.catalogRoot.trim().length > 0
    ? state.catalogRoot.trim()
    : null
  if (configured !== null) {
    const probed = probeRoot(configured)
    if (probed.exists) {
      return { root: probed.valid ? probed.root : configured, source: 'config', valid: probed.valid, probed, candidates: [...CANDIDATES] }
    }
  }
  for (const candidate of CANDIDATES) {
    const probed = probeRoot(candidate)
    if (probed.valid) {
      return { root: probed.root, source: 'auto', valid: true, probed, candidates: [...CANDIDATES] }
    }
  }
  return { root: null, source: 'none', valid: false, probed: null, candidates: [...CANDIDATES] }
}

/** 缺包时给页面用的 release 说明。 */
export function catalogInfo() {
  return {
    release: { ...RELEASE },
    primary: PRIMARY_ROOT,
    candidates: [...CANDIDATES],
    note: '本机没找到解压后的画风图库。下载完整 ZIP、解压到新文件夹，再点「绑定本地目录」。',
    steps: [
      'curl.exe -L -C - --retry 5 -o "' + PRIMARY_ROOT + '\\' + RELEASE.zipName + '" "' + RELEASE.zipUrl + '"',
      '校验字节数 ' + RELEASE.bytes + ' 与 SHA256 ' + RELEASE.sha256,
      '解压到 ' + PRIMARY_ROOT + '（2 GB 建议 7-Zip）',
      '回来点「绑定本地目录」，指向含 index.html / images / data 的那一层',
    ],
  }
}

/**
 * 官方本地应用的入口（有 index.html 才有）。
 * @param root - 已验证的根目录。
 * @returns `{ path, url }` 或 `null`。
 */
export function catalogAppEntry(root) {
  if (typeof root !== 'string' || root.length === 0) return null
  const entry = path.join(root, 'index.html')
  if (!fs.existsSync(entry)) return null
  return { path: entry, url: '/dsh-comfy/catalog/app/index.html' }
}

/** 绑定目录时的检查：不存在 → 404；是文件 → 422；存在但空 → 允许，标记未就绪。 */
export function inspectBindTarget(target) {
  const stat = statOf(target)
  if (stat === null) {
    const error = new Error('目录不存在：' + target)
    error.code = 'catalog-root-missing'
    throw error
  }
  if (!stat.isDirectory()) {
    const error = new Error('这不是目录：' + target)
    error.code = 'catalog-root-invalid'
    throw error
  }
  const probed = probeRoot(target)
  const empty = listNames(target).length === 0
  if (!probed.valid && !empty) {
    const error = new Error('这个目录里没看到图库文件（index.html / images / data / *.webp 都没有）：' + target)
    error.code = 'catalog-root-invalid'
    throw error
  }
  return {
    root: probed.valid ? probed.root : target,
    valid: probed.valid,
    empty,
    descended: probed.descended === true,
    unique: [...new Set(probed.markers ?? [])].slice(0, 8),
  }
}
