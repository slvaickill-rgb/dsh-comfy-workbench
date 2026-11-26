/**
 * lib/hub.js — Civitai 模型库的两块地基：凭据仓 + 单任务下载队列。
 *
 * 凭据为什么单独一个文件、不进 `config.json`：
 *   `api.config({})` 返回 `readState()` 的全量键，`config({patch})` 返回合并后的完整对象，
 *   `/v1/call` 也能取到——key 放进去等于给渲染进程和任何回环客户端开了一个读凭据的口子。
 *   而且 `writeState()` 是「全量读出 → 合并 → 临时文件 rename」，改个步数就会把 key 重写一遍。
 *
 * 凭据文件的边界（都是硬要求）：
 *   - 只在用户点「保存」且勾了「记住在本机」时才创建；不自动生成。
 *   - 写盘走临时文件 + rename，半个 JSON 不落盘；`chmod(0o600)` 在 Windows 上不生效，
 *     权限靠 `icacls /inheritance:r`，失败不阻断保存但要如实回 `aclHardened:false`。
 *   - `dispose()` 只清内存，**不删文件**——「重启免填」靠的就是它还在。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'

import { MODEL_CATEGORIES, MODEL_EXTENSIONS } from './dirs.js'
import { stateDir } from './state.js'
import { API_ORIGIN, isApiHost, openDownload } from './civitai.js'

const CRED_FILE = 'hub-credentials.json'
const KEY_MAX = 512
const CTX_HOST = 'civitai.red'
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024
const PART_PREFIX = '.dsh-hub-'

function coded(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** 掩码：短 key 全遮，长 key 露头尾各 2 位。 */
export function maskKey(key) {
  const text = String(key ?? '')
  if (text.length === 0) return ''
  if (text.length <= 8) return '••••'
  return text.slice(0, 2) + '…' + text.slice(-2)
}

/**
 * 文件名净化：只留字母数字、`.` `_` `-`、空格与中文；`..` 折叠；去掉开头的点。
 * @param name - 原始文件名。
 * @returns 净化后的名字；净化不出来返回 null。
 */
export function safeFileName(name) {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/'))
  let clean = base
    .replace(/[^A-Za-z0-9._\- \u4e00-\u9fa5]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/\.{2,}/g, '.')
    .trim()
  if (clean.length === 0) return null
  while (clean.startsWith('.')) clean = clean.slice(1)
  if (clean.length === 0) return null
  if (clean.length > 180) {
    const ext = path.extname(clean)
    clean = clean.slice(0, 180 - ext.length) + ext
  }
  return clean
}

/** 凭据仓：内存副本 + 独立文件。 */
export class CredentialStore {
  constructor(options = {}) {
    this.overridePath = typeof options.file === 'string' && options.file.length > 0 ? options.file : null
    this.key = ''
    this.mask = ''
    this.savedAt = null
    this.source = 'none'
    this.aclHardened = false
    this.error = null
    this._chain = Promise.resolve()
  }

  /** 凭据文件绝对路径（只给页面显示，不含内容）。 */
  filePath() {
    if (this.overridePath !== null) return this.overridePath
    return path.join(stateDir(), CRED_FILE)
  }

  /**
   * 读盘恢复。坏文件按「未设置」继续，**不删用户文件**。
   * @returns 状态快照。
   */
  load() {
    this.error = null
    const file = this.filePath()
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      // 没文件＝从没保存过，这是正常态，不是错误。
      this.key = ''
      this.mask = ''
      this.savedAt = null
      this.source = 'none'
      return this.status()
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      this.key = ''
      this.mask = ''
      this.savedAt = null
      this.source = 'none'
      this.error = { code: 'hub-key-file-invalid', message: '凭据文件不是合法 JSON：' + file }
      return this.status()
    }
    const key = parsed && typeof parsed.key === 'string' ? parsed.key : ''
    const version = Number(parsed?.version)
    const host = typeof parsed?.host === 'string' ? parsed.host : CTX_HOST
    if (version !== 1 || key.length === 0 || key.length > KEY_MAX || !host.includes('civitai')) {
      this.key = ''
      this.mask = ''
      this.savedAt = null
      this.source = 'none'
      this.error = { code: 'hub-key-file-invalid', message: '凭据文件结构不对（version/key/host）：' + file }
      return this.status()
    }
    this.key = key
    this.mask = maskKey(key)
    this.source = 'file'
    this.aclHardened = typeof parsed.aclHardened === 'boolean' ? parsed.aclHardened : false
    try {
      this.savedAt = Math.trunc(fs.statSync(file).mtimeMs)
    } catch {
      this.savedAt = Number(parsed.savedAt) || null
    }
    return this.status()
  }

  status() {
    return {
      hasKey: this.key.length > 0,
      keyMask: this.mask,
      persisted: this.source === 'file',
      keySource: this.source,
      savedAt: this.savedAt,
      aclHardened: this.aclHardened,
      error: this.error,
    }
  }

  /** 当前内存里的 key（给请求用；不出现在任何返回值里）。 */
  current() {
    return this.key
  }

  /** 只清内存副本，不动磁盘——插件卸载 / reload 时用。 */
  forget() {
    this.key = ''
    this.mask = ''
    this.savedAt = null
    this.source = 'none'
  }

  /**
   * 保存 / 清除。串行执行：`hubKey` 与 `hubSearch` 可能同时到。
   * @param key - 新 key；空串＝清除。
   * @param options - `{ persist }`，省略时按「记住在本机」的默认值。
   */
  async setKey(key, options = {}) {
    const text = typeof key === 'string' ? key.trim() : ''
    const task = this._chain.then(() => (text.length === 0 ? this._clear() : this._save(text, options)))
    this._chain = task.catch(() => null)
    return task
  }

  async clear() {
    const task = this._chain.then(() => this._clear())
    this._chain = task.catch(() => null)
    return task
  }

  async _save(key, options) {
    if (key.length > KEY_MAX) throw coded('hub-key-file-invalid', 'API Key 超过 ' + KEY_MAX + ' 个字符，可能贴错了')
    const persist = options.persist !== false
    this.error = null
    if (!persist) {
      this.key = key
      this.mask = maskKey(key)
      this.source = 'memory'
      this.savedAt = null
      return { ...this.status(), set: true, cleared: false, persisted: false }
    }
    const file = this.filePath()
    const dir = path.dirname(file)
    let storeError = null
    try {
      fs.mkdirSync(dir, { recursive: true })
      const savedAt = Date.now()
      const body = (aclHardened) => JSON.stringify({
        version: 1,
        host: CTX_HOST,
        key,
        mask: maskKey(key),
        savedAt,
        encrypted: false,
        aclHardened,
      }, null, 2) + '\n'
      const temp = file + '.tmp-' + String(process.pid)
      fs.writeFileSync(temp, body(true), 'utf8')
      try {
        fs.chmodSync(temp, 0o600)
      } catch {
        // Windows 上 chmod 基本无效，权限靠下面的 icacls。
      }
      // 先对临时文件断继承再 rename：rename 保留文件对象的显式 ACL，
      // 反过来「先 rename 再改」会在中间那段时间里可读，且再写一次会把 ACL 冲掉。
      const hardened = await hardenAcl(temp)
      if (!hardened) fs.writeFileSync(temp, body(false), 'utf8')
      fs.renameSync(temp, file)
      this.aclHardened = hardened
      this.key = key
      this.mask = maskKey(key)
      this.source = 'file'
      this.savedAt = savedAt
    } catch (error) {
      // 写盘失败不退化成报错：key 仍留在内存里，本次能用；页面给一句 notice。
      storeError = error instanceof Error ? error.message : String(error)
      this.key = key
      this.mask = maskKey(key)
      this.source = 'memory'
      this.savedAt = null
      this.error = { code: 'hub-key-store-failed', message: '凭据写盘失败：' + storeError }
    }
    return {
      ...this.status(),
      set: true,
      cleared: false,
      persisted: this.source === 'file',
      storeError,
    }
  }

  async _clear() {
    const file = this.filePath()
    let removed = false
    try {
      // 先覆盖写一次再删：留下半个旧文件比不删更糟。
      fs.writeFileSync(file, '{"version":1,"cleared":true}\n', 'utf8')
      fs.unlinkSync(file)
      removed = true
    } catch {
      removed = false
    }
    this.key = ''
    this.mask = ''
    this.savedAt = null
    this.source = 'none'
    this.aclHardened = false
    this.error = null
    return { ...this.status(), set: false, cleared: true, removed, persisted: false }
  }
}

/**
 * 对凭据文件断继承。失败不抛，返回 false。
 * @param file - 凭据文件绝对路径。
 */
export function hardenAcl(file) {
  return new Promise((resolve) => {
    let user = ''
    try {
      user = os.userInfo().username
    } catch {
      resolve(false)
      return
    }
    if (user.length === 0) {
      resolve(false)
      return
    }
    const child = spawn('icacls', [file, '/inheritance:r', '/grant:r', user + ':(F)'], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退了 */
      }
      finish(false)
    }, 5000)
    timer.unref?.()
    child.on('error', () => finish(false))
    child.on('exit', (code) => finish(code === 0))
  })
}

/**
 * 单任务下载队列。
 *
 * 一个进程只跑一个任务（与「出图一次一张」同族）：第二个 `start()` 直接 `hub-busy`。
 * 每个文件写 `<目标目录>\.dsh-hub-<version>-<随机>.part`，校验 SHA256 后 rename；
 * 失败/取消一律删 `.part`，不留半截模型。
 */
/** 断线类错误：值得换个连接续传一次，不该让整单直接失败。 */
function transientError(error) {
  const code = String(error?.code ?? '')
  if (['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'ABORT_ERR'].includes(code)) return true
  return /aborted|socket hang up|premature close|ECONNRESET|fetch failed|network/i.test(String(error?.message ?? ''))
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class HubDownloader {
  constructor(options = {}) {
    this.maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES
    this.onFinish = typeof options.onFinish === 'function' ? options.onFinish : null
    this.job = null
    this.controller = null
  }

  busy() {
    return this.job !== null && this.job.state === 'running'
  }

  /** 只读快照；页面 1 秒一次轮询这条，任何情况下都不触发下载。 */
  snapshot(token) {
    if (this.job === null) {
      return {
        token: token ?? null,
        state: 'idle',
        items: [],
        startedAt: null,
        finishedAt: null,
        bytesDone: 0,
        bytesTotal: 0,
        note: '还没有下载任务',
      }
    }
    if (typeof token === 'string' && token.length > 0 && token !== this.job.token) {
      throw coded('hub-job-missing', '找不到这个任务：' + token)
    }
    const items = this.job.items.map((item) => ({ ...item }))
    let bytesDone = 0
    let bytesTotal = 0
    for (const item of items) {
      bytesDone += Number(item.bytes) || 0
      bytesTotal += Number(item.total) || Number(item.sizeBytes) || 0
    }
    return {
      token: this.job.token,
      state: this.job.state,
      items,
      startedAt: this.job.startedAt,
      finishedAt: this.job.finishedAt,
      bytesDone,
      bytesTotal,
      note: this.job.note,
    }
  }

  /**
   * 起一个任务。
   * @param args - `{ token, items, overwrite, credential, dirs }`
   *   `dirs` 是 `collectDirs()` 的快照（`models` 与 `modelBase`）。
   */
  start(args = {}) {
    if (this.busy()) throw coded('hub-busy', '已经有一个下载任务在跑，等它结束或先取消')
    // 上限跟着配置走：每次入队都重新读，改配置不用重启。
    if (Number.isFinite(args.maxBytes) && args.maxBytes > 0) this.maxBytes = args.maxBytes
    const raw = Array.isArray(args.items) ? args.items : []
    if (raw.length === 0) throw coded('empty-input', '没有勾选任何文件')
    const token = typeof args.token === 'string' && args.token.length > 0
      ? args.token
      : 'hub-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex')
    const dirs = args.dirs ?? {}
    const models = dirs.models ?? {}
    const modelBase = dirs.modelBase ?? null
    const accepted = []
    const rejected = []
    for (const entry of raw) {
      try {
        accepted.push(this._prepare(entry, { models, modelBase, overwrite: args.overwrite === true }))
      } catch (error) {
        rejected.push({
          name: String(entry?.name ?? ''),
          code: typeof error?.code === 'string' ? error.code : 'hub-target-invalid',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (accepted.length === 0) {
      const first = rejected[0]
      throw coded(first?.code ?? 'hub-target-invalid', first?.message ?? '没有可下载的文件')
    }
    const totalBytes = accepted.reduce((sum, item) => sum + (Number(item.sizeBytes) || 0), 0)
    this.controller = new AbortController()
    this.job = {
      token,
      state: 'running',
      items: accepted,
      startedAt: Date.now(),
      finishedAt: null,
      note: rejected.length === 0 ? null : rejected.length + ' 个文件没进队：' + rejected.map((item) => item.name + '（' + item.message + '）').join('；'),
    }
    this._credential = typeof args.credential === 'string' ? args.credential : ''
    // 不 await：start 只负责入队，进度靠 snapshot 轮询。
    void this._run().catch(() => null)
    return { token, state: 'queued', accepted: accepted.length, rejected, totalBytes }
  }

  _prepare(entry, context) {
    if (entry === null || typeof entry !== 'object') throw coded('hub-target-invalid', '条目不是对象')
    const versionId = Number(entry.versionId)
    if (!Number.isFinite(versionId) || versionId <= 0) {
      throw coded('hub-target-invalid', '缺 versionId：' + String(entry.name ?? ''))
    }
    const category = String(entry.targetCategory ?? entry.category ?? '')
    if (!MODEL_CATEGORIES.includes(category)) {
      throw coded('hub-target-invalid', '目标类别不在白名单：' + category)
    }
    const dir = context.models[category]
    if (typeof dir !== 'string' || dir.length === 0) {
      throw coded('hub-target-invalid', '这个类别没有目录：' + category)
    }
    if (context.modelBase !== null) {
      const root = realOrSelf(context.modelBase)
      const target = realOrSelf(dir)
      const rel = path.relative(root, target)
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw coded('hub-target-invalid', '目标目录越界：' + target)
      }
    }
    const name = safeFileName(entry.name)
    if (name === null) throw coded('hub-target-invalid', '文件名净化后为空：' + String(entry.name ?? ''))
    const ext = path.extname(name).toLowerCase()
    if (!MODEL_EXTENSIONS.includes(ext)) {
      throw coded('hub-target-invalid', '扩展名不在白名单：' + (ext || '无'))
    }
    const sizeBytes = Number(entry.sizeBytes) || 0
    if (sizeBytes > this.maxBytes) {
      throw coded('hub-size-exceeded', '单文件 ' + fmtBytes(sizeBytes) + ' 超过上限 ' + fmtBytes(this.maxBytes))
    }
    const target = path.join(dir, name)
    if (context.overwrite !== true && fs.existsSync(target)) {
      throw coded('hub-file-exists', '同名文件已存在：' + target)
    }
    const free = freeBytes(dir)
    if (free !== null && sizeBytes > 0 && free < sizeBytes + 32 * 1024 * 1024) {
      throw coded('hub-size-exceeded', '磁盘空间不足：剩 ' + fmtBytes(free) + '，要下 ' + fmtBytes(sizeBytes))
    }
    return {
      name,
      versionId,
      targetCategory: category,
      dir,
      path: target,
      sizeBytes,
      total: sizeBytes,
      bytes: 0,
      sha256: typeof entry.sha256 === 'string' ? entry.sha256.toLowerCase() : null,
      sha256Ok: null,
      state: 'queued',
      error: null,
      note: null,
    }
  }

  async _run() {
    const job = this.job
    let failed = 0
    for (const item of job.items) {
      if (this.controller.signal.aborted) break
      item.state = 'running'
      try {
        await this._downloadOne(item)
        item.state = 'done'
      } catch (error) {
        const aborted = this.controller.signal.aborted || error?.code === 'hub-cancelled'
        item.state = aborted ? 'cancelled' : 'failed'
        item.error = {
          code: aborted ? 'hub-cancelled' : (typeof error?.code === 'string' ? error.code : 'hub-download-failed'),
          message: error instanceof Error ? error.message : String(error),
        }
        if (!aborted) failed += 1
        if (aborted) break
      }
    }
    job.finishedAt = Date.now()
    if (this.controller.signal.aborted) {
      job.state = 'cancelled'
      job.note = '已取消；已经下完的文件保留，没有回滚'
    } else if (failed > 0) {
      job.state = 'failed'
      job.note = failed + ' 个文件失败'
    } else {
      job.state = 'done'
      job.note = '全部完成'
    }
    this.controller = null
    if (typeof this.onFinish === 'function') {
      try {
        this.onFinish(this.snapshot())
      } catch {
        /* 通知失败不影响任务结果 */
      }
    }
  }

  async _downloadOne(item) {
    const part = path.join(item.dir, PART_PREFIX + item.versionId + '-' + randomBytes(3).toString('hex') + '.part')
    const maxAttempts = 3
    let attempt = 0
    // 下载走本机代理，长连接被掐是常事（实测 55.9 / 83.7 MB 时 ECONNRESET）。
    // 每次重试都带 Range 接着下，而不是从头再来。
    for (;;) {
      attempt += 1
      let handle = null
      try {
        const resumed = fs.existsSync(part) ? fs.statSync(part).size : 0
        const { response } = await openDownload(item.versionId, {
          token: this._credential,
          signal: this.controller.signal,
          headers: resumed > 0 ? { range: 'bytes=' + String(resumed) + '-' } : undefined,
        })
        const partial = response.status === 206
        const declared = Number(response.headers.get('content-length') ?? '')
        if (Number.isFinite(declared) && declared > 0) {
          const whole = partial ? resumed + declared : declared
          if (whole > this.maxBytes) {
            throw coded('hub-size-exceeded', '文件 ' + fmtBytes(whole) + ' 超过上限 ' + fmtBytes(this.maxBytes))
          }
          item.total = whole
          const free = freeBytes(item.dir)
          if (free !== null && free < declared + 32 * 1024 * 1024) {
            throw coded('hub-size-exceeded', '磁盘空间不足：剩 ' + fmtBytes(free) + '，还要下 ' + fmtBytes(declared))
          }
        }
        const hash = createHash('sha256')
        let bytes = 0
        if (partial && resumed > 0) {
          // 续传：先把已有的半截读回来喂给 sha256（55 MB 读盘比重新下便宜得多）。
          const existing = fs.readFileSync(part)
          hash.update(existing)
          bytes = existing.length
          handle = await fs.promises.open(part, 'a')
        } else {
          handle = await fs.promises.open(part, 'w')
        }
        if (response.body === null) throw coded('hub-download-failed', '下载响应没有 body')
        for await (const chunk of response.body) {
          if (this.controller.signal.aborted) throw coded('hub-cancelled', '已取消')
          bytes += chunk.length
          if (bytes > this.maxBytes) {
            throw coded('hub-size-exceeded', '下载过程中超过上限 ' + fmtBytes(this.maxBytes))
          }
          hash.update(chunk)
          item.bytes = bytes
          // FileHandle.write 不保证一次写完（大块 / 慢盘），自己转圈到写完为止。
          let offset = 0
          while (offset < chunk.length) {
            const written = await handle.write(chunk, offset, chunk.length - offset, null)
            if (!written || written.bytesWritten <= 0) throw coded('hub-download-failed', '写盘没有进展')
            offset += written.bytesWritten
          }
        }
        await handle.close()
        handle = null
        const digest = hash.digest('hex')
        if (typeof item.sha256 === 'string' && item.sha256.length === 64) {
          item.sha256Ok = digest === item.sha256
          if (!item.sha256Ok) {
            throw coded('hub-hash-mismatch', 'SHA256 对不上：拿到 ' + digest.slice(0, 12) + '，期望 ' + item.sha256.slice(0, 12))
          }
        } else {
          item.sha256Ok = null
          item.note = '上游没给 SHA256，跳过校验'
        }
        if (fs.existsSync(item.path)) {
          // 入队时查过一次；这中间有人放了同名文件就不覆盖。
          throw coded('hub-file-exists', '同名文件在下载期间出现：' + item.path)
        }
        fs.renameSync(part, item.path)
        if (attempt > 1) item.note = '断线重连 ' + String(attempt - 1) + ' 次后续传完成'
        item.bytes = bytes
        item.total = bytes
        return
      } catch (error) {
        try {
          if (handle !== null) await handle.close()
        } catch {
          /* 已关 */
        }
        const aborted = this.controller.signal.aborted || error?.code === 'hub-cancelled'
        if (!aborted && attempt < maxAttempts && transientError(error)) {
          item.note = '第 ' + String(attempt) + ' 次中断（' + String(error?.code ?? 'network') + '），' + (fs.existsSync(part) ? '断点续传' : '重试')
          await sleepMs(600 * attempt)
          continue
        }
        try {
          fs.rmSync(part, { force: true })
        } catch {
          /* 删不掉也不留正式名 */
        }
        throw error
      }
    }
  }
  /** 取消：abort 当前请求 + 删所有 `.part`。已经下完的文件保留。 */
  cancel(token) {
    if (this.job === null) throw coded('hub-job-missing', '现在没有任务')
    if (typeof token === 'string' && token.length > 0 && token !== this.job.token) {
      throw coded('hub-job-missing', '找不到这个任务：' + token)
    }
    if (this.job.state !== 'running') {
      return { token: this.job.token, cancelled: false, removedParts: [], note: '任务已经结束（' + this.job.state + '）' }
    }
    try {
      this.controller?.abort()
    } catch {
      /* 已经 abort */
    }
    const removed = []
    for (const item of this.job.items) {
      if (item.state !== 'running' && item.state !== 'queued') continue
      item.state = 'cancelled'
      try {
        for (const entry of fs.readdirSync(item.dir)) {
          if (!entry.startsWith(PART_PREFIX) || !entry.endsWith('.part')) continue
          if (!entry.includes(String(item.versionId))) continue
          const file = path.join(item.dir, entry)
          fs.rmSync(file, { force: true })
          removed.push(file)
        }
      } catch {
        /* 目录读不到就算了，_downloadOne 的 finally 也会删 */
      }
    }
    return { token: this.job.token, cancelled: true, removedParts: removed }
  }

  /** 插件卸载：清内存，不删盘上任何文件。 */
  dispose() {
    try {
      this.controller?.abort()
    } catch {
      /* 已 abort */
    }
    this.controller = null
    this.job = null
  }
}

function realOrSelf(target) {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return target
  }
}

/** 目录剩余字节；拿不到返回 null（不因为 statfs 不支持就拦住下载）。 */
function freeBytes(dir) {
  try {
    const stat = typeof fs.statfsSync === 'function' ? fs.statfsSync(dir) : null
    if (stat === null) return null
    return Number(stat.bavail) * Number(stat.bsize)
  } catch {
    return null
  }
}

function fmtBytes(bytes) {
  const value = Number(bytes) || 0
  if (value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(2) + ' GB'
  if (value >= 1024 ** 2) return (value / 1024 ** 2).toFixed(1) + ' MB'
  if (value >= 1024) return Math.round(value / 1024) + ' KB'
  return value + ' B'
}

export { API_ORIGIN, isApiHost, DEFAULT_MAX_BYTES }
