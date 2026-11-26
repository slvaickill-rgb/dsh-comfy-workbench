/**
 * lib/civitai.js — Civitai 公共 API 的最小客户端。
 *
 * 只做四件事：解析链接、拉 JSON、归一字段、把封面换成同源反代地址。
 *
 * 三条硬规则都是本机实测出来的，别改回「图省事」的写法：
 *   1. **公开列表不需要 key**：`/api/v1/models` 无凭据就返回 200。gated 资源与
 *      `favorites` / `hidden` 这类个人参数才要 `Authorization: Bearer`。所以没填 key
 *      时页面不能把搜索置灰。
 *   2. **下载一定跳一次 307** 到 R2 签名 CDN。`redirect:'manual'` 手动校验 `Location`，
 *      跟到 CDN 的那一次**必须去掉 Authorization**——带 Bearer 打签名 URL 会被拒。
 *   3. **`image.civitai.com` 是外站域名**，渲染进程的 `img-src` 未必放行，封面统一走
 *      同源 `/dsh-comfy/hub/cover?u=`。
 *
 * 只用 Node 内置模块（fetch / Buffer），不引第三方。
 */

import https from 'node:https'

import { detectProxy, requestViaProxy } from './proxy.js'

export const API_ORIGIN = 'https://civitai.red'
export const COVER_ROUTE = '/dsh-comfy/hub/cover'

/** 允许打 `Authorization` 的主机（API 与页面同域）。 */
const API_HOSTS = new Set(['civitai.red', 'www.civitai.red', 'civitai.com', 'www.civitai.com'])

/**
 * 下载会跳到的 R2 签名 CDN。
 * 真实形状是三段：`civitai-delivery-worker-prod.<hash>.r2.cloudflarestorage.com`，
 * 少写中间那一段会让所有真实下载被自己的白名单拦掉。
 */
const CDN_HOST = /^civitai-[a-z0-9-]+(?:\.[a-z0-9]+)*\.r2\.cloudflarestorage\.com$/

/** 封面允许的主机；`*.civitai.com` 一并放行。 */
const IMAGE_HOSTS = new Set([
  'image.civitai.com', 'civitai.com', 'www.civitai.com', 'civitai.red', 'www.civitai.red',
  // 封面反代（见 COVER_PROXIES）：本机直连 image.civitai.com 不通，靠它取缩略图。
  'images.weserv.nl',
])

/** Civitai `type` → 本机模型类别目录。没有默认目录的那几类返回 null。 */
export const TYPE_CATEGORY = {
  LORA: 'loras',
  LoCon: 'loras',
  DoRA: 'loras',
  Checkpoint: 'checkpoints',
  TextualInversion: 'embeddings',
  VAE: 'vae',
  Controlnet: 'controlnet',
  Upscaler: 'upscale_models',
  Hypernetwork: 'hypernetworks',
}

/** 卡片与筛选下拉用的中文标签。 */
export const TYPE_LABEL = {
  LORA: 'LoRA',
  LoCon: 'LoCon',
  DoRA: 'DoRA',
  Checkpoint: '底模 Checkpoint',
  TextualInversion: '文本嵌入 Embedding',
  VAE: 'VAE',
  Controlnet: 'ControlNet',
  Upscaler: '放大模型',
  Hypernetwork: '超网络',
  AestheticGradient: '审美梯度',
  Poses: '姿态',
  Wildcards: '通配词',
  Workflows: '工作流',
  MotionModule: '运动模块',
  Other: '其他',
}

const DOWNLOAD_FAILED = 'hub-download-failed'

function coded(code, message, extra) {
  const error = new Error(message)
  error.code = code
  if (extra !== undefined) error.extra = extra
  return error
}

/** 取主机名（小写、去端口）；解析不了返回空串。 */
export function hostOf(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function isApiHost(hostname) {
  return API_HOSTS.has(String(hostname ?? '').toLowerCase())
}

export function isCdnHost(hostname) {
  return CDN_HOST.test(String(hostname ?? '').toLowerCase())
}

/**
 * 下载允许的主机：API 域、R2 签名 CDN，以及 **Civitai 自家的 `*.civitai.com`**。
 * 2026-11-26 实测：`/api/download/models/<id>` 现在 307 到 `b2.civitai.com`（文件本体），
 * 以前那条只认 R2 的白名单会把真实下载全拦掉。
 */
export function isDownloadHost(hostname) {
  const host = String(hostname ?? '').toLowerCase()
  return isApiHost(host) || isCdnHost(host) || /(^|\.)civitai\.com$/.test(host)
}

export function isImageHost(hostname) {
  const host = String(hostname ?? '').toLowerCase()
  return IMAGE_HOSTS.has(host) || host.endsWith('.civitai.com') || isCdnHost(host)
}

/** `type` → 目录名；不认识就 null（页面据此置灰并报 hub-model-type-unsupported）。 */
export function categoryForType(type) {
  return TYPE_CATEGORY[String(type ?? '')] ?? null
}

/**
 * 解析用户粘进来的东西。
 *
 * 认这几种：`https://civitai.red/models/264290`、`?modelVersionId=1558543`、
 * `/api/download/models/1558543`、`/model-versions/1558543`、裸数字。
 * 裸数字分不清是 model 还是 version，返回 `{ kind: 'id' }`，由调用方先按 model 试。
 *
 * @param raw - 链接或 ID。
 * @returns `{ kind:'model'|'version'|'id', id:number }`；认不出返回 null。
 */
export function parseRef(raw) {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return null
  if (/^\d{1,12}$/.test(text)) {
    const id = Number(text)
    return Number.isSafeInteger(id) && id > 0 ? { kind: 'id', id } : null
  }
  // 带了协议就要求主机在白名单里，别让 https://evil.example/models/1 混进来。
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const host = hostOf(text)
    if (!isApiHost(host)) return null
  }
  const patterns = [
    { re: /\/api\/download\/models\/(\d+)/i, kind: 'version' },
    { re: /[?&]modelVersionId=(\d+)/i, kind: 'version' },
    { re: /\/model-versions\/(\d+)/i, kind: 'version' },
    { re: /\/models\/(\d+)/i, kind: 'model' },
  ]
  for (const { re, kind } of patterns) {
    const hit = text.match(re)
    if (hit !== null) return { kind, id: Number(hit[1]) }
  }
  return null
}

/** 封面走同源反代；原图地址编进 query。 */
export function coverUrl(original) {
  if (typeof original !== 'string' || original.length === 0) return null
  return COVER_ROUTE + '?u=' + encodeURIComponent(original)
}

/**
 * 封面要 450 px 宽的变体。
 *
 * Civitai 的图片缩放是**路径段**，不是 query：真实形状
 * `https://image.civitai.com/<hash>/<uuid>/original=true/1917130.jpeg`，
 * 把 `original=true`（或 `orig`、已有的 `width=NNN`）换成 `width=450` 才生效。
 * 实测同一张图：原图 4,192,036 字节，`width=450` 后约 60 KB。一页 12 张差 50 MB。
 */
export function coverVariant(raw, width = 450) {
  if (typeof raw !== 'string' || raw.length === 0) return raw
  try {
    const url = new URL(raw)
    const segments = url.pathname.split('/')
    const index = segments.findIndex((segment) => segment === 'original=true' || segment === 'orig' || /^width=\d+$/.test(segment))
    if (index >= 0) {
      segments[index] = 'width=' + String(width)
      url.pathname = segments.join('/')
      return url.href
    }
    // 认不出路径形状就退回 query：Civitai 不认也无害，反正有 4 MB 兜底。
    url.searchParams.set('width', String(width))
    return url.href
  } catch {
    return raw
  }
}

/**
 * 一次 JSON 请求。走 `getOnce`：本机代理 → fetch → https，三档同一套错误码。
 * @param pathOrUrl - `/api/v1/...` 或完整 URL。
 * @param options - `{ token, timeoutMs, proxySetting, hops }`。
 * @returns `{ json, status, retryAfter }`。
 */
export async function fetchJson(pathOrUrl, options = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : API_ORIGIN + pathOrUrl
  const hops = Number(options.hops ?? 0)
  if (hops >= 3) throw coded('hub-api-error', 'Civitai 重定向超过 3 跳')
  const headers = { accept: 'application/json' }
  if (typeof options.token === 'string' && options.token.length > 0) {
    headers.authorization = 'Bearer ' + options.token
  }
  let response
  try {
    response = await getOnce(url, {
      headers,
      timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20_000,
      proxySetting: options.proxySetting,
    })
  } catch (error) {
    throw coded('hub-api-error', 'Civitai 连不上：' + (error instanceof Error ? error.message : String(error)))
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    if (location === null) throw coded('hub-api-error', 'Civitai 重定向没有 Location')
    const next = new URL(location, url).href
    // 只跟到 API 域，别把 Bearer 顺手带去别处。
    if (!isApiHost(hostOf(next))) throw coded('hub-api-error', 'Civitai 重定向到了域外：' + hostOf(next))
    return fetchJson(next, { ...options, hops: hops + 1 })
  }
  const retryAfter = Number(response.headers.get('retry-after') ?? '') || null
  if (response.status === 401 || response.status === 403) {
    throw coded('hub-key-missing', '这个资源要 API Key（或 key 已失效）：HTTP ' + response.status)
  }
  if (response.status === 429) {
    throw coded('hub-rate-limited', 'Civitai 限流了' + (retryAfter === null ? '' : '，' + retryAfter + ' 秒后再试'))
  }
  if (!response.ok) {
    const body = await readText(response.body, 64 * 1024).catch(() => '')
    throw coded('hub-api-error', 'Civitai 返回 HTTP ' + response.status + (body.length > 0 ? '：' + body.slice(0, 160) : ''))
  }
  const text = await readText(response.body, 8 * 1024 * 1024)
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw coded('hub-api-error', 'Civitai 返回的不是 JSON')
  }
  return { json, status: response.status, retryAfter }
}

/**
 * Civitai 的 `description` 是 HTML。详情页只显示纯文本：
 * 保留段落与换行，剥掉标签和实体，太长就截断（4000 字够看）。
 */
export function htmlToText(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  const text = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '· ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, String.fromCharCode(39))
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, code) => {
      const point = Number(code)
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.slice(0, 4000)
}

/**
 * `node:https` 版的一次 GET。
 *
 * 为什么要它：实测宿主进程里的全局 `fetch` 对 `image.civitai.com` 会直接抛
 * （同一份代码放到新起的 Electron node 进程里却正常，说明是宿主给 fetch 挂了
 * 代理 dispatcher 之类的东西，而且它对图片主机不通）。这里用**独立 Agent** 直连，
 * 不碰任何全局 dispatcher；失败时把两边的错误码都带出去，别让用户只看到「取不到」。
 */
function httpsGet(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(urlString)
    } catch {
      reject(coded('hub-invalid-url', '地址不合法：' + String(urlString)))
      return
    }
    const agent = new https.Agent({ keepAlive: false, maxSockets: 6 })
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port === '' ? 443 : Number(url.port),
      path: url.pathname + url.search,
      method: 'GET',
      headers: options.headers ?? {},
      agent,
    })
    let settled = false
    req.setTimeout(Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15_000, () => {
      req.destroy(Object.assign(new Error('连接超时'), { code: 'ETIMEDOUT' }))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    const signal = options.signal ?? null
    if (signal !== null) {
      const abort = () => req.destroy(Object.assign(new Error('已取消'), { code: 'ABORT_ERR' }))
      if (signal.aborted === true) abort()
      else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', abort, { once: true })
    }
    req.on('response', (res) => {
      if (settled) {
        res.destroy()
        return
      }
      settled = true
      resolve(shapeOf(res))
    })
    req.end()
  })
}

/** 把 IncomingMessage 套成 fetch Response 的那几个只读字段，下载器两边共用。 */
function shapeOf(res) {
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
    via: 'https',
  }
}

/**
 * 哪个主机上 fetch 已经证明不通（5 分钟内不再试）。
 *
 * 一页 12 张封面，如果每张都要先卡满一个超时再回退，首屏就是 15 秒。
 * 记一次，后面直接走 https。
 */
const fetchBrokenUntil = new Map()
const FETCH_BROKEN_TTL_MS = 300_000

/**
 * 一次 GET。顺序：本机代理（开着 Clash 就走它，几百毫秒）→ 全局 fetch → https 直连。
 * 代理那一段是 2026-11-26 加的：hosts 劫持下直连必挂，境外反代一张要十来秒。
 */
async function getOnce(url, options = {}) {
  const host = hostOf(url)
  const proxy = options.proxy === null
    ? null
    : (options.proxy !== undefined ? options.proxy : await detectProxy(options.proxySetting))
  let proxyError = null
  if (proxy !== null) {
    try {
      return await requestViaProxy(proxy, url, {
        headers: options.headers,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      })
    } catch (error) {
      proxyError = codeOf(error)
    }
  }
  const now = Date.now()
  const brokenUntil = fetchBrokenUntil.get(host) ?? 0
  if (now < brokenUntil) {
    try {
      return await httpsGet(url, { headers: options.headers, timeoutMs: options.timeoutMs, signal: options.signal })
    } catch (second) {
      const error = new Error('https 直连也不通')
      error.code = 'transport-failed'
      error.first = 'skipped（该主机的 fetch 已标记不通）'
      error.second = codeOf(second)
      error.proxy = proxyError ?? 'none'
      throw error
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15_000)
  timer.unref?.()
  const signal = options.signal === undefined ? controller.signal : options.signal
  let firstError = null
  try {
    const response = await fetch(url, {
      headers: options.headers ?? {},
      redirect: 'manual',
      signal,
    })
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      body: response.body,
      via: 'fetch',
    }
  } catch (error) {
    firstError = error
  } finally {
    clearTimeout(timer)
  }
  try {
    const response = await httpsGet(url, { headers: options.headers, timeoutMs: options.timeoutMs, signal: options.signal })
    // 这条路通了：这个主机的 fetch 在本次进程里判死，5 分钟后再说。
    fetchBrokenUntil.set(host, Date.now() + FETCH_BROKEN_TTL_MS)
    return response
  } catch (second) {
    const error = new Error('两条路都不通')
    error.code = 'transport-failed'
    error.first = codeOf(firstError)
    error.second = codeOf(second)
    error.proxy = proxyError ?? 'none'
    throw error
  }
}

function codeOf(error) {
  if (error === null || error === undefined) return 'unknown'
  return String(error.code ?? error.cause?.code ?? error.name ?? error.message ?? 'unknown').slice(0, 60)
}

/**
 * 封面反代。
 *
 * 本机对 `image.civitai.com` 是**投毒 DNS + hosts 劫持到 127.0.0.1**（Steamcommunity 302 那份），
 * 宿主进程两条路都取不到图。实测 `images.weserv.nl` 能替我们取回来（它自己的短域名 `wsrv.nl` 反倒不通）。
 * 顺序：直连（干净网络下这一步就够，不经过第三方）→ 逐个反代。
 * 反代只取 192×256，正好盖住 96×128 的卡面。
 */
export const COVER_PROXIES = [
  // 反代只拿 256 宽的变体再缩到 192×256：上游那张图越小，反代回来得越快。
  (url) => 'https://images.weserv.nl/?url=' + encodeURIComponent(coverVariant(url, 256))
    + '&w=192&h=256&fit=cover&output=jpg&q=82',
]

/** 封面缓存：同一张图 10 分钟内不再走网络；浏览器那层有 etag，这层给翻页 / 切标签兜底。 */
const coverCache = new Map()
const COVER_CACHE_TTL_MS = 10 * 60_000
const COVER_CACHE_ITEMS = 96

function rememberCover(key, cover, useCache) {
  if (!useCache) return
  coverCache.set(key, { at: Date.now(), bytes: cover.bytes, mime: cover.mime })
  while (coverCache.size > COVER_CACHE_ITEMS) {
    const oldest = coverCache.keys().next().value
    coverCache.delete(oldest)
  }
}

/** 拉一张图：只认图片主机、https、最多 2 跳、单张 4 MB。 */
async function fetchCoverBytes(rawUrl, limit, options) {
  let current = String(rawUrl ?? '')
  let hops = 0
  let response = null
  for (;;) {
    let url
    try {
      url = new URL(current)
    } catch {
      throw coded('file-missing', '封面地址不合法')
    }
    if (url.protocol !== 'https:') throw coded('hub-host-blocked', '封面只走 https')
    if (!isImageHost(url.hostname)) throw coded('hub-host-blocked', '封面主机不在白名单：' + url.hostname)
    try {
      // 反代一次十几秒很正常，直连就没必要等这么久。
      response = await getOnce(url.href, { timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 12_000 })
    } catch (error) {
      throw coded('file-missing', url.hostname + ' 连不上（proxy ' + (error.proxy ?? '?') + ' / fetch ' + (error.first ?? '?') + ' / https ' + (error.second ?? '?') + '）')
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      hops += 1
      if (location === null || hops > 2) throw coded('file-missing', '封面重定向不可跟')
      current = new URL(location, url.href).href
      continue
    }
    break
  }
  if (!response.ok) throw coded('file-missing', '封面 HTTP ' + response.status)
  const type = String(response.headers.get('content-type') ?? '').toLowerCase()
  if (!type.startsWith('image/')) throw coded('file-missing', '封面不是图片：' + (type || '未知类型'))
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > limit) throw coded('file-missing', '封面超过 4 MB')
  const buffer = await readAll(response.body, limit)
  if (buffer.length === 0) throw coded('file-missing', '封面是空的')
  return { bytes: buffer, mime: type.split(';')[0] }
}

/**
 * 取封面：直连 + 反代依次试。
 * @param rawUrl - 原图地址。
 * @param options - `{ maxBytes, proxies, cache }`；`proxies: []` 关掉反代（桩测用）。
 * @returns `{ bytes, mime, proxy? }`。
 */
/** 同一个地址只飞一次：浏览器那 12 个并发请求＋后台预热会撞车，撞车就是两次反代。 */
const coverInflight = new Map()

export async function fetchCover(rawUrl, options = {}) {
  const limit = Number.isFinite(options.maxBytes) ? options.maxBytes : 4 * 1024 * 1024
  const raw = String(rawUrl ?? '')
  const useCache = options.cache !== false
  if (useCache) {
    const cached = coverCache.get(raw)
    if (cached !== undefined && Date.now() - cached.at < COVER_CACHE_TTL_MS) {
      return { bytes: cached.bytes, mime: cached.mime }
    }
    const running = coverInflight.get(raw)
    if (running !== undefined) return running
  }
  const task = fetchCoverFresh(raw, options, limit, useCache).finally(() => {
    if (coverInflight.get(raw) === task) coverInflight.delete(raw)
  })
  if (useCache) coverInflight.set(raw, task)
  return task
}

async function fetchCoverFresh(raw, options, limit, useCache) {
  // 白名单先判：反代只替白名单里的图取，别让它变成「拿外站地址洗一遍」的通道。
  let source
  try {
    source = new URL(raw)
  } catch {
    throw coded('file-missing', '封面地址不合法')
  }
  if (source.protocol !== 'https:') throw coded('hub-host-blocked', '封面只走 https')
  if (!isImageHost(source.hostname)) throw coded('hub-host-blocked', '封面主机不在白名单：' + source.hostname)
  const proxies = Array.isArray(options.proxies) ? options.proxies : COVER_PROXIES
  const reasons = []
  try {
    const direct = await fetchCoverBytes(source.href, limit, options)
    rememberCover(raw, direct, useCache)
    return direct
  } catch (error) {
    reasons.push(String(error?.message ?? error).slice(0, 90))
  }
  for (const build of proxies) {
    let proxied = ''
    try {
      proxied = build(source.href)
    } catch {
      continue
    }
    try {
      const cover = await fetchCoverBytes(proxied, limit, { ...options, timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 25_000 })
      rememberCover(raw, cover, useCache)
      return { ...cover, proxy: true }
    } catch (error) {
      reasons.push(String(error?.message ?? error).slice(0, 90))
    }
  }
  throw coded('file-missing', '封面取不到：' + reasons.join('；'))
}

/** 把 body 读完当 UTF-8 文本；超过上限就截断（错误页也要读得出来）。 */
async function readText(body, limit) {
  if (body === null || body === undefined) return ''
  const chunks = []
  let total = 0
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const remain = limit - total
    if (remain <= 0) break
    total += buffer.length
    chunks.push(buffer.length > remain ? buffer.subarray(0, remain) : buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 把 body 读完并卡上限；fetch 的 ReadableStream 与 https 的 IncomingMessage 都能 for-await。 */
async function readAll(body, limit) {
  if (body === null || body === undefined) return Buffer.alloc(0)
  const chunks = []
  let total = 0
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > limit) throw coded('file-missing', '封面超过 4 MB')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * 把 API 的一条 model 归一成页面吃的形状。
 * @param raw - `/api/v1/models` 里的一项。
 * @returns HubModel 或 null。
 */
export function normalizeModel(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const id = Number(raw.id)
  if (!Number.isFinite(id) || id <= 0) return null
  const type = String(raw.type ?? '')
  const suggested = categoryForType(type)
  const versions = (Array.isArray(raw.modelVersions) ? raw.modelVersions : [])
    .map((version) => normalizeVersion(version, suggested))
    .filter((version) => version !== null)
  const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {}
  const first = versions[0] ?? null
  return {
    id,
    name: String(raw.name ?? ('模型 ' + id)),
    type,
    typeLabel: TYPE_LABEL[type] ?? type ?? '未知',
    nsfw: raw.nsfw === true,
    creator: raw.creator && typeof raw.creator.username === 'string' ? raw.creator.username : null,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === 'string').slice(0, 12) : [],
    stats: {
      downloads: Number(stats.downloadCount ?? 0) || 0,
      thumbsUp: Number(stats.thumbsUpCount ?? 0) || 0,
      rating: Number(stats.rating ?? 0) || 0,
    },
    cover: first === null ? null : first.cover,
    // 详情页用：Civitai 给的是 HTML，这里先转纯文本（页面不做 HTML 注入）。
    description: htmlToText(raw.description),
    suggestedCategory: suggested,
    versions,
    url: 'https://civitai.red/models/' + String(id),
  }
}

function normalizeVersion(raw, suggested) {
  if (raw === null || typeof raw !== 'object') return null
  const id = Number(raw.id)
  if (!Number.isFinite(id) || id <= 0) return null
  const files = (Array.isArray(raw.files) ? raw.files : [])
    .map((file) => normalizeFile(file, id, suggested))
    .filter((file) => file !== null)
  // `find` 找不到返回的是 **undefined**，不是 null。真实 API 里「有 images 字段但全是
  // 没 url 的项」很常见（有的版本只挂了视频或已被下架），直接判 `=== null` 会抛
  // `Cannot read properties of undefined (reading 'url')`——页面就只剩一条红色 gateway 错误。
  const image = (Array.isArray(raw.images) ? raw.images.find((item) => item && typeof item.url === 'string') : null) ?? null
  return {
    id,
    name: String(raw.name ?? ('版本 ' + id)),
    baseModel: typeof raw.baseModel === 'string' ? raw.baseModel : null,
    trainedWords: Array.isArray(raw.trainedWords)
      ? raw.trainedWords.filter((word) => typeof word === 'string').slice(0, 24)
      : [],
    publishedAt: typeof raw.publishedAt === 'string' ? raw.publishedAt : null,
    description: htmlToText(raw.description),
    cover: image === null ? null : coverUrl(coverVariant(image.url)),
    files,
  }
}

function normalizeFile(raw, versionId, suggested) {
  if (raw === null || typeof raw !== 'object') return null
  const name = String(raw.name ?? '')
  if (name.length === 0) return null
  const sizeKB = Number(raw.sizeKB)
  const sha256 = raw.hashes && typeof raw.hashes.SHA256 === 'string' ? raw.hashes.SHA256.toLowerCase() : null
  return {
    name,
    sizeKB: Number.isFinite(sizeKB) ? Math.round(sizeKB * 100) / 100 : 0,
    sizeBytes: Number.isFinite(sizeKB) ? Math.round(sizeKB * 1024) : 0,
    format: raw.metadata && typeof raw.metadata.format === 'string' ? raw.metadata.format : null,
    primary: raw.primary === true,
    sha256,
    // 不信任 API 给的 downloadUrl 主机：统一重写成自己拼的那条。
    downloadUrl: API_ORIGIN + '/api/download/models/' + String(versionId),
    suggestedCategory: suggested,
  }
}

/**
 * 把「本地已有文件」打到搜索结果上：`model.installed` / `version.installed` / `file.installed`。
 * 本地名单来自扫盘（dirs.files），所以不管是不是这个插件下的都能认出来。
 */
export function markInstalled(models, installedNames) {
  const set = installedNames instanceof Set
    ? installedNames
    : new Set((Array.isArray(installedNames) ? installedNames : []).map((name) => String(name).toLowerCase()))
  for (const model of Array.isArray(models) ? models : []) {
    if (model === null || typeof model !== 'object' || !Array.isArray(model.versions)) continue
    for (const version of model.versions) {
      const files = Array.isArray(version.files) ? version.files : []
      for (const file of files) {
        const base = String(file?.name ?? '').split(/[\\/]/).pop().toLowerCase()
        file.installed = base.length > 0 && set.has(base)
      }
      version.installed = files.some((file) => file.installed === true)
    }
    model.installed = model.versions.some((version) => version.installed === true)
  }
  return models
}
/** 默认勾哪个文件：primary 且 SafeTensor → primary → 第一个。 */
export function pickDefaultFile(files) {
  if (!Array.isArray(files) || files.length === 0) return null
  return files.find((file) => file.primary === true && file.format === 'SafeTensor')
    ?? files.find((file) => file.primary === true)
    ?? files[0]
}

/**
 * 下载一个文件：手动跟 307、到 CDN 去 Authorization、流式吐块。
 *
 * @param versionId - 版本 id。
 * @param options - `{ token, signal, onChunk, onResponse, timeoutMs }`。
 * @returns `{ response, finalUrl }`
 */
export async function openDownload(versionId, options = {}) {
  const token = typeof options.token === 'string' ? options.token : ''
  // 续传用：调用方传 Range，逐跳都要带着（CDN 那跳去掉的只有 Authorization）。
  const extraHeaders = options.headers !== null && typeof options.headers === 'object' ? options.headers : null
  let current = API_ORIGIN + '/api/download/models/' + String(versionId)
  let hops = 0
  for (;;) {
    let url
    try {
      url = new URL(current)
    } catch {
      throw coded('hub-invalid-url', '下载地址不合法')
    }
    if (url.protocol !== 'https:') throw coded('hub-host-blocked', '下载只走 https：' + url.href)
    if (!isDownloadHost(url.hostname)) throw coded('hub-host-blocked', '下载主机不在白名单：' + url.hostname)
    const headers = extraHeaders === null ? {} : { ...extraHeaders }
    // 只有打 API 域才带凭据；R2 签名 URL 带 Bearer 会被拒。
    if (token.length > 0 && isApiHost(url.hostname)) headers.authorization = 'Bearer ' + token
    let response
    try {
      // 与封面同一条通道：先 fetch，抛了就 https 直连（宿主那个 fetch 对 CDN 也不稳）。
      response = await getOnce(url.href, { headers, signal: options.signal, timeoutMs: 30_000 })
    } catch (error) {
      if (options.signal?.aborted === true) throw coded('hub-download-failed', '已取消')
      throw coded(DOWNLOAD_FAILED, '下载连不上：' + url.hostname + '（fetch ' + (error.first ?? '?') + ' / https ' + (error.second ?? '?') + '）')
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      hops += 1
      if (location === null) throw coded('hub-host-blocked', '下载重定向没有 Location')
      if (hops > 3) throw coded('hub-host-blocked', '下载重定向超过 3 跳')
      current = new URL(location, url.href).href
      continue
    }
    if (response.status === 401 || response.status === 403) {
      throw coded('hub-key-missing', '这个模型要授权：HTTP ' + response.status + '（可能需要在 Civitai 同意模型条款）')
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '') || null
      throw coded('hub-rate-limited', 'Civitai 限流了' + (retryAfter === null ? '' : '，' + retryAfter + ' 秒后再试'))
    }
    if (!response.ok) throw coded(DOWNLOAD_FAILED, '下载返回 HTTP ' + response.status)
    return { response, finalUrl: current }
  }
}
