/**
 * lib/comfy.js — ComfyUI 8188 的 HTTP 客户端与工作流装配。
 *
 * 协议只做本机实际用到的那几条：`/system_stats`、`/object_info`、`/prompt`、
 * `/history/{id}`、`/view`、`/queue`、`/interrupt`、`/api/jobs/{id}/cancel`。
 *
 * WebSocket 不在这里：逐步预览的连接、帧解析与缓冲在 `lib/preview.js`，
 * 两边的交界只有「同一个 client_id」和「同一个 prompt_id」。
 */

import fs from 'node:fs'
import path from 'node:path'

const REQUEST_TIMEOUT_MS = 30_000

/** 本机默认的出图工作流（comfyui-anima 技能里那份底模档）。 */
export function defaultWorkflowFile() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return path.join(home, '.workbuddy', 'skills', 'comfyui-anima', 'workflows', 'Anima Aesthetic v1.1.api.json')
}

async function request(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    if (!response.ok) {
      const error = new Error('HTTP ' + response.status + ' ' + url + (text ? ' — ' + text.slice(0, 400) : ''))
      error.status = response.status
      throw error
    }
    if (text.length === 0) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 列可用的 API 版工作流（`*.api.json`）。 */
export function listWorkflows(dir) {
  const target = dir || path.dirname(defaultWorkflowFile())
  let entries
  try {
    entries = fs.readdirSync(target, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => path.join(target, entry.name))
    .sort()
}

export function loadWorkflow(file) {
  const text = fs.readFileSync(file, 'utf8')
  const parsed = JSON.parse(text)
  // UI 版工作流带 nodes/links，API 版直接是 {id: {class_type, inputs}}。
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed.nodes) && parsed['1'] === undefined) {
    const first = Object.values(parsed)[0]
    if (first && typeof first === 'object' && 'class_type' in first) return parsed
  }
  if (parsed && Array.isArray(parsed.nodes)) {
    const error = new Error('这是 ComfyUI UI 版工作流（含 nodes/links），不是 API 版：' + path.basename(file))
    error.code = 'workflow-not-api'
    throw error
  }
  return parsed
}

/**
 * 规范化「归入哪个分类目录」。
 * 允许 `a`、`a/b`、`moss/2026-11`、带空格与括号的名字；拒绝盘符、绝对路径、`..`、控制字符。
 * @param input - 用户输入或配置值。
 * @returns 归一化后的相对目录（`a/b`），不合法返回 `null`。
 */
export function normalizeOutputFolder(input) {
  const raw = String(input ?? '').trim().replace(/\\/g, '/')
  if (raw.length === 0) return null
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/')) return null
  if (/[\u0000-\u001f]/.test(raw)) return null
  const parts = raw.split('/').filter((part) => part.length > 0 && part !== '.')
  if (parts.length === 0) return null
  if (parts.some((part) => part === '..')) return null
  if (!/^[\w\- ./()[\]{}]+$/.test(raw)) return null
  return parts.join('/')
}

/** 会写文件的节点类型——只有这些才该改 `filename_prefix`。 */
const SAVE_NODES = ['SaveImage', 'SaveImageWebp', 'PreviewImage']

/**
 * 往工作流里填参数。
 * 只在认得出的节点上改，认不出就保持原样并把跳过项报回去，不猜。
 * @param graph - API 版工作流对象（会被深拷贝）。
 * @param params - `{ prompt, negative, seed, steps, cfg, width, height, checkpoint, loras, outputFolder }`
 */
export function patchWorkflow(graph, params = {}) {
  const next = JSON.parse(JSON.stringify(graph))
  const notes = []
  const nodes = Object.entries(next)

  const samplerIds = nodes.filter(([, node]) => typeof node?.class_type === 'string' && node.class_type.startsWith('KSampler')).map(([id]) => id)
  const linkTarget = (value) => (Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null)

  // 正向 / 反向提示词：从采样器的 link 反查 CLIPTextEncode，不写死节点号。
  const firstSampler = samplerIds.length > 0 ? next[samplerIds[0]] : null

  /**
   * 顺着 link 找「真正装着人写的那段字」的节点。
   * 大多数工作流就是 CLIPTextEncode.text；MOSS 的开关版把文本串成
   * StringConcatenate(PrimitiveString, PrimitiveString)，直接改 CLIPTextEncode 会没有 text 可改。
   * @returns `{ id, field }` 或 null。
   */
  const findTextSlot = (startId, depth = 0) => {
    if (typeof startId !== 'string' || depth > 6) return null
    const node = next[startId]
    if (node === undefined) return null
    if (typeof node.inputs?.text === 'string') return { id: startId, field: 'text' }
    if (typeof node.inputs?.value === 'string') return { id: startId, field: 'value' }
    const candidates = []
    for (const field of ['text', 'value', 'string_a', 'string_b']) {
      const upstream = linkTarget(node.inputs?.[field])
      const slot = upstream === null ? null : findTextSlot(upstream, depth + 1)
      if (slot === null) continue
      candidates.push({ ...slot, length: String(next[slot.id].inputs[slot.field] ?? '').length })
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => b.length - a.length)
    return candidates[0]
  }

  /** 写提示词：能直接写就直接写，写不了就写到上游字符串节点，并说明写了哪里。 */
  const writeText = (label, linkValue, value) => {
    if (typeof value !== 'string') return false
    const directId = linkTarget(linkValue)
    if (directId === null) return false
    const direct = next[directId]
    if (direct !== undefined && typeof direct.inputs?.text === 'string') {
      direct.inputs.text = value
      return true
    }
    const slot = findTextSlot(directId)
    if (slot === null) return false
    next[slot.id].inputs[slot.field] = value
    if (slot.id !== directId) {
      notes.push(label + '提示词写进上游节点 ' + slot.id + '（' + String(next[slot.id].class_type) + '），工作流里的拼接/开关不动')
    }
    return true
  }

  if (typeof params.prompt === 'string' && (firstSampler === null || !writeText('正向', firstSampler.inputs?.positive, params.prompt))) {
    notes.push('没找到正向提示词节点，prompt 未写入')
  }
  // 反向留空 = 用工作流自己的默认值，别把它清掉。
  if (typeof params.negative === 'string' && params.negative.trim().length > 0) {
    const written = firstSampler !== null && writeText('反向', firstSampler.inputs?.negative, params.negative)
    if (!written) notes.push('没找到反向提示词节点，negative 未写入')
  }

  const seed = Number.isFinite(params.seed) ? Math.trunc(params.seed) : null
  // 只覆盖「写死的数字」：连成链的（MOSS 开关版的 steps/cfg 由 ComfySwitchNode 决定）
  // 一旦改成字面量，开关就不起作用了，宁可留原样并说一句。
  const linkedInsteadOfNumber = []
  for (const id of samplerIds) {
    const inputs = next[id].inputs
    for (const field of ['seed', 'noise_seed']) {
      if (seed === null || !(field in inputs)) continue
      if (typeof inputs[field] === 'number') inputs[field] = seed
      else linkedInsteadOfNumber.push(field)
    }
    if (Number.isFinite(params.steps) && 'steps' in inputs) {
      if (typeof inputs.steps === 'number') inputs.steps = Math.trunc(params.steps)
      else linkedInsteadOfNumber.push('steps')
    }
    if (Number.isFinite(params.cfg) && 'cfg' in inputs) {
      if (typeof inputs.cfg === 'number') inputs.cfg = Number(params.cfg)
      else linkedInsteadOfNumber.push('cfg')
    }
  }
  if (linkedInsteadOfNumber.length > 0) {
    notes.push('这些参数在工作流里是连线（' + [...new Set(linkedInsteadOfNumber)].join('/') + '），未覆盖')
  }
  for (const [, node] of nodes) {
    if (node?.class_type !== 'EmptyLatentImage' && node?.class_type !== 'EmptyFlux2LatentImage') continue
    if (Number.isFinite(params.width)) node.inputs.width = Math.trunc(params.width)
    if (Number.isFinite(params.height)) node.inputs.height = Math.trunc(params.height)
  }

  // 底模只写「候选里真有」的那个：写错名字 ComfyUI 会在 /prompt 处整单拒掉
  // （value_not_in_list），连图都跑不起来。没给候选表就按老样子写（兼容外部调用）。
  const allowedCheckpoints = Array.isArray(params.checkpointPool) ? params.checkpointPool : null
  const wantedCheckpoint = typeof params.checkpoint === 'string' ? params.checkpoint.trim() : ''
  if (wantedCheckpoint.length > 0) {
    if (allowedCheckpoints !== null && !allowedCheckpoints.includes(wantedCheckpoint)) {
      notes.push('底模 ' + wantedCheckpoint + ' 不在候选列表里，沿用工作流默认值')
    } else {
      let applied = false
      for (const [, node] of nodes) {
        if ((node?.class_type === 'UNETLoader' || node?.class_type === 'UnetLoaderGGUF') && 'unet_name' in node.inputs) {
          node.inputs.unet_name = wantedCheckpoint
          applied = true
        } else if (node?.class_type === 'CheckpointLoaderSimple' && 'ckpt_name' in node.inputs) {
          node.inputs.ckpt_name = wantedCheckpoint
          applied = true
        }
      }
      if (!applied) notes.push('工作流里没有 UNETLoader/CheckpointLoader，checkpoint 未写入')
    }
  }

  if (Array.isArray(params.loras) && params.loras.length > 0) {
    const loraNodes = nodes.filter(([, node]) => typeof node?.class_type === 'string' && node.class_type.startsWith('LoraLoader'))
    loraNodes.forEach(([, node], index) => {
      const wanted = params.loras[index]
      if (!wanted || typeof wanted.name !== 'string') return
      node.inputs.lora_name = wanted.name
      const strength = Number(wanted.strength)
      if (Number.isFinite(strength)) {
        if ('strength_model' in node.inputs) node.inputs.strength_model = strength
        if ('strength_clip' in node.inputs) node.inputs.strength_clip = strength
      }
    })
    if (params.loras.length > loraNodes.length) {
      notes.push('工作流只有 ' + loraNodes.length + ' 个 LoRA 槽，多余的 ' + (params.loras.length - loraNodes.length) + ' 个未写入')
    }
  }

  // 「生图归入分类」：只给写文件节点的 filename_prefix 加子目录前缀，
  // ComfyUI 的 get_save_image_path 会自己建目录。
  if (typeof params.outputFolder === 'string' && params.outputFolder.trim().length > 0) {
    const folder = normalizeOutputFolder(params.outputFolder)
    if (folder === null) {
      notes.push('分类目录名不合法，未改 filename_prefix：' + params.outputFolder)
    } else {
      let applied = 0
      for (const [, node] of nodes) {
        if (!SAVE_NODES.includes(node?.class_type)) continue
        if (typeof node.inputs?.filename_prefix !== 'string') continue
        if (!node.inputs.filename_prefix.startsWith(folder + '/')) {
          node.inputs.filename_prefix = folder + '/' + node.inputs.filename_prefix
        }
        applied += 1
      }
      if (applied === 0) notes.push('工作流里没有 SaveImage/PreviewImage 节点，分类目录未写入')
    }
  }

  return { graph: next, notes, samplers: samplerIds.length }
}

/** 放大超分默认模型：和 comfyui-moss 技能的 `upscale.mjs` 一致，二次元线稿最稳。 */
export const DEFAULT_UPSCALE_MODEL = 'RealESRGAN_x4plus_anime_6B.pth'

/**
 * 构造「放大超分」图：每张图一条分支，一次提交，结果都进同一个 history。
 *
 * `LoadImage → UpscaleModelLoader → ImageUpscaleWithModel →（非 4x 时）ImageScaleBy(lanczos) → SaveImage`
 * 模型固定 4x；2x / 3x 是在 ComfyUI 里用 lanczos 降采样，不是换模型。
 * @param params - `{ jobs: [{ inputName, prefix }], model, scale }`
 */
export function buildUpscaleGraph({ jobs = [], model = DEFAULT_UPSCALE_MODEL, scale = 2 } = {}) {
  const graph = {}
  const factor = Number(scale)
  const want = Number.isFinite(factor) && factor > 0 ? factor : 2
  jobs.forEach((job, index) => {
    const base = (index + 1) * 10
    graph[base] = { class_type: 'LoadImage', inputs: { image: String(job.inputName) } }
    graph[base + 1] = { class_type: 'UpscaleModelLoader', inputs: { model_name: String(model) } }
    graph[base + 2] = {
      class_type: 'ImageUpscaleWithModel',
      inputs: { upscale_model: [String(base + 1), 0], image: [String(base), 0] },
    }
    let last = String(base + 2)
    if (Math.abs(want - 4) > 1e-6) {
      graph[base + 3] = {
        class_type: 'ImageScaleBy',
        inputs: { image: [last, 0], upscale_method: 'lanczos', scale_by: want / 4 },
      }
      last = String(base + 3)
    }
    graph[base + 4] = { class_type: 'SaveImage', inputs: { images: [last, 0], filename_prefix: String(job.prefix) } }
  })
  return graph
}

/**
 * 提交一次 `/prompt`。
 * @param extraData - 可选，原样塞进请求体的 `extra_data`；逐步预览靠它按任务开
 *   `preview_method`（`execution.py` L734 会用这里的值覆盖全局默认，任务开始即生效）。
 */
export async function submitPrompt(comfyUrl, graph, clientId, extraData) {
  const body = { prompt: graph, client_id: clientId }
  if (extraData !== undefined && extraData !== null) body.extra_data = extraData
  const result = await request(comfyUrl + '/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!result || typeof result.prompt_id !== 'string') {
    const error = new Error('ComfyUI 没有返回 prompt_id：' + JSON.stringify(result).slice(0, 300))
    error.code = 'prompt-rejected'
    throw error
  }
  return result.prompt_id
}

export async function systemStats(comfyUrl) {
  return request(comfyUrl + '/system_stats', {}, 6000)
}

export async function objectInfo(comfyUrl) {
  return request(comfyUrl + '/object_info', {}, 20_000)
}

export async function history(comfyUrl, promptId) {
  return request(comfyUrl + '/history/' + encodeURIComponent(promptId), {}, 20_000)
}

export async function queueState(comfyUrl) {
  return request(comfyUrl + '/queue', {}, 8000)
}

export async function interrupt(comfyUrl) {
  return request(comfyUrl + '/interrupt', { method: 'POST' }, 8000)
}

/**
 * 定向取消一个任务：先走 0.42.1 的原子接口，退不动再用旧两条。
 *
 * `POST /api/jobs/{id}/cancel` 同时管 running（interrupt_if_running）与 pending
 * （delete_queue_item），已完成或未知返回 `{cancelled:false}`；旧接口只处理 running。
 *
 * @returns `{ outcome, method, message }`，outcome ∈ `cancelled|cancelling|not-running`
 */
export async function cancelJob(comfyUrl, promptId) {
  try {
    const result = await request(comfyUrl + '/api/jobs/' + encodeURIComponent(promptId) + '/cancel', { method: 'POST' }, 8000)
    if (result && result.cancelled === true) {
      return { outcome: 'cancelled', method: 'jobs-cancel', message: '已取消任务' }
    }
    if (result && result.cancelled === false) {
      return { outcome: 'not-running', method: 'jobs-cancel', message: '任务不在队列里' }
    }
    // 老版本可能回 200 但空体：当作「发了但不知道」。
    return { outcome: 'cancelling', method: 'jobs-cancel', message: '已发出取消请求' }
  } catch (error) {
    const status = error?.status
    if (status !== 404 && status !== 405) throw error
  }

  // 降级：/interrupt 指向该任务 + /queue 删排队项，两条都发，谁命中算谁。
  await request(comfyUrl + '/interrupt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt_id: promptId }),
  }, 8000).catch(() => null)
  await request(comfyUrl + '/queue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ delete: [promptId] }),
  }, 8000).catch(() => null)
  return { outcome: 'cancelling', method: 'interrupt+queue', message: '用兼容方式发出取消' }
}

/**
 * 队列里有没有这个任务。
 * @returns `'running' | 'pending' | null`
 */
export async function queuePosition(comfyUrl, promptId) {
  const queue = await queueState(comfyUrl)
  const has = (rows) => Array.isArray(rows) && rows.some((row) => Array.isArray(row) && row[1] === promptId)
  if (has(queue?.queue_running)) return 'running'
  if (has(queue?.queue_pending)) return 'pending'
  return null
}

/**
 * 从 `/history` 条目里取产物。
 * @returns `{ images, status, messages }`，images 带可直接 `<img src>` 的相对地址。
 */
export function readHistoryEntry(entry) {
  const images = []
  const messages = []
  if (!entry || typeof entry !== 'object') return { images, status: 'missing', messages }
  const outputs = entry.outputs ?? {}
  for (const node of Object.values(outputs)) {
    for (const image of Array.isArray(node?.images) ? node.images : []) {
      if (typeof image?.filename !== 'string') continue
      const query = new URLSearchParams({
        filename: image.filename,
        subfolder: image.subfolder ?? '',
        type: image.type ?? 'output',
      })
      images.push({
        filename: image.filename,
        // 统一成正斜杠：相对路径、灯箱文案都按 `a/b` 读。
        subfolder: String(image.subfolder ?? '').replace(/\\/g, '/'),
        type: image.type ?? 'output',
        url: '/dsh-comfy/view?' + query.toString(),
      })
    }
    for (const text of Array.isArray(node?.text) ? node.text : []) {
      if (typeof text === 'string') messages.push(text)
    }
  }
  const status = entry.status?.status_str ?? (images.length > 0 ? 'success' : 'unknown')
  return { images, status, messages }
}

/**
 * 轮询一次任务，直到出结果、失败或超预算。
 * 服务中途挂掉时 `/history` 会连续失败，连续 6 次就判服务掉线，不把预算烧完才报。
 * @param options - `{ budgetMs, intervalMs }`
 */
export async function pollJob(comfyUrl, promptId, options = {}) {
  const budgetMs = options.budgetMs ?? 180_000
  const intervalMs = options.intervalMs ?? 1500
  const started = Date.now()
  let consecutiveErrors = 0
  while (Date.now() - started < budgetMs) {
    try {
      const entry = (await history(comfyUrl, promptId))?.[promptId]
      consecutiveErrors = 0
      if (entry) {
        const read = readHistoryEntry(entry)
        const done = entry.status?.completed === true || read.status === 'success' || read.status === 'error'
        if (done) return { state: read.status === 'error' ? 'failed' : 'done', ...read, elapsedMs: Date.now() - started }
        if (read.images.length > 0) return { state: 'done', ...read, elapsedMs: Date.now() - started }
      }
    } catch (error) {
      consecutiveErrors += 1
      if (consecutiveErrors >= 6) {
        return { state: 'service-lost', images: [], status: 'service-lost', messages: [error instanceof Error ? error.message : String(error)], elapsedMs: Date.now() - started }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return { state: 'timeout', images: [], status: 'timeout', messages: [], elapsedMs: Date.now() - started }
}
