/**
 * lib/dirs.js — ComfyUI 目录自动识别。
 *
 * 三级探测，越靠前越可信：
 *   1. `extra_model_paths.yaml` 的 `comfyui:` 段（模型根 + 28 个类别）
 *   2. 服务在线时的 `/object_info`：按 loader 节点取真实文件清单
 *   3. 服务离线时扫盘（扩展名白名单）
 *
 * input/output 走四级：启动脚本参数 → Comfy Desktop settings.json → ComfyUI 默认 →
 * 插件配置覆盖。output 最后过一遍 realpath，因为本机 `C:\Comfyui output` 是指向
 * `C:\DSH生图` 的符号链接，写文件必须用真身。
 *
 * 只用 Node 内置模块；yaml 是本机这一份固定格式，不引第三方解析器。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_COMFY_ROOT = 'C:\\Comfyui Driver\\ComfyUI\\ComfyUI'
export const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188'

/** yaml 里出现的类别（跳过 base_path / is_default 这类控制键）。 */
export const MODEL_CATEGORIES = [
  'checkpoints', 'clip', 'clip_vision', 'configs', 'controlnet', 'diffusers',
  'diffusion_models', 'embeddings', 'gligen', 'hypernetworks', 'loras',
  'style_models', 'text_encoders', 'unet', 'upscale_models', 'vae',
  'vae_approx', 'audio_encoders', 'background_removal', 'detection',
  'frame_interpolation', 'geometry_estimation', 'latent_upscale_models',
  'model_patches', 'optical_flow', 'photomaker',
]

/** 扫盘认的模型扩展名。 */
export const MODEL_EXTENSIONS = ['.safetensors', '.sft', '.ckpt', '.pt', '.pth', '.bin', '.gguf']

/** `/object_info` 里各类别对应的 loader 节点与字段。 */
const OBJECT_INFO_FIELDS = [
  { category: 'checkpoints', node: 'CheckpointLoaderSimple', input: 'ckpt_name' },
  { category: 'loras', node: 'LoraLoader', input: 'lora_name' },
  { category: 'vae', node: 'VAELoader', input: 'vae_name' },
  { category: 'unet', node: 'UNETLoader', input: 'unet_name' },
  { category: 'clip', node: 'CLIPLoader', input: 'clip_name' },
  { category: 'text_encoders', node: 'CLIPLoader', input: 'clip_name' },
  { category: 'upscale_models', node: 'UpscaleModelLoader', input: 'model_name' },
]

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function statSafe(target) {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

/** `C:\Comfyui output` 这种符号链接要穿过，写盘时用真身。 */
export function realPath(target) {
  if (typeof target !== 'string' || target.length === 0) return target
  try {
    return fs.realpathSync.native(target)
  } catch {
    try {
      return fs.realpathSync(target)
    } catch {
      return target
    }
  }
}

/**
 * 解析本机这份 `extra_model_paths.yaml` 的 `comfyui:` 段。
 * 支持缩进 + `key: value`，忽略注释、空行和 `is_default`。
 * @param text - yaml 原文。
 * @returns `{ basePath, entries }`，entries 保留原始相对值。
 */
export function parseModelPathsYaml(text) {
  const result = { basePath: null, entries: {} }
  if (typeof text !== 'string') return result
  let inSection = false
  let sectionIndent = -1
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim().length === 0 || raw.trim().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    const match = raw.trim().match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!match) continue
    const [, key, rawValue] = match
    const value = rawValue.trim().replace(/^['"]|['"]$/g, '')
    // 顶层段头
    if (indent === 0) {
      inSection = key === 'comfyui'
      sectionIndent = indent
      continue
    }
    if (!inSection || indent <= sectionIndent) continue
    if (value.length === 0) continue
    if (key === 'base_path') {
      result.basePath = value
      continue
    }
    if (key === 'is_default') continue
    result.entries[key] = value
  }
  return result
}

/**
 * 从启动脚本里读 `--input-directory` / `--output-directory` / `--port`。
 * 本机最可靠的来源：Desktop 的 settings.json 反而不存在。
 * @param scriptPath - `run-comfyui.cmd` 的绝对路径。
 */
export function readLaunchArgs(scriptPath) {
  const text = readText(scriptPath)
  if (text === null) return null
  const pick = (flag) => {
    const re = new RegExp(flag + '\\s+"([^"]+)"')
    const hit = text.match(re) ?? text.match(new RegExp(flag + '\\s+([^\\s^]+)'))
    return hit ? hit[1] : null
  }
  return {
    input: pick('--input-directory'),
    output: pick('--output-directory'),
    port: Number(pick('--port') || 0) || null,
    listen: pick('--listen'),
  }
}

/** Comfy Desktop 的 settings.json（本机一般不存在，存在就优先于默认目录）。 */
export function readDesktopSettings() {
  const appData = process.env.APPDATA
  if (!appData) return null
  const file = path.join(appData, 'Comfy Desktop', 'settings.json')
  const text = readText(file)
  if (text === null) return null
  try {
    const parsed = JSON.parse(text)
    return {
      input: parsed.inputDir ?? parsed.inputDirectory ?? null,
      output: parsed.outputDir ?? parsed.outputDirectory ?? null,
    }
  } catch {
    return null
  }
}

/**
 * 服务探活：`/system_stats` 200 且能解析就算在线。
 * @param comfyUrl - 形如 `http://127.0.0.1:8188`。
 * @param timeoutMs - 单次请求超时。
 */
export async function probeService(comfyUrl, timeoutMs = 2500) {
  const url = String(comfyUrl || DEFAULT_COMFY_URL).replace(/\/+$/, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url + '/system_stats', { signal: controller.signal })
    if (!response.ok) return { ok: false, status: response.status, url }
    const stats = await response.json().catch(() => null)
    return { ok: true, status: response.status, url, stats }
  } catch (error) {
    return { ok: false, status: 0, url, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** 递归列一个目录里的模型文件，返回相对路径（正斜杠），最多 3 层。 */
export function scanModelFiles(dir, depth = 0) {
  if (depth > 3) return []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      for (const nested of scanModelFiles(full, depth + 1)) out.push(entry.name + '/' + nested)
      continue
    }
    if (!entry.isFile()) continue
    if (!MODEL_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue
    out.push(entry.name)
  }
  return out.sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

/**
 * 从 `/object_info` 里取真实文件清单。
 * @param objectInfo - `/object_info` 的 JSON。
 * @returns 以类别为键的清单，取不到的类别不出现。
 */
export function filesFromObjectInfo(objectInfo) {
  const files = {}
  if (!objectInfo || typeof objectInfo !== 'object') return files
  for (const { category, node, input } of OBJECT_INFO_FIELDS) {
    const schema = objectInfo[node]
    const field = schema?.input?.required?.[input] ?? schema?.input?.optional?.[input]
    const list = Array.isArray(field) ? field[0] : undefined
    if (!Array.isArray(list)) continue
    const names = list.filter((value) => typeof value === 'string')
    files[category] = files[category] === undefined ? names : [...new Set([...files[category], ...names])]
  }
  return files
}

/** 本机 skills 里的启动脚本位置（按 home 推，不写死用户名）。 */
export function defaultLaunchScripts() {
  const home = os.homedir()
  const dir = path.join(home, '.workbuddy', 'skills', 'comfyui-workflow-builder', 'scripts')
  return {
    dir,
    cmd: path.join(dir, 'run-comfyui.cmd'),
    ps1: path.join(dir, 'start-comfyui.ps1'),
  }
}

/**
 * 汇总一次完整探测。
 * @param options - `{ comfyUrl, comfyRoot, overrides, refresh, light }`，overrides 来自插件配置。
 *   `light: true` 只要路径不要模型清单：跳过 `/object_info`（1000+ 节点、几十 MB）和模型扫盘。
 * @returns 页面与 HTTP 端点共用的目录快照。
 */
export async function collectDirs(options = {}) {
  const overrides = options.overrides ?? {}
  const comfyRoot = overrides.comfyRoot || DEFAULT_COMFY_ROOT
  const comfyUrl = String(overrides.comfyUrl || DEFAULT_COMFY_URL).replace(/\/+$/, '')
  const errors = []

  // 1) 模型根：yaml 优先
  const yamlFile = path.join(comfyRoot, 'extra_model_paths.yaml')
  const yamlText = readText(yamlFile)
  const yaml = parseModelPathsYaml(yamlText ?? '')
  const basePath = yaml.basePath ? path.resolve(yaml.basePath) : path.join(comfyRoot, 'models')
  const models = {}
  for (const category of MODEL_CATEGORIES) {
    const declared = yaml.entries[category]
    models[category] = declared
      ? path.resolve(basePath, declared)
      : path.join(basePath, category)
  }
  if (yamlText === null) errors.push('extra_model_paths.yaml 未读到，模型目录按默认推')

  // 2) 服务探活
  const probe = await probeService(comfyUrl)
  const files = {}
  const counts = {}
  if (options.light === true) {
    // 图库这类调用只关心 input/output 路径：别为了模型清单去拉 /object_info
    for (const category of MODEL_CATEGORIES) files[category] = []
  } else {
    if (probe.ok) {
      try {
        const response = await fetch(comfyUrl + '/object_info')
        if (response.ok) {
          Object.assign(files, filesFromObjectInfo(await response.json()))
        }
      } catch (error) {
        errors.push('/object_info 读取失败：' + (error instanceof Error ? error.message : String(error)))
      }
    }
    // 3) 离线或被漏掉的类别走扫盘
    for (const category of ['checkpoints', 'loras', 'diffusion_models', 'unet', 'vae', 'text_encoders', 'upscale_models']) {
      if (Array.isArray(files[category]) && files[category].length > 0) continue
      const scanned = scanModelFiles(models[category])
      if (scanned.length > 0) files[category] = scanned
    }
    for (const category of MODEL_CATEGORIES) {
      if (!Array.isArray(files[category])) files[category] = []
    }
    for (const [category, list] of Object.entries(files)) counts[category] = list.length
  }

  // 4) input / output
  const scripts = defaultLaunchScripts()
  const launch = readLaunchArgs(overrides.launchScript || scripts.cmd)
  const desktop = readDesktopSettings()
  const input = overrides.input || launch?.input || desktop?.input || path.join(comfyRoot, 'input')
  const output = overrides.output || launch?.output || desktop?.output || path.join(comfyRoot, 'output')

  return {
    comfyUrl,
    comfyRoot,
    service: probe.ok ? 'up' : 'down',
    serviceError: probe.ok ? null : probe.error ?? ('HTTP ' + probe.status),
    stats: probe.ok ? probe.stats : null,
    modelBase: basePath,
    modelBaseSource: yaml.basePath ? 'extra_model_paths.yaml' : 'default',
    models,
    files,
    counts,
    input,
    inputReal: realPath(input),
    inputExists: statSafe(input)?.isDirectory() === true,
    output,
    outputReal: realPath(output),
    outputExists: statSafe(output)?.isDirectory() === true,
    launchScript: overrides.launchScript || scripts.cmd,
    startScript: scripts.ps1,
    errors,
    probedAt: Date.now(),
  }
}
