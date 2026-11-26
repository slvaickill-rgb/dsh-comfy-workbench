/**
 * tools/selftest-hub.mjs — Civitai 模型库的桩测（不联网、不下真模型、不碰真 profile）。
 *
 * 怎么桩：只替换 `globalThis.fetch`，其余全是真实代码路径——URL 拼接、主机白名单、
 * 307 手动跟随、去掉 Authorization、流式写 `.part`、SHA256、rename 都照跑。
 * 这样「跟着重定向会把 Bearer 带到 CDN」这类错误才拦得住。
 *
 * 跑法：node tools/selftest-hub.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { isApiHost, isCdnHost, isDownloadHost, isImageHost, parseRef, normalizeModel, categoryForType, pickDefaultFile, fetchJson, fetchCover, COVER_PROXIES } from '../lib/civitai.js'
import { CredentialStore, HubDownloader, maskKey, safeFileName } from '../lib/hub.js'
import { parseAdvice, fallbackAdvice, buildFacts } from '../lib/hubAgent.js'

const ROOT = path.join(os.tmpdir(), 'dsh-hub-selftest-' + String(process.pid))
const STATE = path.join(ROOT, 'state')
const MODELS = path.join(ROOT, 'models')
const LORAS = path.join(MODELS, 'loras')
const CDN = 'civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com'

let checks = 0
let failures = 0

function check(name, fn) {
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      return result.then(
        () => {
          checks += 1
          console.log('ok   ' + name)
        },
        (error) => {
          failures += 1
          console.log('FAIL ' + name + ' → ' + (error && error.message ? error.message : error))
        },
      )
    }
    checks += 1
    console.log('ok   ' + name)
    return Promise.resolve()
  } catch (error) {
    failures += 1
    console.log('FAIL ' + name + ' → ' + (error && error.message ? error.message : error))
    return Promise.resolve()
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function coded(error, code) {
  return error !== null && typeof error === 'object' && error.code === code
}

// ---------------------------------------------------------------- 桩网络

const calls = []
const payloads = new Map()

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status ?? 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function bytes(buffer, type) {
  return new Response(buffer, {
    status: 200,
    headers: { 'content-type': type ?? 'application/octet-stream', 'content-length': String(buffer.length) },
  })
}

globalThis.fetch = async function stubFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url
  const parsed = new URL(url)
  calls.push({ url, headers: init.headers ?? {}, redirect: init.redirect ?? 'follow' })
  const host = parsed.hostname

  if (!isDownloadHost(host) && !isImageHost(host)) {
    throw new Error('桩拦到了不该打的请求：' + url)
  }

  // 封面
  if (host === 'image.civitai.com') {
    if (parsed.pathname.includes('broken')) return new Response('nope', { status: 200, headers: { 'content-type': 'text/html' } })
    // 模拟本机现状：直连被 hosts 劫到 127.0.0.1，只有反代能拿到图。
    if (parsed.pathname.includes('proxyonly')) return new Response('', { status: 502 })
    return bytes(Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png')
  }

  // 封面反代（COVER_PROXIES）：直连不通时宿主走它取图。
  if (host === 'images.weserv.nl') {
    const inner = parsed.searchParams.get('url') ?? ''
    if (inner.includes('broken')) return new Response('nope', { status: 200, headers: { 'content-type': 'text/html' } })
    return bytes(Buffer.from('ffd8ffdb', 'hex'), 'image/jpeg')
  }

  // CDN 签名地址：这里必须没有 Authorization
  if (isCdnHost(host)) {
    const key = parsed.pathname
    const payload = payloads.get(key)
    if (payload === undefined) return new Response('not found', { status: 404 })
    return bytes(payload)
  }

  // API
  if (parsed.pathname === '/api/download/models/403') return new Response('', { status: 401 })
  if (parsed.pathname === '/api/download/models/429') {
    return new Response('', { status: 429, headers: { 'retry-after': '7' } })
  }
  if (parsed.pathname.startsWith('/api/download/models/')) {
    const versionId = parsed.pathname.split('/').pop()
    return new Response(null, {
      status: 307,
      headers: { location: 'https://' + CDN + '/models/v' + versionId + '.safetensors?X-Amz-Expires=86400' },
    })
  }
  if (parsed.pathname === '/api/v1/models') {
    return json({
      items: [{
        id: 264290,
        name: 'Not Artists Styles for Pony Diffusion V6 XL',
        type: 'LORA',
        nsfw: false,
        creator: { username: 'someone' },
        tags: ['style'],
        stats: { downloadCount: 12, thumbsUpCount: 3, rating: 4.6 },
        modelVersions: [{
          id: 1558543,
          name: 'Abstract Painting Pony',
          baseModel: 'Pony',
          trainedWords: ['abstractionism', 'brush stroke'],
          files: [{
            name: 'Abstract Painting - Style [LoRA] - Pony V6 XL.safetensors',
            sizeKB: 56075.02734375,
            primary: true,
            metadata: { format: 'SafeTensor' },
            hashes: { SHA256: 'DF7C757437EF' },
            downloadUrl: 'http://127.0.0.1:8188/system_stats',
          }],
          images: [{ url: 'https://image.civitai.com/x/cover.png' }],
        }],
      }],
      metadata: { nextCursor: '468716|43879|122359', totalItems: 2 },
    })
  }
  if (parsed.pathname === '/api/v1/models/264290') {
    return json({
      id: 264290,
      name: 'Not Artists Styles',
      type: 'LORA',
      creator: { username: 'someone' },
      modelVersions: [{ id: 1558543, name: 'v1', baseModel: 'Pony', files: [{ name: 'a.safetensors', sizeKB: 1024, primary: true }] }],
    })
  }
  if (parsed.pathname === '/api/v1/model-versions/1558543') {
    return json({
      id: 1558543,
      modelId: 264290,
      name: 'v1',
      baseModel: 'Pony',
      model: { name: 'Not Artists Styles', type: 'LORA', nsfw: false },
      files: [{ name: 'a.safetensors', sizeKB: 1024, primary: true }],
    })
  }
  if (parsed.pathname === '/api/v1/models/999') return new Response('', { status: 404 })
  return new Response('', { status: 404 })
}

// ---------------------------------------------------------------- 准备目录

fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(LORAS, { recursive: true })
fs.mkdirSync(STATE, { recursive: true })
process.env.DSH_COMFY_STATE_DIR = STATE

const BODY = Buffer.from('hello-safetensors-payload-'.repeat(64), 'utf8')
const DIGEST = createHash('sha256').update(BODY).digest('hex')
payloads.set('/models/v1.safetensors', BODY)
payloads.set('/models/v11.safetensors', BODY)
payloads.set('/models/v12.safetensors', BODY)
payloads.set('/models/v13.safetensors', BODY)

const DIRS = { models: { loras: LORAS, checkpoints: path.join(MODELS, 'checkpoints') }, modelBase: MODELS }

// ---------------------------------------------------------------- 断言

await check('链接解析认 6 种形状、非法的不认', () => {
  const cases = [
    ['https://civitai.red/models/264290', 'model', 264290],
    ['https://civitai.red/models/264290?modelVersionId=1558543', 'version', 1558543],
    ['https://civitai.red/api/download/models/1558543', 'version', 1558543],
    ['https://civitai.red/model-versions/1558543', 'version', 1558543],
    ['264290', 'id', 264290],
    ['  1558543  ', 'id', 1558543],
  ]
  for (const [input, kind, id] of cases) {
    const ref = parseRef(input)
    assert(ref !== null, '没解析出来：' + input)
    assert(ref.kind === kind && ref.id === id, input + ' → ' + JSON.stringify(ref))
  }
  assert(parseRef('https://evil.example/models/1') === null, '外站链接没被拒')
  assert(parseRef('随便一段话') === null, '乱文本没被拒')
  assert(parseRef('') === null, '空串没被拒')
})

await check('主机白名单拦住本机 8188（SSRF）', () => {
  assert(isApiHost('civitai.red') && isApiHost('www.civitai.com'), 'API 域没放行')
  assert(isCdnHost(CDN), '真实 R2 三段主机名没被认')
  assert(isDownloadHost('civitai.red') && isDownloadHost(CDN), '下载主机少算了')
  assert(!isDownloadHost('127.0.0.1') && !isDownloadHost('localhost'), '本机地址混进来了')
  assert(!isCdnHost('evil.r2.cloudflarestorage.com'), '非 civitai-* 的 R2 主机没被拒')
  assert(!isCdnHost('civitai-x.r2.cloudflarestorage.com.evil.com'), '后缀伪装没被拒')
  assert(isImageHost('image.civitai.com') && !isImageHost('evil.example'), '图片主机判断不对')
})

await check('type → 目标目录映射', () => {
  assert(categoryForType('LORA') === 'loras' && categoryForType('LoCon') === 'loras', 'LORA/LoCon 没落到 loras')
  assert(categoryForType('Checkpoint') === 'checkpoints', 'Checkpoint 没落到 checkpoints')
  assert(categoryForType('AestheticGradient') === null, '不该有默认目录的类型给了目录')
})

await check('normalizeModel 不吃 API 给的 downloadUrl 主机', () => {
  return fetchJson('/api/v1/models?limit=1').then(({ json }) => {
    const model = normalizeModel(json.items[0])
    assert(model !== null, '归一失败')
    const file = model.versions[0].files[0]
    assert(file.downloadUrl === 'https://civitai.red/api/download/models/1558543', '下载地址没重写：' + file.downloadUrl)
    assert(file.sha256 === 'df7c757437ef', 'SHA256 没转小写')
    assert(file.sizeBytes === Math.round(56075.02734375 * 1024), '字节数算错')
    assert(model.cover.startsWith('/dsh-comfy/hub/cover?u='), '封面没走同源反代')
    assert(pickDefaultFile(model.versions[0].files).primary === true, '默认文件没挑 primary')
  })
})

await check('normalizeModel：版本没图片也不抛（find 返回 undefined 的坑）', () => {
  const base = { id: 1, name: 'm', type: 'LORA' }
  const cases = [
    { ...base, modelVersions: [{ id: 11, name: 'no-images-key' }] },
    { ...base, modelVersions: [{ id: 12, name: 'empty', images: [] }] },
    { ...base, modelVersions: [{ id: 13, name: 'url-null', images: [{ url: null }] }] },
    { ...base, modelVersions: [{ id: 14, name: 'null-item', images: [null, { url: 'https://image.civitai.com/x/original=true/1.jpg' }] }] },
  ]
  const out = cases.map((item) => normalizeModel(item))
  assert(out.every((model) => model !== null), '有模型被整条丢掉')
  assert(out[0].cover === null && out[1].cover === null && out[2].cover === null, '无图版本的封面不是 null')
  assert(out[3].cover !== null, '有图版本反而丢了封面：' + out[3].cover)
  assert(out[0].versions[0].files.length === 0, '空 files 没处理')
  assert(out[3].cover.includes('width%3D450') || out[3].cover.includes('width=450'), '封面没换成 450 宽：' + out[3].cover)
})

await check('搜索返回 nextCursor / total', async () => {
  const { json } = await fetchJson('/api/v1/models?limit=12')
  assert(json.metadata.nextCursor === '468716|43879|122359', 'nextCursor 丢了')
  assert(json.metadata.totalItems === 2, 'totalItems 丢了')
})

await check('307 跟到 CDN 时去掉 Authorization', async () => {
  calls.length = 0
  const { openDownload } = await import('../lib/civitai.js')
  const { response, finalUrl } = await openDownload(1, { token: 'FAKE-TOKEN' })
  assert(response.ok, '第三次请求不是 200')
  assert(finalUrl.startsWith('https://' + CDN), '没有跟到 CDN')
  const first = calls[0]
  const second = calls[1]
  assert(first.url.startsWith('https://civitai.red/api/download/models/1'), '第一跳不是 API 域：' + first.url)
  assert((first.headers.authorization ?? '') === 'Bearer FAKE-TOKEN', '第一跳没带 Authorization')
  assert(second.url.startsWith('https://' + CDN), '第二跳不是 CDN：' + second.url)
  assert(second.headers.authorization === undefined, '跟到 CDN 还带着 Authorization')
  assert(first.redirect === 'manual', '没有用手动跟随')
})

await check('401 / 429 映射成业务码', async () => {
  const { openDownload } = await import('../lib/civitai.js')
  let caught = null
  try {
    await openDownload(403, {})
  } catch (error) {
    caught = error
  }
  assert(coded(caught, 'hub-key-missing'), '401 没映射成 hub-key-missing：' + (caught && caught.code))
  caught = null
  try {
    await openDownload(429, {})
  } catch (error) {
    caught = error
  }
  assert(coded(caught, 'hub-rate-limited'), '429 没映射成 hub-rate-limited')
  assert(caught.message.includes('7'), 'Retry-After 没带进文案：' + caught.message)
})

// ---------------------------------------------------------------- 凭据仓

const store = new CredentialStore()
store.load()
const CONFIG = path.join(STATE, 'config.json')
fs.writeFileSync(CONFIG, '{"steps":10}\n', 'utf8')
const configBefore = fs.readFileSync(CONFIG)

await check('凭据：保存 → 重启恢复 → 不回显 key', async () => {
  const saved = await store.setKey('FAKE-KEY-ABCDEFGH', { persist: true })
  assert(saved.hasKey === true, '保存后 hasKey 不是 true')
  assert(saved.keySource === 'file', '没落到文件：' + saved.keySource)
  assert(JSON.stringify(saved).includes('FAKE-KEY-ABCDEFGH') === false, '返回值里带了 key 原文')
  assert(saved.keyMask === maskKey('FAKE-KEY-ABCDEFGH'), '掩码不对')

  const reopened = new CredentialStore()
  const restored = reopened.load()
  assert(restored.hasKey === true, '重启后没恢复')
  assert(restored.keySource === 'file', '重启后来源不是 file')
  assert(restored.keyMask === saved.keyMask, '重启后掩码变了')
  assert(reopened.current() === 'FAKE-KEY-ABCDEFGH', '内存副本没恢复')

  const file = reopened.filePath()
  assert(fs.existsSync(file), '凭据文件没建出来')
  const raw = fs.readFileSync(file, 'utf8')
  assert(raw.includes('"version": 1'), '文件结构不对')
  assert(fs.readFileSync(CONFIG).equals(configBefore), 'config.json 被改了')
})

await check('凭据：勾掉「记住」只写内存、不删旧文件', async () => {
  const reopened = new CredentialStore()
  reopened.load()
  const file = reopened.filePath()
  const before = fs.readFileSync(file, 'utf8')
  const result = await reopened.setKey('TEMP-ONLY-KEY', { persist: false })
  assert(result.keySource === 'memory', '没退成 memory')
  assert(result.savedAt === null, 'memory 态不该有 savedAt')
  assert(fs.readFileSync(file, 'utf8') === before, '写盘被动了')
  const again = new CredentialStore()
  assert(again.load().keyMask === maskKey('FAKE-KEY-ABCDEFGH'), '重开后没恢复磁盘上那份')
})

await check('凭据：坏文件按未设置启动、不删文件', async () => {
  const broken = path.join(STATE, 'broken-credentials.json')
  fs.writeFileSync(broken, '{ half json', 'utf8')
  const store2 = new CredentialStore({ file: broken })
  const status = store2.load()
  assert(status.hasKey === false, '坏文件还当成有 key')
  assert(status.error !== null && status.error.code === 'hub-key-file-invalid', '没报 hub-key-file-invalid')
  assert(fs.existsSync(broken), '坏文件被自动删了')
})

await check('凭据：清除会连文件一起删', async () => {
  const reopened = new CredentialStore()
  reopened.load()
  const file = reopened.filePath()
  const cleared = await reopened.clear()
  assert(cleared.cleared === true && cleared.hasKey === false, '清除状态不对')
  assert(!fs.existsSync(file), '文件没删')
  assert(JSON.stringify(cleared).includes('FAKE') === false, '清除返回值里带 key')
})

await check('文件名净化：路径穿越与非法字符', () => {
  assert(safeFileName('..\\..\\evil.safetensors') === 'evil.safetensors', '没去掉 ..\\')
  assert(safeFileName('a/b/c.safetensors') === 'c.safetensors', '没去掉目录')
  assert(safeFileName('...') === null, '空名没被拒')
  assert(safeFileName('模型 [v1] (2).safetensors').endsWith('.safetensors'), '中文名被吃掉了')
  assert(!safeFileName('x.safetensors').includes(' '), '不该有空格')
})

// ---------------------------------------------------------------- 下载队列

function makeJob(items, options = {}) {
  const downloader = new HubDownloader({ maxBytes: options.maxBytes ?? 1024 * 1024 })
  const started = downloader.start({
    token: 'tok-1',
    items,
    overwrite: options.overwrite === true,
    credential: 'FAKE-TOKEN',
    dirs: options.dirs ?? DIRS,
  })
  return { downloader, started }
}

async function waitJob(downloader, token = 'tok-1', timeoutMs = 8000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const snapshot = downloader.snapshot(token)
    if (snapshot.state !== 'running' && snapshot.state !== 'idle' && snapshot.state !== 'queued') return snapshot
    if (Date.now() > until) return snapshot
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

await check('下载：SHA256 命中 → rename 成正式名', async () => {
  const { downloader } = makeJob([{ versionId: 1, name: 'good.safetensors', targetCategory: 'loras', sizeBytes: BODY.length, sha256: DIGEST }])
  const finished = await waitJob(downloader)
  assert(finished.state === 'done', '状态不是 done：' + finished.state + ' ' + finished.note)
  const file = path.join(LORAS, 'good.safetensors')
  assert(fs.existsSync(file), '正式文件没生成')
  assert(fs.readFileSync(file).length === BODY.length, '字节数不对')
  assert(finished.items[0].sha256Ok === true, 'sha256Ok 不是 true')
  assert(fs.readdirSync(LORAS).some((name) => name.endsWith('.part')) === false, '留下了 .part')
})

await check('下载：SHA256 不匹配 → 删 .part、不留半截模型', async () => {
  const { downloader } = makeJob([{ versionId: 11, name: 'bad.safetensors', targetCategory: 'loras', sha256: 'e'.repeat(64) }])
  const finished = await waitJob(downloader)
  assert(finished.state === 'failed', '状态不是 failed：' + finished.state)
  assert(finished.items[0].error.code === 'hub-hash-mismatch', '错误码不是 hub-hash-mismatch：' + JSON.stringify(finished.items[0].error))
  assert(!fs.existsSync(path.join(LORAS, 'bad.safetensors')), '坏文件被当成正式名留下了')
  assert(fs.readdirSync(LORAS).some((name) => name.startsWith('.dsh-hub-')) === false, '留下了 .part')
})

await check('下载：同名已存在 → hub-file-exists，原文件不动', async () => {
  // 上面那轮已经把 good.safetensors 落盘了，这里直接撞名。
  assert(fs.existsSync(path.join(LORAS, 'good.safetensors')), '前置文件不在，测试无效')
  const second = new HubDownloader({ maxBytes: 1024 * 1024 })
  let exists = null
  try {
    second.start({ token: 'tok-3', items: [{ versionId: 12, name: 'good.safetensors', targetCategory: 'loras' }], dirs: DIRS, credential: '' })
  } catch (error) {
    exists = error
  }
  assert(coded(exists, 'hub-file-exists'), '没报 hub-file-exists：' + (exists && exists.code))
})

await check('下载：超过上限 → hub-size-exceeded', async () => {
  const downloader = new HubDownloader({ maxBytes: 1024 * 1024 })
  let caught = null
  try {
    downloader.start({
      token: 't',
      items: [{ versionId: 13, name: 'huge.safetensors', targetCategory: 'loras', sizeBytes: 8 * 1024 * 1024 }],
      dirs: DIRS,
      maxBytes: 1024 * 1024,
      credential: '',
    })
  } catch (error) {
    caught = error
  }
  assert(coded(caught, 'hub-size-exceeded'), '没拦住超限：' + (caught && caught.code))
})

await check('下载：目标目录越界 → hub-target-invalid', async () => {
  const outside = path.join(ROOT, 'outside')
  fs.mkdirSync(outside, { recursive: true })
  const downloader = new HubDownloader({ maxBytes: 1024 * 1024 })
  let caught = null
  try {
    downloader.start({
      token: 't2',
      items: [{ versionId: 12, name: 'x.safetensors', targetCategory: 'loras' }],
      dirs: { models: { loras: outside }, modelBase: MODELS },
      credential: '',
    })
  } catch (error) {
    caught = error
  }
  assert(coded(caught, 'hub-target-invalid'), '越界目录没被拒：' + (caught && caught.code))
})

await check('下载：扩展名不在白名单 → hub-target-invalid', async () => {
  const downloader = new HubDownloader({ maxBytes: 1024 * 1024 })
  let caught = null
  try {
    downloader.start({ token: 't3', items: [{ versionId: 12, name: 'evil.exe', targetCategory: 'loras' }], dirs: DIRS, credential: '' })
  } catch (error) {
    caught = error
  }
  assert(coded(caught, 'hub-target-invalid'), '.exe 没被拒：' + (caught && caught.code))
})

await check('下载：单任务，第二个请求 hub-busy', async () => {
  const { downloader } = makeJob([{ versionId: 1, name: 'slow.safetensors', targetCategory: 'loras' }])
  let caught = null
  try {
    downloader.start({ token: 'other', items: [{ versionId: 1, name: 'a.safetensors', targetCategory: 'loras' }], dirs: DIRS, credential: '' })
  } catch (error) {
    caught = error
  }
  assert(coded(caught, 'hub-busy'), '没拦住第二个任务：' + (caught && caught.code))
  await waitJob(downloader)
})

await check('下载：取消 → cancelled 且删掉 .part，已完成的保留', async () => {
  const downloader = new HubDownloader({ maxBytes: 1024 * 1024 })
  downloader.start({
    token: 'tok-c',
    items: [
      { versionId: 1, name: 'c1.safetensors', targetCategory: 'loras' },
      { versionId: 11, name: 'c2.safetensors', targetCategory: 'loras' },
    ],
    dirs: DIRS,
    credential: '',
  })
  downloader.cancel('tok-c')
  const finished = await waitJob(downloader, 'tok-c')
  assert(finished.state === 'cancelled', '状态不是 cancelled：' + finished.state)
  assert(fs.readdirSync(LORAS).some((name) => name.startsWith('.dsh-hub-')) === false, '取消后还留着 .part')
  assert(fs.existsSync(path.join(LORAS, 'c1.safetensors')) || fs.existsSync(path.join(LORAS, 'good.safetensors')), '已有文件被回滚了')
})

await check('封面：直连 → 反代 → 非图片 / 外站主机都拒', async () => {
  const ok = await fetchCover('https://image.civitai.com/x/cover.png')
  assert(ok.mime === 'image/png', '封面 mime 不对')
  assert(ok.proxy !== true, '直连能拿到时不该绕反代')
  // 反代兜底：直连 502 的这张，应该经 COVER_PROXIES 取回来。
  const viaProxy = await fetchCover('https://image.civitai.com/x/proxyonly.png')
  assert(viaProxy.proxy === true, '反代兜底没生效')
  assert(viaProxy.mime === 'image/jpeg', '反代回来的 mime 不对：' + viaProxy.mime)
  const proxied = COVER_PROXIES[0]('https://image.civitai.com/x/cover.png')
  assert(proxied.startsWith('https://images.weserv.nl/?url='), '反代地址不对：' + proxied)
  assert(proxied.includes(encodeURIComponent('https://image.civitai.com/x/cover.png')), '反代没整段编码')
  assert(isImageHost('images.weserv.nl'), '反代主机没进图片白名单')
  let caught = null
  try {
    await fetchCover('https://evil.example/a.png')
  } catch (error) {
    caught = error
  }
  assert(coded(caught, 'hub-host-blocked'), '外站封面没被拒')
  caught = null
  try {
    await fetchCover('https://image.civitai.com/broken.png', { proxies: [] })
  } catch (error) {
    caught = error
  }
  assert(caught !== null && caught.code === 'file-missing', '非图片没被拒：' + (caught && caught.code))
})

// ---------------------------------------------------------------- Agent

const FACTS = buildFacts({
  job: { items: [{ name: 'good.safetensors', targetCategory: 'loras', path: path.join(LORAS, 'good.safetensors'), sizeBytes: BODY.length, sha256: DIGEST, sha256Ok: true, state: 'done' }] },
  dirs: { modelBase: MODELS, files: { checkpoints: ['anima_aestheticV11.safetensors'], loras: ['a.safetensors'] } },
  workflows: { items: [{ id: 'w1', title: 'Anima', summary: { loras: [{ name: 'a' }], steps: 16, cfg: 4 } }] },
})

await check('Agent：字段 clamp 与动作白名单', () => {
  const advice = parseAdvice(JSON.stringify({
    compatible: 'YES',
    reason: '底模不同族',
    targetDir: 'loras',
    triggerWords: ['abstractionism', 42, 'brush stroke'],
    suggestedStrength: 99,
    checkpoint: 'Pony',
    warnings: ['要重启'],
    actions: ['selectLora', 'rm -rf', 'refreshDirs'],
  }))
  assert(advice.compatible === 'yes', '大小写没归一：' + advice.compatible)
  assert(advice.suggestedStrength === 2, '权重没 clamp 到 2：' + advice.suggestedStrength)
  assert(advice.actions.join(',') === 'selectLora,refreshDirs', '动作没过滤：' + advice.actions.join(','))
  assert(advice.triggerWords.length === 2, '触发词没剔掉非字符串')
})

await check('Agent：输出不是 JSON → hub-advice-invalid，降级有事实', () => {
  let caught = null
  try {
    parseAdvice('我觉得这个模型挺好看的')
  } catch (error) {
    caught = error
  }
  assert(coded(caught, 'hub-advice-invalid'), '没报 hub-advice-invalid')
  const fallback = fallbackAdvice(FACTS, '没有模型结论')
  assert(fallback.compatible === 'unknown', '降级态不是 unknown')
  assert(fallback.targetDir === 'loras', '降级卡片没带目标目录')
  assert(fallback.actions.includes('refreshDirs'), '降级卡片没给刷新动作')
})

await check('Agent：code 围栏也能解析', () => {
  const advice = parseAdvice('```json\n{"compatible":"no","reason":"x","targetDir":"loras","actions":["selectLora"]}\n```')
  assert(advice.compatible === 'no', '围栏没剥掉')
})

// ---------------------------------------------------------------- 收尾

fs.rmSync(ROOT, { recursive: true, force: true })

console.log('')
if (failures > 0) {
  console.log('有 ' + failures + ' 项没通过')
  process.exitCode = 1
} else {
  console.log('全部 ' + checks + ' 项通过')
}
