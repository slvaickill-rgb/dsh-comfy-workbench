/**
 * lib/nsfw.js — 我的图库的 NSFW 判定。
 *
 * 复用 ComfyUI 里已经装好的 WD14 打标器（ComfyUI-WD14-Tagger 那份 onnx + 同名 csv），
 * 读它自带的四个 rating 标签：general / sensitive / questionable / explicit。
 * 阈值在宿主算，打标器只报分数。
 *
 * 为什么不用宿主自带的 python：那套没有 onnxruntime；ComfyUI 的 .venv 有。
 * 找不到解释器或模型就明说不可用，不拿文件名瞎猜。
 *
 * 打标器是常驻子进程：加载一次（约 1.2 GB、4 秒），之后每张约 3 秒（CPU）。
 * 结果按 rel + 大小 + mtime 缓存在 <profile>/.dsh-comfy/nsfw.json，图改过就自动重扫。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { stateDir } from './state.js'

/** 判定阈值：explicit 或 questionable 有一项过线就算 NSFW。 */
export const THRESHOLD = { explicit: 0.4, questionable: 0.55 }

const INDEX_VERSION = 1
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'nsfw-tagger.py')
/** WD14 模型可能在自定义节点里，也可能挂到 models/wd14_tagger。 */
const MODEL_DIRS = ['custom_nodes/ComfyUI-WD14-Tagger/models', 'models/wd14_tagger']
/** 解释器按可用性排序：ComfyUI 的 .venv 有 onnxruntime。 */
const PYTHON_RELS = [
  '.venv/Scripts/python.exe',
  'python_embeded/python.exe',
  '../standalone-env/python.exe',
  '../.venv/Scripts/python.exe',
]
const READY_TIMEOUT_MS = 120_000
const TAG_TIMEOUT_MS = 120_000
const IDLE_KILL_MS = 10 * 60 * 1000

// ---------------------------------------------------------------- 打标器进程

let worker = null
let workerKey = null
let workerReady = null
let workerError = ''
let idleTimer = null
let sequence = 0
const waiters = new Map()

function killWorker() {
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const child = worker
  worker = null
  workerKey = null
  workerReady = null
  for (const waiting of waiters.values()) {
    clearTimeout(waiting.timer)
    waiting.reject(new Error('打标器已停止'))
  }
  waiters.clear()
  if (child !== null) {
    try { child.kill() } catch { /* 已经退了 */ }
  }
}

function scheduleIdleKill() {
  if (idleTimer !== null) clearTimeout(idleTimer)
  idleTimer = setTimeout(killWorker, IDLE_KILL_MS)
  if (typeof idleTimer.unref === 'function') idleTimer.unref()
}

/** 一行输出分发：READY 交还给启动流程，其余按 id 还给调用方。 */
function handleLine(text) {
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    return
  }
  if (payload === null || typeof payload !== 'object') return
  if (payload.ready === true) {
    if (workerReady !== null) workerReady(payload)
    return
  }
  const waiting = waiters.get(payload.id)
  if (waiting === undefined) return
  waiters.delete(payload.id)
  clearTimeout(waiting.timer)
  scheduleIdleKill()
  if (payload.ok === true) waiting.resolve(payload.rating ?? {})
  else waiting.reject(new Error(payload.error ?? '打标器报错'))
}

function startWorker(info) {
  const key = info.python + '|' + info.model
  if (worker !== null && workerKey === key) return Promise.resolve()
  killWorker()
  workerError = ''
  return new Promise((resolve, reject) => {
    let settled = false
    let buffer = ''
    const child = spawn(info.python, [info.script, info.model, info.csv], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // 中文路径必须走 utf-8，不然 Windows 上会退成 GBK 乱码。
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    const fail = (message) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killWorker()
      reject(new Error(message))
    }
    const timer = setTimeout(() => fail('打标器 ' + String(Math.round(READY_TIMEOUT_MS / 1000)) + ' 秒还没加载完' + (workerError ? '：' + workerError.slice(-200) : '')), READY_TIMEOUT_MS)
    workerReady = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker = child
      workerKey = key
      workerReady = null
      scheduleIdleKill()
      resolve()
    }
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
      workerError = (workerError + chunk).slice(-2000)
    })
    child.on('error', (error) => fail('打标器起不来：' + error.message))
    child.on('exit', (code) => {
      const reason = '打标器退出了（code ' + String(code) + '）' + (workerError ? '：' + workerError.slice(-300) : '')
      worker = null
      workerKey = null
      fail(reason)
      for (const waiting of waiters.values()) {
        clearTimeout(waiting.timer)
        waiting.reject(new Error(reason))
      }
      waiters.clear()
    })
  })
}

/** 打一张图，返回 rating 分数。 */
export async function tagFile(info, file) {
  await startWorker(info)
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id)
      reject(new Error('这张图打标超时'))
    }, TAG_TIMEOUT_MS)
    waiters.set(id, { resolve, reject, timer })
    try {
      worker.stdin.write(JSON.stringify({ id, path: file }) + '\n')
    } catch (error) {
      waiters.delete(id)
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export function stopTagger() {
  killWorker()
}

// ---------------------------------------------------------------- 环境探测

function rankModel(name) {
  const lower = name.toLowerCase()
  if (lower.includes('eva02')) return 4
  if (lower.includes('v3')) return 3
  if (lower.includes('moat')) return 2
  if (lower.includes('convnext')) return 2
  return 1
}

/**
 * 找到打标器：模型 + csv + 解释器。
 * @param comfyRoot - ComfyUI 根目录。
 */
export function discover(comfyRoot) {
  const root = typeof comfyRoot === 'string' && comfyRoot.length > 0 ? comfyRoot : null
  const base = {
    ready: false,
    reason: null,
    model: null,
    csv: null,
    python: null,
    script: null,
    name: null,
    threshold: THRESHOLD,
  }
  if (root === null) return { ...base, reason: '还没读到 ComfyUI 根目录' }
  const models = []
  for (const relative of MODEL_DIRS) {
    let names = []
    try {
      names = fs.readdirSync(path.join(root, relative))
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.onnx')) continue
      const csv = path.join(root, relative, name.slice(0, -5) + '.csv')
      if (!fs.existsSync(csv)) continue
      models.push({ name, model: path.join(root, relative, name), csv })
    }
  }
  models.sort((a, b) => rankModel(b.name) - rankModel(a.name))
  const python = PYTHON_RELS
    .map((relative) => path.resolve(root, relative))
    .find((file) => {
      try { return fs.existsSync(file) } catch { return false }
    }) ?? null
  const chosen = models[0] ?? null
  if (chosen === null) {
    return { ...base, python, reason: '没找到 WD14 打标器模型（custom_nodes/ComfyUI-WD14-Tagger/models/*.onnx + 同名 .csv）' }
  }
  if (python === null) {
    return { ...base, model: chosen.model, csv: chosen.csv, name: chosen.name, reason: '没找到带 onnxruntime 的 python（.venv / python_embeded / standalone-env）' }
  }
  if (!fs.existsSync(SCRIPT)) {
    return { ...base, model: chosen.model, csv: chosen.csv, python, name: chosen.name, reason: '打标脚本丢了：' + SCRIPT }
  }
  return { ...base, ready: true, model: chosen.model, csv: chosen.csv, python, script: SCRIPT, name: chosen.name }
}

// ---------------------------------------------------------------- 判定与缓存

/** 分数 → 结论。 */
export function verdictOf(rating, threshold = THRESHOLD) {
  const explicit = Number(rating?.explicit ?? 0)
  const questionable = Number(rating?.questionable ?? 0)
  const sensitive = Number(rating?.sensitive ?? 0)
  const nsfw = explicit >= threshold.explicit || questionable >= threshold.questionable
  return { nsfw, explicit, questionable, sensitive, score: Math.max(explicit, questionable) }
}

const indexCache = new Map()

export function indexPath() {
  return path.join(stateDir(), 'nsfw.json')
}

export function readIndex() {
  const file = indexPath()
  let stat = null
  try {
    stat = fs.statSync(file)
  } catch {
    return { version: INDEX_VERSION, items: {} }
  }
  const hit = indexCache.get(file)
  if (hit !== undefined && hit.mtime === stat.mtimeMs && hit.size === stat.size) return hit.data
  let data = null
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    data = null
  }
  if (data === null || typeof data !== 'object' || data.items === null || typeof data.items !== 'object') {
    data = { version: INDEX_VERSION, items: {} }
  }
  indexCache.set(file, { mtime: stat.mtimeMs, size: stat.size, data })
  return data
}

export function writeIndex(data) {
  const dir = stateDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = indexPath()
  const temp = file + '.tmp-' + String(process.pid)
  fs.writeFileSync(temp, JSON.stringify(data), 'utf8')
  fs.renameSync(temp, file)
  try {
    const stat = fs.statSync(file)
    indexCache.set(file, { mtime: stat.mtimeMs, size: stat.size, data })
  } catch {
    indexCache.delete(file)
  }
}

/** 给条目挂上判定：nsfw 为 null 表示还没扫过。 */
export function annotate(items, index) {
  const cached = index?.items ?? {}
  return items.map((item) => {
    const hit = cached[item.rel]
    const fresh = hit !== undefined && hit.s === item.size && hit.m === item.mtime
    return {
      ...item,
      nsfw: fresh ? hit.n === true : null,
      nsfwScore: fresh && Number.isFinite(hit.x) ? hit.x : null,
    }
  })
}

export function countVerdicts(items) {
  let flagged = 0
  let safe = 0
  let unknown = 0
  for (const item of items) {
    if (item.nsfw === true) flagged += 1
    else if (item.nsfw === false) safe += 1
    else unknown += 1
  }
  return { total: items.length, nsfw: flagged, safe, unknown, scanned: flagged + safe }
}
