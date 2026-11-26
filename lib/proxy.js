/**
 * lib/proxy.js — 本机 HTTP 代理探测 + CONNECT 隧道。
 *
 * 为什么要它：Civitai 的图床在本机是「hosts 劫持 + DNS 投毒」，直连必挂；
 * 主人开着 Clash 的时候，同一张图走 127.0.0.1:7897 只要几百毫秒（走境外反代要十几秒）。
 * 所以出站先问一句「有没有本机代理」，有就优先走它；没开代理时行为跟以前一样。
 *
 * 只用 Node 内置模块。只认 http:// 的 CONNECT 代理（Clash / v2ray 的 HTTP 入站都是）。
 */

import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'

/** 常见本机代理端口：Clash(7897/7890)、v2rayN(10809)、SS(1080)、Privoxy(8118)… */
export const PROXY_PORTS = [7897, 7890, 7891, 10809, 10808, 1080, 2080, 8118, 33210]

const PROBE_TIMEOUT_MS = 300
const CACHE_TTL_MS = 60_000

let cache = { at: 0, proxy: null }

/** 解析 `http://127.0.0.1:7897`；不是 http 或解析不了就 null。 */
export function parseProxy(value) {
  const text = String(value ?? '').trim()
  if (text.length === 0) return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:') return null
    const port = Number(url.port === '' ? 80 : url.port)
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
    return { host: url.hostname, port, url: 'http://' + url.hostname + ':' + port }
  } catch {
    return null
  }
}

function portOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * 探测本机代理。
 * @param explicit - `state.hubProxy`：空串 = 关掉；字符串 = 指定；null/undefined = 自动探。
 * @returns `{ host, port, url }` 或 null。
 */
export async function detectProxy(explicit) {
  // 桩测 / 隔离环境用：一个变量把自动探测整个关掉。
  if (process.env.DSH_COMFY_NO_PROXY === '1') return null
  // 显式关掉：连环境变量都不看。
  if (typeof explicit === 'string' && explicit.trim().length === 0) return null
  const pinned = parseProxy(explicit)
  if (pinned !== null) return pinned
  const fromEnv = parseProxy(process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy)
  if (fromEnv !== null) return fromEnv
  const now = Date.now()
  if (now - cache.at < CACHE_TTL_MS) return cache.proxy
  // 并发探，单次最坏也就一个 300 ms 超时；按端口顺序取第一个活的。
  const open = await Promise.all(PROXY_PORTS.map((port) => portOpen('127.0.0.1', port, PROBE_TIMEOUT_MS)))
  const index = open.indexOf(true)
  if (index >= 0) {
    const port = PROXY_PORTS[index]
    cache = { at: now, proxy: { host: '127.0.0.1', port, url: 'http://127.0.0.1:' + port } }
    return cache.proxy
  }
  cache = { at: now, proxy: null }
  return null
}

/** 打通到目标主机的 CONNECT 隧道（返回裸 TCP socket）。 */
function openTunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: host + ':' + String(port),
      headers: { host: host + ':' + String(port) },
    })
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('代理握手超时'), { code: 'ETIMEDOUT' })))
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(Object.assign(new Error('代理拒绝 CONNECT：HTTP ' + String(res.statusCode)), { code: 'PROXY_REFUSED' }))
        return
      }
      resolve(socket)
    })
    req.on('error', (error) => reject(error))
    req.end()
  })
}

/** 把 IncomingMessage 套成 getOnce 期望的形状（跟 shapeOf 同一份契约）。 */
function shapeOfProxy(res) {
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    headers: {
      get(name) {
        const value = res.headers[String(name).toLowerCase()]
        if (value === undefined) return null
        return Array.isArray(value) ? value.join(', ') : String(value)
      },
    },
    body: res,
    via: 'proxy',
  }
}

/**
 * 经本机代理发一次 GET/HEAD。https 目标走 CONNECT + TLS，证书照常校验
 * （SNI 仍是目标主机名，所以不会因为「连的是 127.0.0.1」而报证书错）。
 * @param proxy - detectProxy() 的返回值。
 * @param rawUrl - 目标地址。
 * @param options - `{ headers, timeoutMs, signal, method }`。
 * @returns 与 getOnce 同形状的 response（3xx 原样交给调用方）。
 */
export async function requestViaProxy(proxy, rawUrl, options = {}) {
  const url = new URL(rawUrl)
  const port = Number(url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : url.port)
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15_000
  if (options.signal?.aborted === true) {
    throw Object.assign(new Error('已取消'), { code: 'ABORT_ERR' })
  }
  const socket = await openTunnel(proxy, url.hostname, port, timeoutMs)
  let target = socket
  if (url.protocol === 'https:') {
    target = await new Promise((resolve, reject) => {
      const secure = tls.connect({ socket, servername: url.hostname }, () => resolve(secure))
      secure.once('error', reject)
    })
  }
  const headers = { ...(options.headers ?? {}), host: url.hostname }
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: options.method ?? 'GET',
      host: url.hostname,
      path: url.pathname + url.search,
      headers,
      createConnection: () => target,
    })
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('代理请求超时'), { code: 'ETIMEDOUT' })))
    req.on('response', (res) => resolve(shapeOfProxy(res)))
    req.on('error', (error) => {
      target.destroy()
      reject(error)
    })
    const signal = options.signal
    if (signal !== undefined && typeof signal.addEventListener === 'function') {
      const abort = () => req.destroy(Object.assign(new Error('已取消'), { code: 'ABORT_ERR' }))
      signal.addEventListener('abort', abort, { once: true })
    }
    req.end()
  })
}
