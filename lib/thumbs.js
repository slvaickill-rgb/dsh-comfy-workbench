/**
 * lib/thumbs.js — 图库缩略图：一次生成、磁盘缓存、两级后端。
 *
 * 为什么要有：原图 1～3 MB、1024×1216，一页 60 张 ≈ 65 MB 传输、300 MB 位图；
 * 网格里只显示 132 px。320 px 宽的 JPEG 约 20 KB，一页 1.2 MB。
 *
 * 后端按可用性降级：
 *   1. Electron nativeImage（宿主是 Electron 44，Skia 解码，一张约 20 ms）
 *   2. ComfyUI .venv 的 Python + Pillow（常驻子进程，一张约 100 ms，和 nsfw.js 同款模式）
 *   3. 都没有 → 调用方回退原图，功能不丢，只是慢
 *
 * 缓存：<profile>/.dsh-comfy/thumbs/<sha1>.jpg。
 * 键 = 根 + 相对路径 + 大小 + mtime + 宽度：图改过自动换键，旧键由 prune 清掉。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

import { stateDir } from './state.js'

/** 网格 minmax(132px)，2 倍屏 264，取 320 留一点余量。 */
export const THUMB_WIDTH = 320
const THUMB_QUALITY = 82
/** 缓存条数上限；一张约 20 KB，6000 张约 120 MB，再往上就太占盘。 */
const THUMB_MAX_FILES = 6000
/** 同时生成的张数：再高只会互相抢 IO，python 那一路本来就是串行。 */
const RENDER_CONCURRENCY = 3
const PY_TASK_TIMEOUT_MS = 30_000
const PY_IDLE_MS = 10 * 60 * 1000

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'thumb-worker.py')

export function thumbsDir() {
  return path.join(stateDir(), 'thumbs')
}

/**
 * 算缓存条目。
 * @param root - 图库根（绝对路径；两个根可能有同名相对路径，必须进键）。
 * @param rel - 相对根的路径（正斜杠）。
 * @param stat - 源文件 stat。
 * @param width - 目标宽度。
 * @returns `{ key, file }`。
 */
export function thumbEntry(root, rel, stat, width = THUMB_WIDTH) {
  const key = crypto
    .createHash('sha1')
    .update([root, rel, stat.size, Math.trunc(stat.mtimeMs), width].join('|'))
    .digest('hex')
    .slice(0, 24)
  return { key, file: path.join(thumbsDir(), key + '.jpg') }
}

// ---------------------------------------------------------------- 并发闸门

let active = 0
const queue = []

function acquire() {
  if (active < RENDER_CONCURRENCY) {
    active += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => queue.push(resolve))
}

function release() {
  const next = queue.shift()
  if (next !== undefined) next()
  else active -= 1
}

// ---------------------------------------------------------------- Electron 后端

let electronImage = null

/** 拿 nativeImage；宿主不是 Electron（命令行 dsh）时记 false，不再重试。 */
async function loadNativeImage() {
  if (electronImage !== null) return electronImage
  try {
    const mod = await import('electron')
    const candidate = mod?.nativeImage ?? mod?.default?.nativeImage ?? null
    electronImage = candidate !== null && typeof candidate.createFromPath === 'function' ? candidate : false
  } catch {
    electronImage = false
  }
  return electronImage
}

// ---------------------------------------------------------------- Python 后端

let worker = null
let workerPython = null
let workerError = ''
let sequence = 0
let idleTimer = null
const waiters = new Map()

function killWorker() {
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const child = worker
  worker = null
  workerPython = null
  for (const waiting of waiters.values()) {
    clearTimeout(waiting.timer)
    waiting.reject(new Error('缩略图进程已停止'))
  }
  waiters.clear()
  if (child !== null) {
    try { child.kill() } catch { /* 已经退了 */ }
  }
}

function scheduleIdleKill() {
  if (idleTimer !== null) clearTimeout(idleTimer)
  idleTimer = setTimeout(killWorker, PY_IDLE_MS)
  if (typeof idleTimer.unref === 'function') idleTimer.unref()
}

function handleLine(text) {
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    return
  }
  if (payload === null || typeof payload !== 'object') return
  const waiting = waiters.get(payload.id)
  if (waiting === undefined) return
  waiters.delete(payload.id)
  clearTimeout(waiting.timer)
  scheduleIdleKill()
  if (payload.ok === true) waiting.resolve()
  else waiting.reject(new Error(payload.error ?? '缩略图进程报错'))
}

function ensureWorker(python) {
  if (worker !== null && workerPython === python) return worker
  killWorker()
  workerError = ''
  const child = spawn(python, [WORKER], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  })
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let cut = buffer.indexOf('\n')
    while (cut >= 0) {
      const text = buffer.slice(0, cut).trim()
      buffer = buffer.slice(cut + 1)
      if (text.length > 0) handleLine(text)
      cut = buffer.indexOf('\n')
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    workerError = (workerError + chunk).slice(-1200)
  })
  child.on('error', (error) => {
    workerError = '缩略图进程起不来：' + error.message
    if (worker === child) worker = null
  })
  child.on('exit', () => {
    if (worker === child) {
      worker = null
      workerPython = null
    }
    for (const waiting of waiters.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error('缩略图进程退出了' + (workerError ? '：' + workerError.slice(-200) : '')))
    }
    waiters.clear()
  })
  worker = child
  workerPython = python
  scheduleIdleKill()
  return child
}

function pythonRender(python, src, dst, width) {
  return new Promise((resolve, reject) => {
    const child = ensureWorker(python)
    if (child === null || child.stdin.destroyed) {
      reject(new Error(workerError || '缩略图进程不可用'))
      return
    }
    const id = ++sequence
    const timer = setTimeout(() => {
      waiters.delete(id)
      reject(new Error('缩略图超时'))
    }, PY_TASK_TIMEOUT_MS)
    waiters.set(id, { resolve, reject, timer })
    try {
      child.stdin.write(JSON.stringify({ id, src, dst, w: width }) + '\n')
    } catch (error) {
      waiters.delete(id)
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

// ---------------------------------------------------------------- 生成

async function render(src, dst, width, python) {
  const image = await loadNativeImage()
  if (image !== false) {
    try {
      const loaded = image.createFromPath(src)
      if (!loaded.isEmpty()) {
        // resized 是 synchronous 的 Skia 缩放；320 px 一张约 20 ms。小图不放大。
        const size = loaded.getSize()
        const sized = size.width > width ? loaded.resize({ width, quality: 'good' }) : loaded
        const jpeg = sized.toJPEG(THUMB_QUALITY)
        if (jpeg !== null && jpeg.length > 0) {
          fs.writeFileSync(dst, jpeg)
          return true
        }
      }
    } catch {
      // 落到 python
    }
  }
  if (typeof python === 'string' && python.length > 0) {
    try {
      await pythonRender(python, src, dst, width)
      return fs.existsSync(dst)
    } catch {
      return false
    }
  }
  return false
}

/** 同一张图同时只生成一份。 */
const inflight = new Map()

let ticks = 0

async function prune() {
  const dir = thumbsDir()
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  if (names.length <= THUMB_MAX_FILES) return
  const rows = []
  for (const name of names) {
    try {
      rows.push({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs })
    } catch {
      // 刚被删掉的
    }
  }
  rows.sort((a, b) => a.mtime - b.mtime)
  for (const row of rows.slice(0, Math.floor(rows.length / 4))) {
    try { fs.unlinkSync(path.join(dir, row.name)) } catch { /* 并发删了 */ }
  }
}

/**
 * 确保缩略图存在。
 * @param args - `{ root, rel, abs, stat, width?, python? }`
 * @returns 生成成功返回 true；两级后端都不可用返回 false（调用方回退原图）。
 */
export function ensureThumb({ root, rel, abs, stat, width = THUMB_WIDTH, python = null }) {
  const entry = thumbEntry(root, rel, stat, width)
  try {
    if (fs.existsSync(entry.file)) return Promise.resolve(true)
  } catch {
    // 盘没了也往下走
  }
  const running = inflight.get(entry.key)
  if (running !== undefined) return running
  const job = (async () => {
    await acquire()
    try {
      if (fs.existsSync(entry.file)) return true
      try {
        fs.mkdirSync(path.dirname(entry.file), { recursive: true })
      } catch {
        return false
      }
      const ok = await render(abs, entry.file, width, python)
      if (ok) {
        ticks += 1
        if (ticks % 32 === 0) void prune()
      }
      return ok
    } finally {
      release()
      inflight.delete(entry.key)
    }
  })()
  inflight.set(entry.key, job)
  return job
}

/** 插件卸载时收掉子进程。 */
export function disposeThumbs() {
  killWorker()
}
