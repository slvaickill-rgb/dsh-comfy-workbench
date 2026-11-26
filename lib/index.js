/**
 * lib/index.js — 宿主半入口。
 *
 * 三件事：
 *   1. 注册 `dsh-comfy-workbench` 服务，按 typert 契约把 ENDPOINTS 里的业务方法暴露给页面
 *      （`ctx.remote.$mount` 之后页面拿 `remote['dsh-comfy-workbench']`）。
 *   2. 注册同源 HTTP `/dsh-comfy/*`（单个 prefix 路由内部分发），给页面与外部脚本用。
 *   3. 两个只读图片路由：产物 `/view`、画风库 `/catalog/view` 与 `/catalog/app/*`。
 *
 * 只硬依赖 `webServer`（web profile 必有）；`llm`、`workspaceRegistry` 一律
 * 通过 `ctx.get()` 软读——缺了照常起来，页面上给一句原因，不让整个插件塌。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { Service } from '@deepseek-ai/cordis'

import { createApi } from './api.js'
import { DEFAULT_COMFY_ROOT, realPath } from './dirs.js'
import { IMAGE_EXTENSIONS, resolveImage } from './gallery.js'
import { discover as discoverNsfw } from './nsfw.js'
import { readState } from './state.js'
import { resolveThinkingGif } from './thinkingAsset.js'
import { disposeThumbs, ensureThumb, thumbEntry } from './thumbs.js'

export const name = 'dsh-comfy-workbench'
export const inject = ['webServer']

/** HTTP 前缀；页面图片预览也走这里。 */
const ROUTE = '/dsh-comfy'

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}

/** 内嵌官方应用允许的静态资源扩展名。 */
const ASSET_EXTENSIONS = [
  '.html', '.htm', '.js', '.mjs', '.css', '.json', '.svg', '.png', '.jpg', '.jpeg',
  '.webp', '.gif', '.ico', '.woff', '.woff2', '.txt', '.csv', '.md', '.map',
]

const STATUS_BY_CODE = {
  'service-down': 503,
  'comfy-unreachable': 503,
  'workflow-missing': 404,
  'workflow-not-api': 404,
  'script-missing': 404,
  'workspace-not-found': 404,
  'path-outside-workspace': 403,
  'path-not-absolute': 422,
  'path-required': 422,
  'empty-prompt': 422,
  'image-required': 422,
  'model-missing': 422,
  'empty-input': 422,
  'prompt-required': 422,
  'workspace-unbound': 409,
  'mode-unsupported': 422,
  'llm-unavailable': 503,
  'llm-no-model': 503,
  'start-timeout': 504,
  'method-unknown': 404,
  'route-not-found': 404,
  'file-missing': 404,
  'body-invalid': 400,
  'body-too-large': 413,
  'not-loopback': 403,
  'gallery-root-missing': 404,
  'catalog-root-missing': 404,
  'catalog-root-invalid': 422,
  'catalog-unbound': 409,
  'preview-unavailable': 503,
  'preview-frame-missing': 404,
  'prompt-id-mismatch': 409,
  'save-target-invalid': 422,
  // 改写与「深度求索中」动图
  'asset-missing': 404,
  'asset-invalid': 422,
  'rewrite-empty': 422,
  'rewrite-invalid-output': 502,
  'rewrite-timeout': 504,
  'rewrite-conflict': 409,
  // Civitai 模型库（v1.6）
  'hub-key-missing': 401,
  'hub-key-file-invalid': 422,
  'hub-key-store-failed': 500,
  'hub-host-blocked': 403,
  'hub-api-error': 502,
  'hub-rate-limited': 429,
  'hub-invalid-url': 422,
  'hub-model-type-unsupported': 422,
  'hub-target-invalid': 422,
  'hub-file-exists': 409,
  'hub-size-exceeded': 413,
  'hub-hash-mismatch': 422,
  'hub-download-failed': 502,
  'hub-job-missing': 404,
  'hub-busy': 409,
  'hub-advice-invalid': 502,
  'hub-chat-empty': 422,
}

export function apply(ctx) {
  const api = createApi(ctx)

  // 服务行：类本身就是合法插件（构造器拿 ctx）。api 走闭包，不挂实例字段——
  // cordis 的 `new` 返回代理，往实例上写属性不保证跨代理可见。
  class ComfyWorkbench extends Service {
    constructor(context) {
      super(context, 'dsh-comfy-workbench')
      this.typertRemote = Object.freeze({
        service: this,
        serviceKey: 'dsh-comfy-workbench',
        namespace: 'dsh-comfy-workbench',
      })
    }

    probe(args) { return api.probe(args ?? {}) }

    dirs(args) { return api.dirs(args ?? {}) }

    models(args) { return api.models(args ?? {}) }

    complete(args) { return api.complete(args ?? {}) }

    workspace(args) { return api.workspace(args ?? {}) }

    workspaceBind(args) { return api.workspaceBind(args ?? {}) }

    submit(args) { return api.submit(args ?? {}) }

    generate(args) { return api.generate(args ?? {}) }

    job(args) { return api.job(args ?? {}) }

    serviceStart(args) { return api.serviceStart(args ?? {}) }

    serviceStop(args) { return api.serviceStop(args ?? {}) }

    config(args) { return api.config(args ?? {}) }

    gallery(args) { return api.gallery(args ?? {}) }

    nsfwStatus(args) { return api.nsfwStatus(args ?? {}) }

    nsfwScan(args) { return api.nsfwScan(args ?? {}) }

    catalog(args) { return api.catalog(args ?? {}) }

    catalogBind(args) { return api.catalogBind(args ?? {}) }

    workflows(args) { return api.workflows(args ?? {}) }

    preview(args) { return api.preview(args ?? {}) }

    stop(args) { return api.stop(args ?? {}) }

    saveImage(args) { return api.saveImage(args ?? {}) }

    upscale(args) { return api.upscale(args ?? {}) }

    rewritePlan(args) { return api.rewritePlan(args ?? {}) }

    rewriteApply(args) { return api.rewriteApply(args ?? {}) }

    rewriteCancel(args) { return api.rewriteCancel(args ?? {}) }

    hubStatus(args) { return api.hubStatus(args ?? {}) }

    hubKey(args) { return api.hubKey(args ?? {}) }

    hubSearch(args) { return api.hubSearch(args ?? {}) }

    hubResolve(args) { return api.hubResolve(args ?? {}) }

    hubDownload(args) { return api.hubDownload(args ?? {}) }

    hubJob(args) { return api.hubJob(args ?? {}) }

    hubCancel(args) { return api.hubCancel(args ?? {}) }

    hubAdvice(args) { return api.hubAdvice(args ?? {}) }

    hubChat(args) { return api.hubChat(args ?? {}) }
  }

  ctx.plugin(ComfyWorkbench)

  ctx.effect(
    () => () => {
      // 缩略图常驻子进程要跟着宿主一起收，别留孤儿 python。
      disposeThumbs()
      void api.dispose?.()
    },
    'dsh-comfy-workbench: close preview socket and thumbnail worker on unload',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: (req, res) => handleHttp(ctx, api, req, res),
    }),
    'dsh-comfy-workbench: same-origin http routes',
  )
}

/** JSON 应答，形状与 RemoteResult 对齐：`{ok:true,value}` / `{ok:false,error}`。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function failure(res, error) {
  const code = typeof error?.code === 'string' ? error.code : 'internal'
  const status = STATUS_BY_CODE[code] ?? 500
  sendJson(res, status, {
    ok: false,
    error: { code, message: error instanceof Error ? error.message : String(error) },
  })
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 4 * 1024 * 1024) throw Object.assign(new Error('请求体超过 4MB'), { code: 'body-too-large' })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'body-invalid' })
  }
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 产物预览：只认输出目录内的文件，文件名里带 `..` 一律不许。 */
async function serveImage(api, req, res, url) {
  const filename = url.searchParams.get('filename') ?? ''
  const subfolder = url.searchParams.get('subfolder') ?? ''
  if (filename.length === 0) throw Object.assign(new Error('缺 filename'), { code: 'path-required' })
  const root = await outputRoot(api)
  const target = path.resolve(root, subfolder, filename)
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('路径越界：' + target), { code: 'path-outside-workspace' })
  }
  const stat = statFile(target)
  if (stat === null) throw Object.assign(new Error('产物不存在：' + target), { code: 'file-missing' })
  // 产物文件名唯一、内容不再变：长缓存，翻页回看不重下几 MB。
  sendImageFile(req, res, target, stat, stat.mtimeMs, MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream', 604800)
}

/** stat 不到就 null，不抛。 */
function statFile(file) {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

/**
 * 流式发图 + ETag。
 *
 * 之前是 readFileSync 整张读进内存再 writeHead：一张 2.5 MB、一页 60 张，
 * 全压宿主事件循环上，DSH 的界面会跟着一起卡。createReadStream 只占管道缓冲。
 */
function sendImageFile(req, res, file, stat, etagSeed, type, maxAge) {
  const etag = '"' + String(etagSeed).replace(/[^A-Za-z0-9]/g, '') + '-' + String(stat.size) + '"'
  const headers = {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': 'private, max-age=' + String(maxAge),
    etag,
  }
  if (req.headers['if-none-match'] === etag) {
    // 304 不带 body，也不该带 content-length。
    res.writeHead(304, { 'cache-control': 'private, max-age=' + String(maxAge), etag })
    res.end()
    return
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = fs.createReadStream(file)
  stream.on('error', () => res.destroy())
  // 浏览器取消（翻页、关灯箱）时把文件句柄一起收掉。
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

/** 产物根缓存 5 秒：每张图请求都同步读一遍 config.json 没必要。 */
let configCache = { at: 0, value: null }

async function outputRoot(api) {
  if (configCache.value !== null && Date.now() - configCache.at < 5000) return configCache.value
  const state = await api.config({})
  const value = realPath(state.output || 'C:\\Comfyui output')
  configCache = { at: Date.now(), value }
  return value
}

/** 缩略图用的 python：ComfyUI .venv 里有 Pillow。一分钟探一次，探不到就不探。 */
let pythonProbe = null

function pythonForThumbs() {
  const now = Date.now()
  if (pythonProbe !== null && now < pythonProbe.until) return pythonProbe.value
  let value = null
  try {
    const info = discoverNsfw(readState().comfyRoot || DEFAULT_COMFY_ROOT)
    value = typeof info.python === 'string' ? info.python : null
  } catch {
    value = null
  }
  pythonProbe = { value, until: now + 60_000 }
  return value
}

/**
 * 图库缩略图。
 *
 * 网格 132 px 却加载 1024×1216 原图，是「打开图库就卡」的根源：
 * 一页 60 张 ≈ 65 MB 传输 + 300 MB 位图。这里发 320 px / 20 KB 的缓存小图。
 * 生成顺序：Electron nativeImage → Pillow 常驻进程 → 原图兜底。
 */
async function serveThumb(api, req, res, url) {
  const rel = url.searchParams.get('rel') ?? ''
  if (rel.length === 0) throw Object.assign(new Error('缺 rel'), { code: 'path-required' })
  const isCatalog = url.searchParams.get('source') === 'catalog'
  let root
  if (isCatalog) {
    const current = await api.catalogRoot()
    if (current.root === null) throw Object.assign(new Error('画风图库还没绑定：先点「绑定本地目录」'), { code: 'catalog-unbound' })
    root = current.root
  } else {
    root = await outputRoot(api)
  }
  const abs = resolveImage(root, rel)
  const stat = statFile(abs)
  if (stat === null || !stat.isFile()) {
    throw Object.assign(new Error('图片不存在：' + abs), { code: 'file-missing' })
  }
  const entry = thumbEntry(root, rel, stat)
  if (req.headers['if-none-match'] === '"' + entry.key + '"') {
    res.writeHead(304, { 'cache-control': 'private, max-age=604800', etag: '"' + entry.key + '"' })
    res.end()
    return
  }
  const cached = statFile(entry.file)
  if (cached !== null) {
    sendImageFile(req, res, entry.file, cached, entry.key, 'image/jpeg', 604800)
    return
  }
  const ok = await ensureThumb({ root, rel, abs, stat, python: pythonForThumbs() })
  if (ok) {
    const made = statFile(entry.file)
    if (made !== null) {
      sendImageFile(req, res, entry.file, made, entry.key, 'image/jpeg', 604800)
      return
    }
  }
  // 兜底发原图：缩略图生成不了也要能看图。
  sendImageFile(req, res, abs, stat, stat.mtimeMs, MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream', 60)
}

/**
 * 画风图库的只读图片 / 官方应用静态资源。
 * @param rel - 相对画风库根的路径（来自 `?rel=` 或 `/catalog/app/` 之后）。
 * @param assetsOnly - true 时按静态资源白名单；false 时只放图片。
 */
async function serveCatalogFile(api, req, res, rel, assetsOnly) {
  const current = await api.catalogRoot()
  if (current.root === null) {
    throw Object.assign(new Error('画风图库还没绑定：先点「绑定本地目录」'), { code: 'catalog-unbound' })
  }
  const target = resolveImage(current.root, rel)
  const ext = path.extname(target).toLowerCase()
  if (assetsOnly) {
    if (!ASSET_EXTENSIONS.includes(ext)) {
      throw Object.assign(new Error('不允许的静态资源类型：' + ext), { code: 'path-outside-workspace' })
    }
  } else if (!IMAGE_EXTENSIONS.includes(ext)) {
    throw Object.assign(new Error('不是图片：' + ext), { code: 'file-missing' })
  }
  if (!fs.existsSync(target)) {
    throw Object.assign(new Error('文件不存在：' + target), { code: 'file-missing' })
  }
  const stat = statFile(target)
  if (stat === null) throw Object.assign(new Error('文件不存在：' + target), { code: 'file-missing' })
  // 画风库是本地只读资源，内容不变：长缓存，翻页不重读。
  sendImageFile(req, res, target, stat, stat.mtimeMs, MIME[ext] ?? 'application/octet-stream', 604800)
}

/**
 * 逐步预览帧：只读内存缓冲，不碰磁盘。
 * `t` 是帧时间戳，浏览器缓存键带上它才不会拿到上一轮的旧图。
 */
async function servePreviewFrame(api, req, res, stepRaw) {
  const step = Number(stepRaw)
  if (!Number.isFinite(step) || step <= 0) {
    throw Object.assign(new Error('step 不合法：' + String(stepRaw)), { code: 'preview-frame-missing' })
  }
  const frame = await api.previewFrame({ step })
  res.writeHead(200, {
    'content-type': frame.mime,
    'content-length': frame.bytes.length,
    'cache-control': 'private, max-age=300',
  })
  res.end(req.method === 'HEAD' ? undefined : frame.bytes)
}

/**
 * 只读吐 `state.thinkingGif` 指向的 GIF。
 *
 * 渲染进程读不到本地路径，所以由宿主半开一条同源路由；不改原文件、不做透明化。
 * 路径 / 扩展名 / 大小 / magic 的校验在 lib/thinkingAsset.js，那边能脱离宿主单测。
 */
async function serveThinkingAsset(req, res) {
  const { file, stat } = resolveThinkingGif(readState().thinkingGif)
  sendImageFile(req, res, file, stat, stat.mtimeMs, 'image/gif', 300)
}

/**
 * Civitai 封面同源反代。
 *
 * 渲染进程的 `img-src` 未必放行 `image.civitai.com`（宿主已有 iframe 被 CSP 挡的先例），
 * 所以封面一律从这里出。主机白名单、https、重定向、大小限制都在 `lib/civitai.js` 里。
 */
async function serveHubCover(api, req, res, url) {
  const raw = url.searchParams.get('u') ?? ''
  if (raw.length === 0) throw Object.assign(new Error('缺 u'), { code: 'path-required' })
  const cover = await api.hubCover({ url: raw })
  const etag = '"' + createHash('sha1').update(cover.bytes).digest('hex').slice(0, 16) + '"'
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { 'cache-control': 'private, max-age=3600', etag })
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': cover.mime,
    'content-length': cover.bytes.length,
    'cache-control': 'private, max-age=3600',
    etag,
  })
  res.end(req.method === 'HEAD' ? undefined : cover.bytes)
}

async function handleHttp(ctx, api, req, res) {
  try {
    if (!isLoopback(req)) {
      sendJson(res, 403, { ok: false, error: { code: 'not-loopback', message: '只接受本机回环请求' } })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.slice(ROUTE.length).replace(/^\/+/, '')
    const method = req.method ?? 'GET'
    const GET = method === 'GET' || method === 'HEAD'

    if (route === 'view') {
      await serveImage(api, req, res, url)
      return
    }
    if (route === 'thumb' && GET) {
      await serveThumb(api, req, res, url)
      return
    }
    if (route === 'asset/thinking.gif' && GET) {
      await serveThinkingAsset(req, res)
      return
    }
    if (route.startsWith('preview/') && GET) {
      await servePreviewFrame(api, req, res, route.slice('preview/'.length))
      return
    }
    if (route === 'v1/preview' && GET) {
      const since = Number(url.searchParams.get('since') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? '')
      sendJson(res, 200, {
        ok: true,
        value: await api.preview({
          promptId: url.searchParams.get('promptId') ?? undefined,
          since: Number.isFinite(since) ? since : 0,
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        }),
      })
      return
    }
    if (route === 'hub/cover' && GET) {
      await serveHubCover(api, req, res, url)
      return
    }
    if (route === 'v1/hub/status' && GET) {
      sendJson(res, 200, { ok: true, value: await api.hubStatus({}) })
      return
    }
    if (route === 'v1/hub/job' && GET) {
      sendJson(res, 200, {
        ok: true,
        value: await api.hubJob({ token: url.searchParams.get('token') ?? undefined }),
      })
      return
    }
    if (route === 'catalog/view' && GET) {
      await serveCatalogFile(api, req, res, url.searchParams.get('rel') ?? '', false)
      return
    }
    if (route.startsWith('catalog/app/') && GET) {
      // 路径在 URL 里可能是编码过的（中文目录名、空格），先解一次。
      let rel = route.slice('catalog/app/'.length)
      try {
        rel = decodeURIComponent(rel)
      } catch {
        throw Object.assign(new Error('rel 编码不合法'), { code: 'path-required' })
      }
      await serveCatalogFile(api, req, res, rel, true)
      return
    }
    if (route === 'v1/health' && GET) {
      sendJson(res, 200, { ok: true, value: await api.probe({}) })
      return
    }
    if (route === 'v1/dirs' && GET) {
      sendJson(res, 200, { ok: true, value: await api.dirs({ refresh: url.searchParams.get('refresh') === '1' }) })
      return
    }
    if (route === 'v1/llm/models' && GET) {
      sendJson(res, 200, { ok: true, value: await api.models({}) })
      return
    }
    if (route === 'v1/job' && GET) {
      const wait = Number(url.searchParams.get('wait') ?? 0)
      sendJson(res, 200, {
        ok: true,
        value: await api.job({ promptId: url.searchParams.get('promptId') ?? '', waitMs: Number.isFinite(wait) ? wait : 0 }),
      })
      return
    }
    if (route === 'v1/workflows' && GET) {
      sendJson(res, 200, { ok: true, value: await api.workflows({ refresh: url.searchParams.get('refresh') === '1' }) })
      return
    }
    // 图库三支：查询参数同名，直接透传。
    if ((route === 'v1/gallery' || route === 'v1/catalog') && GET) {
      const limit = Number(url.searchParams.get('limit') ?? '')
      const cursor = Number(url.searchParams.get('cursor') ?? '')
      const args = {
        folder: url.searchParams.get('folder') ?? '',
        query: url.searchParams.get('q') ?? '',
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        cursor: Number.isFinite(cursor) && cursor >= 0 ? cursor : undefined,
        refresh: url.searchParams.get('refresh') === '1',
        includeHidden: url.searchParams.get('hidden') === '1',
        // 画风图库独有：按清单筛类型 / 分类；我的图库收到也只是忽略。
        kind: url.searchParams.get('kind') ?? '',
        category: url.searchParams.get('category') ?? '',
        // 我的图库独有：只看 NSFW / 只看常规。
        nsfw: url.searchParams.get('nsfw') ?? '',
      }
      const value = route === 'v1/gallery' ? await api.gallery(args) : await api.catalog(args)
      sendJson(res, 200, { ok: true, value })
      return
    }
    if (route === 'v1/nsfw' && GET) {
      sendJson(res, 200, { ok: true, value: await api.nsfwStatus({}) })
      return
    }
    if (route === 'v1/nsfw/scan' && method === 'POST') {
      sendJson(res, 200, { ok: true, value: await api.nsfwScan(await readBody(req)) })
      return
    }
    if (route === 'v1/catalog/bind' && method === 'POST') {
      sendJson(res, 200, { ok: true, value: await api.catalogBind(await readBody(req)) })
      return
    }
    if (route === 'v1/stop' && method === 'POST') {
      sendJson(res, 200, { ok: true, value: await api.stop(await readBody(req)) })
      return
    }
    if (route === 'v1/image/save' && method === 'POST') {
      sendJson(res, 200, { ok: true, value: await api.saveImage(await readBody(req)) })
      return
    }
    // 模型库：key 只收 POST body（不进 query），其余参数也一样。
    if (route === 'v1/hub/key' && method === 'POST') {
      sendJson(res, 200, { ok: true, value: await api.hubKey(await readBody(req)) })
      return
    }
    if (route === 'v1/hub/search' && method === 'POST') {
      sendJson(res, 200, { ok: true, value: await api.hubSearch(await readBody(req)) })
      return
    }
    if (route === 'v1/hub/resolve' && method === 'POST') {
      sendJson(res, 200, { ok: true, value: await api.hubResolve(await readBody(req)) })
      return
    }
    if (route === 'v1/hub/download' && method === 'POST') {
      sendJson(res, 200, { ok: true, value: await api.hubDownload(await readBody(req)) })
      return
    }
    if (route === 'v1/hub/cancel' && method === 'POST') {
      sendJson(res, 200, { ok: true, value: await api.hubCancel(await readBody(req)) })
      return
    }
    if (route === 'v1/hub/advice' && method === 'POST') {
      sendJson(res, 200, { ok: true, value: await api.hubAdvice(await readBody(req)) })
      return
    }
    if (route === 'v1/llm/complete' && method === 'POST') {
      sendJson(res, 200, { ok: true, value: await api.complete(await readBody(req)) })
      return
    }
    if (route === 'v1/rewrite/plan' && method === 'POST') {
      sendJson(res, 200, { ok: true, value: await api.rewritePlan(await readBody(req)) })
      return
    }
    if (route === 'v1/rewrite/apply' && method === 'POST') {
      sendJson(res, 200, { ok: true, value: await api.rewriteApply(await readBody(req)) })
      return
    }
    if (route === 'v1/rewrite/cancel' && method === 'POST') {
      sendJson(res, 200, { ok: true, value: await api.rewriteCancel(await readBody(req)) })
      return
    }
    if (route === 'v1/workspace/submit' && method === 'POST') {
      sendJson(res, 200, { ok: true, value: await api.submit(await readBody(req)) })
      return
    }
    if (route === 'v1/generate' && method === 'POST') {
      sendJson(res, 200, { ok: true, value: await api.generate(await readBody(req)) })
      return
    }
    if (route === 'v1/upscale' && method === 'POST') {
      sendJson(res, 200, { ok: true, value: await api.upscale(await readBody(req)) })
      return
    }
    if (route === 'v1/service/start' && method === 'POST') {
      sendJson(res, 200, { ok: true, value: await api.serviceStart({}) })
      return
    }
    if (route === 'v1/service/stop' && method === 'POST') {
      sendJson(res, 200, { ok: true, value: await api.serviceStop(await readBody(req)) })
      return
    }
    if (route === 'v1/call' && method === 'POST') {
      const body = await readBody(req)
      const name = String(body.method ?? '')
      if (typeof api[name] !== 'function') {
        throw Object.assign(new Error('没有这个方法：' + name), { code: 'method-unknown' })
      }
      sendJson(res, 200, { ok: true, value: await api[name](body.args ?? {}) })
      return
    }
    sendJson(res, 404, { ok: false, error: { code: 'route-not-found', message: '没有这条路由：' + url.pathname } })
  } catch (error) {
    failure(res, error)
  }
}
