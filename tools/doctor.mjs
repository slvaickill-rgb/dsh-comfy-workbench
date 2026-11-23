#!/usr/bin/env node
/**
 * tools/doctor.mjs — 装机体检：一次跑完，告诉你「缺什么、填哪、去哪下」。
 *
 *   node tools/doctor.mjs           人看的报告
 *   node tools/doctor.mjs --json    机器可读（给 agent 用）
 *
 * 检查：DSH profile 与配置、ComfyUI 在线与版本、模型目录（优先 extra_model_paths.yaml）、
 * 每份工作流缺哪些文件、缺的从哪下。只读：不下载、不改配置、不碰 ComfyUI。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_COMFY_ROOT, DEFAULT_COMFY_URL, parseModelPathsYaml } from '../lib/dirs.js'
import { readManifest } from '../lib/workflows.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const JSON_OUT = process.argv.includes('--json')

const report = { ok: true, problems: [], warnings: [], env: {}, config: {}, comfy: {}, models: {}, workflows: [] }

function say(line) {
  if (!JSON_OUT) console.log(line)
}

function exists(target) {
  try {
    fs.statSync(target)
    return true
  } catch {
    return false
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 已知文件的下载地址：缺哪个就报哪个，别让人再去猜。 */
const DOWNLOADS = {
  'moss_image_sft_int8_convrot.safetensors': {
    dir: 'diffusion_models/',
    size: '5.41 GB',
    from: 'https://huggingface.co/nif0/MOSS-Image-SFT-ComfyUI',
  },
  'qwen3.5_9b_moss_image_sft_w4a8_gptq.safetensors': {
    dir: 'text_encoders/',
    size: '5.43 GB',
    from: 'https://huggingface.co/nif0/MOSS-Image-SFT-ComfyUI',
  },
  'moss_image_vae_bf16.safetensors': {
    dir: 'vae/',
    size: '0.12 GB',
    from: 'https://huggingface.co/nif0/MOSS-Image-SFT-ComfyUI',
  },
  'moss_image_sft_4step_v2.0.safetensors': {
    dir: 'loras/',
    size: '1.19 GB',
    from: 'https://huggingface.co/akhaliq/MOSS-Image-SFT-4-steps',
  },
}

function downloadHint(name, group) {
  const known = DOWNLOADS[name]
  if (known) return '放 ' + known.dir + ' · ' + known.size + ' · ' + known.from
  const where = {
    unet: 'diffusion_models/ 或 unet/',
    clip: 'text_encoders/ 或 clip/',
    vae: 'vae/',
    loras: 'loras/',
    checkpoints: 'checkpoints/',
  }
  const place = where[group] ?? (group + '/')
  if (name.startsWith('moss_') || name.startsWith('qwen3')) {
    return '放 ' + place + ' · 去 https://huggingface.co/Comfy-Org/MOSS-Image 或 nif0/MOSS-Image-SFT-ComfyUI 找同名'
  }
  return '放 ' + place + ' · 这份不是 MOSS 官方权重，去对应工作流作者的发布页下（Civitai / HuggingFace）'
}

// ---------------------------------------------------------------- 环境

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileDir = path.join(home, 'profiles', 'desktop')
const stateDir = exists(profileDir) ? path.join(profileDir, '.dsh-comfy') : path.join(home, 'comfy-workbench')
const configFile = path.join(stateDir, 'config.json')
const pkg = readJson(path.join(ROOT, 'package.json')) || {}

report.env = {
  pluginRoot: ROOT,
  pluginVersion: pkg.version ?? null,
  requiresDsh: pkg.engines?.dsh ?? null,
  dshHome: home,
  profileExists: exists(profileDir),
  node: process.version,
  platform: process.platform,
}

say('== 环境 ==')
say('插件      ' + ROOT + '  v' + (pkg.version ?? '?'))
say('需要 DSH  ' + (pkg.engines?.dsh ?? '(未声明)'))
say('DSH_HOME  ' + home)
say('profile   ' + (exists(profileDir) ? profileDir : '不存在 —— 先装一次 DSH 并建 desktop profile'))
if (!exists(profileDir)) {
  report.ok = false
  report.problems.push('找不到 DSH desktop profile：' + profileDir)
  report.warnings.push('没有 profile 时插件配置会落到 ' + stateDir)
}

// ---------------------------------------------------------------- 安装

const profileManifest = readJson(path.join(profileDir, 'package.json'))
const dep = profileManifest?.dependencies?.['dsh-comfy-workbench'] ?? null
const bundleList = profileManifest?.dsh?.profile?.bundles
const inBundles = Array.isArray(bundleList) && bundleList.includes('dsh-comfy-workbench')
const linkPath = path.join(profileDir, 'node_modules', 'dsh-comfy-workbench')
const linked = exists(linkPath)
report.install = { dependency: dep, inBundles, linked, linkPath }

say('')
say('== 安装 ==')
say('依赖登记  ' + (dep !== null ? '✓ ' + String(dep) : '✗ 缺 dependencies["dsh-comfy-workbench"]'))
say('bundle    ' + (inBundles ? '✓ 已进 dsh.profile.bundles' : '✗ 缺 dsh.profile.bundles 条目'))
say('联接      ' + (linked ? '✓ ' + linkPath : '✗ 不存在'))
if (!linked || dep === null || !inBundles) {
  report.ok = false
  report.problems.push('插件没登记进 profile：在插件目录跑 node tools/install.mjs，然后重启 DSH')
}

// ---------------------------------------------------------------- 配置

const config = readJson(configFile)
report.config = { file: configFile, exists: config !== null, values: config ?? null }

say('')
say('== 配置 ==')
say('文件      ' + configFile + (config === null ? '（不存在，全部走默认值）' : ''))
if (config === null) {
  report.warnings.push('config.json 还没有：插件会用默认值，建议先建一份最小的（见 SETUP.md §5）')
} else {
  const keys = ['comfyRoot', 'comfyUrl', 'output', 'workflow', 'checkpoint', 'characterKbRoot', 'catalogRoot', 'width', 'height', 'steps']
  for (const key of keys) {
    const value = config[key]
    say('  ' + key.padEnd(16) + (value === null || value === undefined ? 'null（自动探测）' : String(value)))
  }
}

const agentsFile = path.join(home, 'AGENTS.md')
say('全局人设  ' + (exists(agentsFile) ? '✓ ' + agentsFile : '没有（改写会退到内置 §4 兜底，不影响出图）'))

// ---------------------------------------------------------------- ComfyUI

const comfyUrl = String(config?.comfyUrl || DEFAULT_COMFY_URL).replace(/\/+$/, '')

async function probe(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2500)
  try {
    const response = await fetch(url + '/system_stats', { signal: controller.signal })
    if (!response.ok) return { up: false, status: response.status }
    const body = await response.json().catch(() => null)
    return {
      up: true,
      version: body?.system?.comfyui_version ?? null,
      devices: Array.isArray(body?.devices) ? body.devices.length : null,
    }
  } catch (error) {
    return { up: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

const comfy = await probe(comfyUrl)
report.comfy = { url: comfyUrl, ...comfy }

say('')
say('== ComfyUI ==')
say('地址      ' + comfyUrl)
if (!comfy.up) {
  say('状态      ✗ 连不上' + (comfy.error ? '（' + comfy.error + '）' : comfy.status ? '（HTTP ' + comfy.status + '）' : ''))
  report.ok = false
  report.problems.push('ComfyUI 连不上：' + comfyUrl + ' —— 起服务，或改 config.comfyUrl')
  say('怎么装    https://comfy.org/zh-CN/ 下载 Desktop，或 https://github.com/comfyanonymous/ComfyUI/releases 下 portable（必须 >= 0.41.3）')
} else {
  say('状态      ✓ 在线' + (comfy.version ? ' · 版本 ' + comfy.version : ''))
  const parsed = String(comfy.version ?? '').match(/^(\d+)\.(\d+)\.(\d+)/)
  if (parsed) {
    const [major, minor, patch] = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])]
    const tooOld = major === 0 && (minor < 41 || (minor === 41 && patch < 3))
    if (tooOld) {
      say('版本      ✗ 低于 0.41.3：没有 moss_image 的 CLIP 类型，也没有 EmptyFlux2LatentImage')
      report.ok = false
      report.problems.push('ComfyUI ' + comfy.version + ' 太旧，工作流跑不了；需要 >= 0.41.3')
    } else {
      say('版本      ✓ 满足 >= 0.41.3')
    }
  } else {
    say('版本      ? 读不到版本号，自己确认 >= 0.41.3')
    report.warnings.push('ComfyUI 版本未知，MOSS 工作流需要 >= 0.41.3')
  }
}

// ---------------------------------------------------------------- 模型目录

const rootCandidates = [
  config?.comfyRoot,
  DEFAULT_COMFY_ROOT,
  'C:\\ComfyUI',
  'C:\\ComfyUI_windows_portable\\ComfyUI',
  path.join(os.homedir(), 'ComfyUI'),
].filter((value) => typeof value === 'string' && value.length > 0)

const comfyRoot = rootCandidates.find(
  (candidate) => exists(path.join(candidate, 'main.py')) || exists(path.join(candidate, 'extra_model_paths.yaml')),
) ?? null

/** category → 候选目录（yaml 优先，其后 ComfyUI 自带 models/）。 */
function modelDirs(root) {
  const table = {}
  if (root === null) return table
  const add = (category, dir) => {
    if (!Array.isArray(table[category])) table[category] = []
    if (!table[category].includes(dir)) table[category].push(dir)
  }
  const yamlFile = path.join(root, 'extra_model_paths.yaml')
  const yaml = exists(yamlFile)
    ? parseModelPathsYaml(fs.readFileSync(yamlFile, 'utf8'))
    : { basePath: null, entries: {} }
  if (yaml.basePath) {
    for (const [category, relative] of Object.entries(yaml.entries)) add(category, path.join(yaml.basePath, relative))
  }
  const categories = ['checkpoints', 'diffusion_models', 'unet', 'text_encoders', 'clip', 'vae', 'loras', 'upscale_models']
  for (const category of categories) add(category, path.join(root, 'models', category))
  if (yaml.basePath) {
    for (const category of categories) add(category, path.join(yaml.basePath, category))
  }
  return table
}

const dirs = modelDirs(comfyRoot)
report.models = {
  comfyRoot,
  yaml: comfyRoot !== null && exists(path.join(comfyRoot, 'extra_model_paths.yaml'))
    ? path.join(comfyRoot, 'extra_model_paths.yaml')
    : null,
  dirs,
}

say('')
say('== 模型目录 ==')
say('ComfyUI 根  ' + (comfyRoot ?? '没找到（config.comfyRoot 指向含 main.py 的目录）'))
say('extra yaml  ' + (report.models.yaml ?? '没有（按 ComfyUI 默认 models/ 推）'))
if (comfyRoot === null) {
  report.warnings.push('没定位到 ComfyUI 根目录：填 config.comfyRoot，或把 ComfyUI 装在默认位置')
}

/** 一个文件算不算在：按 category 组查（unet 认 unet+diffusion_models，clip 认 clip+text_encoders）。 */
const GROUPS = {
  unet: ['diffusion_models', 'unet'],
  clip: ['text_encoders', 'clip'],
  vae: ['vae'],
  loras: ['loras'],
  checkpoints: ['checkpoints'],
}

function findFile(group, name) {
  const categories = GROUPS[group] ?? [group]
  for (const category of categories) {
    for (const dir of dirs[category] ?? []) {
      if (exists(path.join(dir, name))) return path.join(dir, name)
    }
  }
  return null
}

// ---------------------------------------------------------------- 工作流

const manifest = readManifest()
say('')
say('== 工作流 ==')
say('清单      ' + manifest.items.length + ' 份' + (manifest.warnings.length > 0 ? '（' + manifest.warnings.join('；') + '）' : ''))

const missingByGroup = { unet: new Set(), clip: new Set(), vae: new Set(), loras: new Set(), checkpoints: new Set() }
for (const item of manifest.items) {
  const summary = item.summary ?? {}
  const needed = []
  for (const name of summary.unet ?? []) needed.push({ group: 'unet', name })
  for (const name of summary.clip ?? []) needed.push({ group: 'clip', name })
  for (const name of summary.vae ?? []) needed.push({ group: 'vae', name })
  for (const name of summary.checkpoints ?? []) needed.push({ group: 'checkpoints', name })
  for (const lora of summary.loras ?? []) needed.push({ group: 'loras', name: typeof lora === 'string' ? lora : lora?.name })
  const missing = []
  for (const need of needed) {
    if (typeof need.name !== 'string' || need.name.length === 0) continue
    if (findFile(need.group, need.name) !== null) continue
    missing.push(need)
    missingByGroup[need.group].add(need.name)
  }
  report.workflows.push({ id: item.id, title: item.title, ready: missing.length === 0, missing: missing.map((m) => m.name) })
}

for (const row of report.workflows) {
  const mark = row.ready ? '✓' : '⚠'
  say(mark + ' ' + row.title + (row.ready ? '' : ' —— 缺 ' + row.missing.join('、')))
}

const missingAll = [...missingByGroup.unet, ...missingByGroup.clip, ...missingByGroup.vae, ...missingByGroup.checkpoints, ...missingByGroup.loras]
if (missingAll.length > 0) {
  say('')
  say('== 缺的文件（按目录放置） ==')
  for (const group of ['unet', 'clip', 'vae', 'checkpoints', 'loras']) {
    for (const name of missingByGroup[group]) {
      say('✗ ' + name)
      say('   ' + downloadHint(name, group))
    }
  }
  report.warnings.push('有 ' + missingAll.length + ' 个模型文件缺失，对应工作流会标 ⚠')
}

// ---------------------------------------------------------------- 结论

say('')
say('== 结论 ==')
if (report.ok && report.warnings.length === 0) {
  say('全部就绪：配置、ComfyUI、模型都对得上，可以直接出图。')
} else {
  for (const problem of report.problems) say('✗ ' + problem)
  for (const warning of report.warnings) say('! ' + warning)
}
say('')
if (config === null) {
  say('== 最小配置模板（写到上面那个 config.json，三个路径按实际改） ==')
  const template = {
    comfyRoot: comfyRoot ?? 'C:/Comfyui Driver/ComfyUI/ComfyUI',
    comfyUrl: null,
    output: 'C:/DSH生图',
    workspaceId: null,
    workspacePath: null,
    workflow: 'moss__moss-4step',
    checkpoint: 'moss_image_sft_int8_convrot.safetensors',
    loras: [],
    width: 1024,
    height: 1024,
    steps: 4,
    characterKbRoot: null,
    characterAnchor: true,
    rewritePersona: true,
  }
  say(JSON.stringify(template, null, 2))
  report.template = template
}
say('下一步：按上面提示补齐后重启 ComfyUI；页面点「刷新」再看工作流下拉。详细步骤见 SETUP.md。')

if (JSON_OUT) console.log(JSON.stringify(report, null, 2))
