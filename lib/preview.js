/**
 * lib/preview.js — 逐步预览：手写 WebSocket 客户端 + 帧缓冲 + 事件日志。
 *
 * 为什么放宿主半：ComfyUI 的 `send_sync` 只发给 `/prompt` 里那个 client_id 对应的连接
 * （`execution.py` L738-741），而 client_id 是 `generate` 生成的 —— 同进程才拿得到同一个 sid。
 *
 * 为什么手写 RFC6455：本机独立 node 是 v22（有全局 WebSocket），但 DSH 内嵌 Electron 的
 * Node 版本没核过。这里只用 `node:http` + `node:crypto`，约 200 行，不赌宿主版本、不装 `ws`。
 *
 * 协议要点（都来自本机 ComfyUI 0.42.1 源码）：
 *   - 连上后**第一条 TEXT 帧**必须声明 feature_flags，晚一条服务端就不认（server.py L360-378）
 *   - 声明后预览帧是 event=4（带 metadata），否则 event=1（旧格式）
 *   - 二进制帧：4 字节大端 event，之后是载荷
 *   - 每步另发 JSON `progress`（value/max/node）；先 progress_state、再二进制、最后 progress
 *
 * 预览帧**不写盘**：只进内存环形缓冲，重开页面即丢，避免污染输出目录的分类统计。
 */

import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'

/** 最多保留多少帧 / 多少字节。 */
export const DEFAULT_LIMIT = 60
export const LIMIT_MAX = 200
export const MAX_BYTES = 12 * 1024 * 1024

/** 事件日志上限。 */
const EVENT_MAX = 200
const EVENT_TEXT_MAX = 300

/** 单帧超过这个大小直接丢（512² JPEG 通常 <100 KB）。 */
const FRAME_MAX_BYTES = 2 * 1024 * 1024

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function nowMs() {
  return Date.now()
}

/**
 * 最小 WebSocket 客户端：只做「连上 → 收发文本/二进制 → 关闭」。
 * @param baseUrl - 形如 `http://127.0.0.1:8188`。
 * @param clientId - 与服务端 sockets key 一致的 sid。
 * @param handlers - `{ onOpen, onText, onBinary, onClose, onError }`
 */
export function openSocket(baseUrl, clientId, handlers) {
  const target = new URL(baseUrl)
  const secure = target.protocol === 'https:'
  const key = crypto.randomBytes(16).toString('base64')
  const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
  const request = (secure ? https : http).request({
    host: target.hostname,
    port: target.port || (secure ? 443 : 80),
    path: '/ws?clientId=' + encodeURIComponent(clientId),
    method: 'GET',
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    },
  })

  let socket = null
  let closed = false
  let buffer = Buffer.alloc(0)
  let fragmentOpcode = 0
  let fragments = []

  const finish = (reason) => {
    if (closed) return
    closed = true
    try {
      socket?.destroy()
    } catch {
      /* 已经断了 */
    }
    handlers.onClose?.(reason)
  }

  request.on('upgrade', (response, upgraded, head) => {
    if (response.headers['sec-websocket-accept'] !== expected) {
      finish('握手校验失败：Sec-WebSocket-Accept 不匹配')
      return
    }
    socket = upgraded
    socket.setNoDelay(true)
    if (head && head.length > 0) consume(head)
    socket.on('data', (chunk) => consume(chunk))
    socket.on('close', () => finish('连接关闭'))
    socket.on('error', (error) => {
      handlers.onError?.(error)
      finish(error instanceof Error ? error.message : String(error))
    })
    handlers.onOpen?.()
  })

  request.on('response', (response) => {
    // 没升上去（404 / 403）：把状态码带回去，不做重试。
    response.resume()
    finish('握手被拒：HTTP ' + response.statusCode)
  })

  request.on('error', (error) => {
    handlers.onError?.(error)
    finish(error instanceof Error ? error.message : String(error))
  })

  request.end()

  /** 解析服务端帧（不 mask）。 */
  function consume(chunk) {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 2) return
      const first = buffer[0]
      const second = buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < offset + 2) return
        length = buffer.readUInt16BE(offset)
        offset += 2
      } else if (length === 127) {
        if (buffer.length < offset + 8) return
        const high = buffer.readUInt32BE(offset)
        const low = buffer.readUInt32BE(offset + 4)
        length = high * 2 ** 32 + low
        offset += 8
      }
      let maskKey = null
      if (masked) {
        if (buffer.length < offset + 4) return
        maskKey = buffer.slice(offset, offset + 4)
        offset += 4
      }
      if (buffer.length < offset + length) return
      let payload = buffer.slice(offset, offset + length)
      buffer = buffer.slice(offset + length)
      if (maskKey !== null) {
        payload = Buffer.from(payload)
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= maskKey[index % 4]
      }

      if (opcode === 0x9) {
        sendFrame(0x0a, payload)
        continue
      }
      if (opcode === 0x8) {
        finish('服务端关闭连接')
        return
      }
      if (opcode === 0x0) {
        fragments.push(payload)
        if (fin) {
          const joined = Buffer.concat(fragments)
          const type = fragmentOpcode
          fragments = []
          fragmentOpcode = 0
          dispatch(type, joined)
        }
        continue
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) {
          fragmentOpcode = opcode
          fragments = [payload]
          continue
        }
        dispatch(opcode, payload)
      }
    }
  }

  function dispatch(opcode, payload) {
    if (opcode === 0x1) handlers.onText?.(payload.toString('utf8'))
    else if (opcode === 0x2) handlers.onBinary?.(payload)
  }

  /** 客户端发帧必须 mask。 */
  function sendFrame(opcode, payload) {
    if (socket === null || closed) return false
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
    const mask = crypto.randomBytes(4)
    const headerLength = body.length < 126 ? 2 : (body.length < 65536 ? 4 : 10)
    const frame = Buffer.alloc(headerLength + 4 + body.length)
    frame[0] = 0x80 | opcode
    if (body.length < 126) {
      frame[1] = 0x80 | body.length
    } else if (body.length < 65536) {
      frame[1] = 0x80 | 126
      frame.writeUInt16BE(body.length, 2)
    } else {
      frame[1] = 0x80 | 127
      frame.writeUInt32BE(0, 2)
      frame.writeUInt32BE(body.length, 6)
    }
    mask.copy(frame, headerLength)
    for (let index = 0; index < body.length; index += 1) {
      frame[headerLength + 4 + index] = body[index] ^ mask[index % 4]
    }
    try {
      socket.write(frame)
      return true
    } catch {
      finish('写入失败')
      return false
    }
  }

  return {
    get open() {
      return socket !== null && !closed
    },
    sendText(text) {
      return sendFrame(0x1, text)
    },
    close() {
      try {
        sendFrame(0x8, Buffer.alloc(0))
      } catch {
        /* 忽略 */
      }
      finish('本地关闭')
    },
  }
}

/** 按魔头判断图片类型；认不出返回 null（调用方丢弃该帧）。 */
function sniffMime(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

/**
 * 一次生成任务的预览会话：连接、帧缓冲、事件日志。
 */
export class PreviewHub {
  /**
   * @param options - `{ limit, maxBytes, log }`，log 是可选日志函数。
   */
  constructor(options = {}) {
    this.limit = Math.min(Math.max(Number(options.limit ?? DEFAULT_LIMIT), 1), LIMIT_MAX)
    this.maxBytes = Number(options.maxBytes ?? MAX_BYTES)
    this.log = options.log ?? (() => {})
    this.socket = null
    this.connected = false
    this.connectNote = null
    this.promptId = null
    this.clientId = null
    this.method = 'none'
    this.enabled = false
    this.state = 'idle'
    this.total = 0
    this.current = 0
    this.node = null
    /** @type {Map<number, {bytes:Buffer,mime:string,at:number,node:string|null}>} */
    this.frames = new Map()
    this.frameBytes = 0
    this.dropped = 0
    this.events = []
    this.interruptedBy = null
    this.startedAt = null
    this.lastFrameAt = null
  }

  /** 追加一条日志（单条 ≤300 字符，最多 200 条）。 */
  push(kind, text) {
    const line = { at: nowMs(), kind, text: String(text).slice(0, EVENT_TEXT_MAX) }
    this.events.push(line)
    if (this.events.length > EVENT_MAX) this.events.splice(0, this.events.length - EVENT_MAX)
    this.log(kind + ' ' + line.text)
    return line
  }

  /**
   * 连上 WS 并等 `status` 帧（最多等 timeoutMs）。
   * @returns `{ connected, note }`
   */
  attach(comfyUrl, clientId, method, timeoutMs = 800) {
    this.close()
    this.clientId = clientId
    this.method = method
    this.enabled = method !== 'none'
    this.state = 'connecting'
    this.promptId = null
    this.frames.clear()
    this.frameBytes = 0
    this.dropped = 0
    this.total = 0
    this.current = 0
    this.node = null
    this.interruptedBy = null

    if (!this.enabled) {
      this.connected = false
      this.connectNote = '预览已关闭'
      this.push('info', '预览已关闭：本次只轮询成品图')
      return Promise.resolve({ connected: false, note: this.connectNote })
    }

    return new Promise((resolve) => {
      let settled = false
      const done = (connected, note) => {
        if (settled) return
        settled = true
        this.connected = connected
        this.connectNote = note
        resolve({ connected, note })
      }
      const timer = setTimeout(() => {
        // 800 ms 内没等到 status：连接本身在，照常提交，帧可能晚到。
        done(this.socket !== null && this.socket.open, this.socket !== null && this.socket.open ? null : '等待 status 帧超时')
      }, timeoutMs)

      this.socket = openSocket(comfyUrl, clientId, {
        onOpen: () => {
          // 第一条帧必须是 feature_flags，晚一条服务端就不认新格式。
          this.socket?.sendText(JSON.stringify({
            type: 'feature_flags',
            data: { supports_preview_metadata: true },
          }))
          this.push('info', '预览连接已建立，已声明支持帧元数据')
        },
        onText: (text) => {
          let message = null
          try {
            message = JSON.parse(text)
          } catch {
            return
          }
          this.onJson(message)
          if (message?.type === 'status') {
            clearTimeout(timer)
            done(true, null)
          }
        },
        onBinary: (bytes) => this.onBinary(bytes),
        onClose: (reason) => {
          this.connected = false
          if (this.state === 'running' || this.state === 'connecting') {
            this.push('warn', '预览连接断开：' + reason)
          }
          clearTimeout(timer)
          done(false, reason)
        },
        onError: (error) => {
          this.push('warn', '预览连接出错：' + (error instanceof Error ? error.message : String(error)))
        },
      })
    })
  }

  /** 收到 JSON 帧。 */
  onJson(message) {
    const type = message?.type
    const data = message?.data ?? {}
    if (type === 'progress') {
      if (Number.isFinite(data.value)) this.current = Number(data.value)
      if (Number.isFinite(data.max)) this.total = Number(data.max)
      if (typeof data.node === 'string') this.node = data.node
      if (typeof data.prompt_id === 'string' && this.promptId === null) this.promptId = data.prompt_id
      this.push('step', '第 ' + this.current + ' / ' + this.total + ' 步' + (this.node ? '（节点 ' + this.node + '）' : ''))
      return
    }
    if (type === 'executing') {
      const node = typeof data.node === 'string' ? data.node : null
      if (node === null) {
        this.push('exec', '采样结束')
        return
      }
      this.node = node
      this.push('exec', '节点 ' + node + ' 开始执行')
      return
    }
    if (type === 'executed') {
      this.push('exec', '节点 ' + (data.node ?? '?') + ' 完成')
      return
    }
    if (type === 'execution_error') {
      this.state = 'failed'
      this.push('error', '执行出错：' + String(data.exception_message ?? '未知错误').slice(0, 200))
      return
    }
    if (type === 'execution_interrupted') {
      this.state = 'interrupted'
      this.interruptedBy = this.interruptedBy ?? 'user'
      this.push('warn', '已在第 ' + this.current + ' 步中断')
      return
    }
    if (type === 'status') {
      const remaining = data?.status?.exec_info?.queue_remaining
      this.push('info', '队列剩余 ' + (Number.isFinite(remaining) ? remaining : '?') + ' 个任务')
    }
  }

  /** 收到二进制帧：先拆 event，再按格式取元数据与图片。 */
  onBinary(buffer) {
    if (buffer.length < 8) {
      this.dropped += 1
      return
    }
    const event = buffer.readUInt32BE(0)
    let image = null
    let nodeId = this.node
    if (event === 4) {
      const metaLength = buffer.readUInt32BE(4)
      if (metaLength <= 0 || buffer.length < 8 + metaLength) {
        this.dropped += 1
        return
      }
      const metaText = buffer.slice(8, 8 + metaLength).toString('utf8')
      image = buffer.slice(8 + metaLength)
      try {
        const meta = JSON.parse(metaText)
        nodeId = typeof meta.node_id === 'string' ? meta.node_id : nodeId
      } catch {
        /* 元数据坏了也要图，只是没有 node */
      }
    } else if (event === 1) {
      // 旧格式的第 2 个 uint32 是 imageType(1=JPEG,2=PNG)，实际类型仍以魔头为准。
      image = buffer.slice(8)
    } else {
      this.dropped += 1
      return
    }
    if (image.length === 0 || image.length > FRAME_MAX_BYTES) {
      this.dropped += 1
      return
    }
    const sniffed = sniffMime(image)
    if (sniffed === null) {
      // 不是 JPEG/PNG/WebP 的帧（例如被网关塞了别的字节）直接丢，不猜。
      this.dropped += 1
      return
    }
    const step = this.current > 0 ? this.current : (this.frames.size + 1)
    this.storeFrame(step, image, sniffed, nodeId)
  }

  storeFrame(step, bytes, mime, node) {
    const previous = this.frames.get(step)
    if (previous !== undefined) this.frameBytes -= previous.bytes.length
    this.frames.set(step, { bytes, mime, at: nowMs(), node: node ?? null })
    this.frameBytes += bytes.length
    this.lastFrameAt = nowMs()
    // 两道淘汰：条数上限 + 总字节上限，都从最旧的步开始丢。
    while (this.frames.size > this.limit) {
      const oldest = this.frames.keys().next().value
      const dropped = this.frames.get(oldest)
      this.frameBytes -= dropped.bytes.length
      this.frames.delete(oldest)
    }
    while (this.frameBytes > this.maxBytes && this.frames.size > 1) {
      const oldest = this.frames.keys().next().value
      const dropped = this.frames.get(oldest)
      this.frameBytes -= dropped.bytes.length
      this.frames.delete(oldest)
    }
  }

  /** 提交成功后绑定 prompt id 并进 running。 */
  begin(promptId, total) {
    this.promptId = promptId
    this.startedAt = nowMs()
    this.state = 'running'
    if (Number.isFinite(total) && total > 0) this.total = total
    this.push('info', '已提交任务 ' + String(promptId).slice(0, 8) + '（' + this.method + '）')
  }

  /** 任务结束（成功/失败/中断）。 */
  settle(state) {
    if (this.state === 'interrupted' && state === 'done') return
    this.state = state
  }

  markInterrupted() {
    this.state = 'interrupted'
    this.interruptedBy = 'user'
  }

  /** 给页面的快照：元数据 + 步列表 + 事件，不含图片字节。 */
  snapshot({ promptId, since = 0, limit } = {}) {
    const wanted = promptId ?? this.promptId
    const max = Math.min(Math.max(Number(limit ?? this.limit), 1), LIMIT_MAX)
    const steps = [...this.frames.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([step]) => step > since)
      .slice(0, max)
      .map(([step, frame]) => ({
        step,
        node: frame.node,
        at: frame.at,
        mime: frame.mime,
        bytes: frame.bytes.length,
        url: '/dsh-comfy/preview/' + step + '?promptId=' + encodeURIComponent(wanted ?? '') + '&t=' + frame.at,
      }))
    const nextSince = steps.length > 0 ? steps[steps.length - 1].step : since
    return {
      promptId: wanted,
      connected: this.connected,
      previewMethod: this.method,
      previewEnabled: this.enabled,
      total: this.total,
      current: this.current,
      node: this.node,
      state: this.state,
      steps,
      events: this.events.map((line) => ({ at: line.at, kind: line.kind, text: line.text })),
      dropped: this.dropped,
      nextSince,
      note: this.connectNote,
      scannedAt: nowMs(),
    }
  }

  /** 取某一帧的字节，供 `/dsh-comfy/preview/<step>` 用。 */
  frame(step) {
    return this.frames.get(Number(step)) ?? null
  }

  /** 关连接并清缓冲。 */
  close() {
    try {
      this.socket?.close()
    } catch {
      /* 忽略 */
    }
    this.socket = null
    this.connected = false
    this.frames.clear()
    this.frameBytes = 0
  }

  /** 插件卸载时调用。 */
  dispose() {
    this.close()
    this.state = 'idle'
  }
}

/** 从 ComfyUI 的 preview 方法名里挑一个可用的：本机没 TAESD 权重，taesd 会被服务端忽略。 */
export function normalizePreviewMethod(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === 'none' || raw === 'off' || raw === 'false') return 'none'
  if (raw === 'latent2rgb' || raw === 'taesd' || raw === 'auto') return raw
  return 'latent2rgb'
}
