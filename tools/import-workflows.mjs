#!/usr/bin/env node
/**
 * tools/import-workflows.mjs — 把 comfyui-* 技能里的工作流导进工作台。
 *
 *   node tools/import-workflows.mjs            # 导入/更新
 *   node tools/import-workflows.mjs --dry-run  # 只看会做什么
 *
 * 三处来源：
 *   ~/.workbuddy/skills/comfyui-anima/workflows/*.api.json   （已是 API 版，直接拷）
 *   ~/.workbuddy/skills/comfyui-wai/workflows/*.api.json     （同上）
 *   ~/.workbuddy/skills/comfyui-moss/workflows/*.ui.json     （UI 版，这里转成 API）
 *
 * 产物：
 *   <repo>/workflows/<skill>__<名字>.api.json   每份一个文件（插件只读它们）
 *   <repo>/workflows/index.json                 汇总：标题、来源、模型需求、采样参数
 *
 * UI 版转换规则和 comfyui-moss/scripts/run-workflow.mjs 一致：
 * widgets_values 按前端控件顺序映射成输入名，control_after_generate / upload 丢掉；
 * Reroute 顺着链路穿过去；Note / Label 这类纯前端节点直接丢。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'workflows')
const SKILLS = path.join(os.homedir(), '.workbuddy', 'skills')
const DRY = process.argv.includes('--dry-run')

/** UI 节点类型 → widgets_values 顺序（来自 comfyui-moss 的实测表）。 */
const WIDGET_NAMES = {
  UNETLoader: ['unet_name', 'weight_dtype'],
  CLIPLoader: ['clip_name', 'type', 'device'],
  VAELoader: ['vae_name'],
  LoraLoaderModelOnly: ['lora_name', 'strength_model'],
  LoraLoader: ['lora_name', 'strength_model', 'strength_clip'],
  ModelSamplingAuraFlow: ['shift', 'sampling'],
  SkipLayerGuidanceDiTSimple: ['double_layers', 'single_layers', 'start_percent', 'end_percent'],
  SkipLayerGuidanceDiT: ['double_layers', 'single_layers', 'start_percent', 'end_percent'],
  EmptyFlux2LatentImage: ['width', 'height', 'batch_size'],
  EmptyLatentImage: ['width', 'height', 'batch_size'],
  CLIPTextEncode: ['text'],
  KSampler: ['seed', 'control_after_generate', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
  KSamplerAdvanced: ['add_noise', 'noise_seed', 'control_after_generate', 'steps', 'start_at_step', 'end_at_step', 'cfg', 'sampler_name', 'scheduler', 'return_with_leftover_noise'],
  VAEDecode: [],
  VAEEncode: [],
  LoadImage: ['image', 'upload'],
  ImageScale: ['upscale_method', 'width', 'height', 'crop'],
  SaveImage: ['filename_prefix'],
  PreviewImage: [],
  PrimitiveBoolean: ['value'],
  PrimitiveInt: ['value', 'control_after_generate'],
  PrimitiveFloat: ['value'],
  PrimitiveString: ['value'],
  PrimitiveStringMultiline: ['value'],
  StringConcatenate: ['string_a', 'string_b', 'delimiter'],
  ComfySwitchNode: ['switch'],
  Reroute: null,
  Note: null,
  MarkdownNote: null,
  'Label (rgthree)': null,
  Label: null,
}

/** moss 工作流的触发词/说明（来自 comfyui-moss/scripts/flow.mjs）。 */
const MOSS_TITLES = {
  'moss-4step': '四步 · 4 步蒸馏档（默认，30 秒）',
  'moss-anime-switch': '开关 · 一键切 8 步加速 / 50 步画质',
  'moss-anireal': '写实 · Anireal 2.5D',
  'moss-skalip': '塞卡 · SekaLip 平涂赛璐璐',
  'moss-muqiu': '木秋 · 固定角色（自动补 muqiu）',
  'moss-ffstyle-25step': 'nai5 · FFstyle 12 步 / CFG 4',
  'moss-ffstyle': 'nai5快 · FFstyle 四步加速档',
  'moss-betternude-8step': '八步 · 8 步 DMD 高细节',
  'moss-betternude': '八步 · 完整版（UI 里默认参数）',
}

/**
 * 本地剥离规则：主人明确不要的 LoRA。只作用于工作台导入的副本，
 * 技能目录里的源工作流一个字节都不动。
 * 2026-11-23：一度剔掉「木秋」的固定角色 muqiu_moss.safetensors；当天晚上主人要求装回，
 * 规则清空——以后要卸哪条，往这张表里加一行即可，不加就是全量保留。
 */
const LOCAL_STRIP_LORAS = {}

/**
 * 删掉指定名字的 LoRA 节点，并把下游的 model 连线接到它的上游。
 * 只处理 LoraLoader* 这类挂在 model 链上的节点；找不到上游就报错，不交半张断了链的图。
 * @returns 被删掉的 LoRA 名字数组
 */
function stripLoras(graph, names) {
  const wanted = new Set(names.map((name) => String(name).toLowerCase()))
  if (wanted.size === 0) return []
  const dropped = []
  for (const [id, node] of Object.entries(graph)) {
    const lora = node?.inputs?.lora_name
    if (typeof lora !== 'string' || !wanted.has(lora.toLowerCase())) continue
    const upstream = Array.isArray(node.inputs?.model) ? node.inputs.model : null
    if (upstream === null) throw new Error('剥落 ' + lora + ' 失败：节点 ' + id + ' 没有 model 上游')
    for (const other of Object.values(graph)) {
      const inputs = other?.inputs
      if (!inputs || typeof inputs !== 'object') continue
      for (const [field, value] of Object.entries(inputs)) {
        if (Array.isArray(value) && value[0] === id) inputs[field] = upstream
      }
    }
    delete graph[id]
    dropped.push(lora)
  }
  return dropped
}

const warns = []

/** Reroute 链：一直追到真正的源节点。 */
function resolveSource(link, nodesById, linkById) {
  let nodeId = link[1]
  let slot = link[2]
  for (let guard = 0; guard < 32; guard += 1) {
    const node = nodesById.get(nodeId)
    if (node === undefined) return null
    if (node.type !== 'Reroute') return { nodeId: String(nodeId), slot }
    const inbound = (node.inputs || []).find((input) => input.link !== null && input.link !== undefined)
    if (inbound === undefined) return null
    const next = linkById.get(inbound.link)
    if (next === undefined) return null
    nodeId = next[1]
    slot = next[2]
  }
  return null
}

function toApi(ui, label) {
  const nodes = Array.isArray(ui.nodes) ? ui.nodes : []
  const links = Array.isArray(ui.links) ? ui.links : []
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const linkById = new Map(links.map((link) => [link[0], link]))
  const api = {}

  for (const node of nodes) {
    if (!(node.type in WIDGET_NAMES)) throw new Error(label + '：未知节点类型 ' + node.type + '（id ' + node.id + '）')
    const names = WIDGET_NAMES[node.type]
    if (names === null) continue
    const inputs = {}
    const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : []
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i]
      if (name === 'control_after_generate' || name === 'upload') continue
      if (i < widgets.length) inputs[name] = widgets[i]
    }
    for (const input of node.inputs || []) {
      if (input.link === null || input.link === undefined) continue
      const link = linkById.get(input.link)
      if (link === undefined) throw new Error(label + '：节点 ' + node.id + ' 的输入 ' + input.name + ' 指向不存在的连线 ' + input.link)
      const source = resolveSource(link, nodesById, linkById)
      if (source === null) throw new Error(label + '：连线 ' + input.link + ' 追不到源节点（Reroute 链断了）')
      inputs[input.name] = [source.nodeId, source.slot]
    }
    api[node.id] = { class_type: node.type, inputs }
  }

  // 每一根链的目标节点都必须真的落在 api 里，否则 ComfyUI 会 400。
  for (const [id, node] of Object.entries(api)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string') continue
      if (!(value[0] in api)) {
        throw new Error(label + '：节点 ' + id + ' 的输入 ' + name + ' 指向 ' + value[0] + '，那个节点被当成纯前端节点丢掉后没人接')
      }
    }
  }
  return api
}

/** 从 API 图里抽模型需求与采样参数。 */
function summarize(graph) {
  const pick = (types, field) => {
    const out = []
    for (const node of Object.values(graph)) {
      if (!types.includes(node.class_type)) continue
      const value = node.inputs?.[field]
      if (typeof value === 'string' && value.length > 0 && !out.includes(value)) out.push(value)
    }
    return out
  }
  const samplers = Object.values(graph).filter((node) => node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced')
  const first = samplers[0]?.inputs ?? {}
  // 反向提示词：顺着采样器 negative 连线找文本节点（与 lib/workflowPolicy.js 同一套思路），
  // 给页面显示「留空即用默认值：…」以及判断负面到底生不生效。
  const linkTarget = (value) => (Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null)
  const findText = (startId, depth = 0) => {
    if (typeof startId !== 'string' || depth > 6) return null
    const node = graph[startId]
    if (!node) return null
    if (typeof node.inputs?.text === 'string') return { id: startId, field: 'text' }
    if (typeof node.inputs?.value === 'string') return { id: startId, field: 'value' }
    const found = []
    for (const field of ['text', 'value', 'string_a', 'string_b']) {
      const upstream = linkTarget(node.inputs?.[field])
      if (upstream === null) continue
      const slot = findText(upstream, depth + 1)
      if (slot === null) continue
      found.push({ ...slot, length: String(graph[slot.id]?.inputs?.[slot.field] ?? '').length })
    }
    if (found.length === 0) return null
    found.sort((a, b) => b.length - a.length)
    return { id: found[0].id, field: found[0].field }
  }
  const negativeStart = linkTarget(samplers[0]?.inputs?.negative)
  const negativeSlot = negativeStart === null ? null : findText(negativeStart)
  const latent = Object.values(graph).find((node) => node.class_type === 'EmptyLatentImage' || node.class_type === 'EmptyFlux2LatentImage')
  const save = Object.values(graph).find((node) => node.class_type === 'SaveImage')
  const hasUnet = Object.values(graph).some((node) => node.class_type === 'UNETLoader' || node.class_type === 'UnetLoaderGGUF')
  const hasCheckpoint = Object.values(graph).some((node) => node.class_type === 'CheckpointLoaderSimple')
  return {
    loader: hasUnet ? 'unet' : (hasCheckpoint ? 'checkpoint' : null),
    unet: [...pick(['UNETLoader', 'UnetLoaderGGUF'], 'unet_name')],
    checkpoints: pick(['CheckpointLoaderSimple'], 'ckpt_name'),
    vae: pick(['VAELoader'], 'vae_name'),
    clip: [...pick(['CLIPLoader'], 'clip_name'), ...pick(['DualCLIPLoader'], 'clip_name1'), ...pick(['DualCLIPLoader'], 'clip_name2')],
    loras: Object.values(graph)
      .filter((node) => node.class_type === 'LoraLoaderModelOnly' || node.class_type === 'LoraLoader')
      .map((node) => ({ name: node.inputs?.lora_name, strength: node.inputs?.strength_model }))
      .filter((entry) => typeof entry.name === 'string'),
    samplers: samplers.length,
    steps: first.steps ?? null,
    cfg: first.cfg ?? null,
    // cfg 是连线（MOSS 开关版的 ComfySwitchNode）→ true；页面据此按「可能生效」保守处理。
    cfgLinked: Array.isArray(first.cfg),
    negativeNode: negativeSlot === null ? null : negativeSlot.id,
    negativeDefault: negativeSlot === null ? '' : String(graph[negativeSlot.id]?.inputs?.[negativeSlot.field] ?? ''),
    denoise: first.denoise ?? null,
    width: latent?.inputs?.width ?? null,
    height: latent?.inputs?.height ?? null,
    savePrefix: save?.inputs?.filename_prefix ?? null,
    nodes: Object.keys(graph).length,
  }
}

/**
 * 本地采样补丁：技能目录里的 anima 工作流文件还是旧的 hires 两段（cfg 1 / er_sde），
 * 与 comfyui-anima skill 正文的 style 档（16 步 / cfg 4 / dpmpp_2m + sgm_uniform，单段不放大）不一致。
 * 只改导入副本，源文件一个字节不动；口径要改就改这里。
 */
const ANIMA_NEGATIVE_DEFAULT = 'extra limbs, extra fingers, bad anatomy'

function patchAnimaStyle(graph) {
  const notes = []
  const samplers = Object.keys(graph).filter((id) => graph[id]?.class_type === 'KSampler')
  for (const id of samplers) {
    const inputs = graph[id]?.inputs
    if (!inputs || typeof inputs !== 'object') continue
    inputs.steps = 16
    inputs.cfg = 4
    inputs.sampler_name = 'dpmpp_2m'
    inputs.scheduler = 'sgm_uniform'
  }
  // 去掉二段放大：SaveImage 改接第一段解码，删掉 upscale → sampler → decode 三件套
  for (const [id, node] of Object.entries(graph)) {
    if (node?.class_type !== 'SaveImage') continue
    const decodeId = Array.isArray(node.inputs?.images) ? node.inputs.images[0] : null
    const decode = decodeId !== null ? graph[decodeId] : null
    const secondSamplerId = decode && Array.isArray(decode.inputs?.samples) ? decode.inputs.samples[0] : null
    const secondSampler = secondSamplerId !== null ? graph[secondSamplerId] : null
    const upscaleId = secondSampler && Array.isArray(secondSampler.inputs?.latent_image) ? secondSampler.inputs.latent_image[0] : null
    if (upscaleId === null || graph[upscaleId]?.class_type !== 'LatentUpscaleBy') continue
    const firstSamplerId = Array.isArray(graph[upscaleId].inputs?.samples) ? graph[upscaleId].inputs.samples[0] : null
    const firstDecodeId = Object.keys(graph).find((key) => graph[key]?.class_type === 'VAEDecode'
      && Array.isArray(graph[key].inputs?.samples) && graph[key].inputs.samples[0] === firstSamplerId)
    if (typeof firstDecodeId !== 'string') { notes.push('anima：找不到第一段解码，保留二段放大'); continue }
    node.inputs.images = [firstDecodeId, 0]
    delete graph[upscaleId]
    delete graph[secondSamplerId]
    delete graph[decodeId]
    notes.push('anima：改单段 style 档（去掉 hires 二段）')
  }
  // 负面空着就填结构词（cfg 4 下才有效）
  for (const node of Object.values(graph)) {
    if (node?.class_type !== 'KSampler') continue
    const negId = Array.isArray(node.inputs?.negative) ? node.inputs.negative[0] : null
    const neg = negId !== null ? graph[negId] : null
    if (neg && neg.class_type === 'CLIPTextEncode' && typeof neg.inputs?.text === 'string' && neg.inputs.text.trim().length === 0) {
      neg.inputs.text = ANIMA_NEGATIVE_DEFAULT
      notes.push('anima：负面填结构词')
    }
  }
  return notes
}

function listFiles(dir, suffix) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(suffix))
      .map((entry) => path.join(dir, entry.name))
      .sort()
  } catch {
    return []
  }
}

const items = []
const sources = []

function addSource(skill, file, graph, format) {
  const base = path.basename(file).replace(/\.(api|ui)\.json$/i, '').replace(/\.json$/i, '')
  const id = skill.replace(/^comfyui-/, '') + '__' + base
  const fileName = id + '.api.json'
  const title = MOSS_TITLES[base] ?? base
  const stripped = stripLoras(graph, LOCAL_STRIP_LORAS[base] ?? [])
  const patched = base === 'Anima Aesthetic v1.1' ? patchAnimaStyle(graph) : []
  const summary = summarize(graph)
  if (stripped.length > 0) summary.strippedLoras = stripped
  if (patched.length > 0) summary.localPatch = patched
  items.push({
    id,
    file: fileName,
    title,
    skill,
    format,
    source: file,
    summary,
  })
  if (!DRY) {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(path.join(OUT_DIR, fileName), JSON.stringify(graph, null, 2) + '\n', 'utf8')
  }
  sources.push({ skill, file, id })
}

// 1) 已经是 API 版的：直接拷
for (const skill of ['comfyui-anima', 'comfyui-wai']) {
  const dir = path.join(SKILLS, skill, 'workflows')
  const files = listFiles(dir, '.api.json')
  if (files.length === 0) warns.push(skill + '：没找到 *.api.json')
  for (const file of files) {
    try {
      const graph = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!graph || typeof graph !== 'object' || Array.isArray(graph)) throw new Error('不是对象')
      const first = Object.values(graph)[0]
      if (!first || typeof first !== 'object' || !('class_type' in first)) throw new Error('不是 API 版（缺少 class_type）')
      addSource(skill, file, graph, 'api')
    } catch (error) {
      warns.push(skill + ' / ' + path.basename(file) + '：' + error.message)
    }
  }
}

// 2) UI 版：转 API
for (const skill of ['comfyui-moss']) {
  const dir = path.join(SKILLS, skill, 'workflows')
  const files = listFiles(dir, '.ui.json')
  if (files.length === 0) warns.push(skill + '：没找到 *.ui.json')
  for (const file of files) {
    try {
      const ui = JSON.parse(fs.readFileSync(file, 'utf8'))
      const graph = toApi(ui, path.basename(file))
      addSource(skill, file, graph, 'ui→api')
    } catch (error) {
      warns.push(skill + ' / ' + path.basename(file) + '：' + error.message)
    }
  }
}

const manifest = {
  version: 1,
  importedAt: new Date().toISOString(),
  skillsRoot: SKILLS,
  items,
  warnings: warns,
}
if (!DRY) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}

console.log(JSON.stringify({
  dryRun: DRY,
  out: OUT_DIR,
  imported: items.map((item) => item.id + ' ← ' + item.format + ' · ' + item.summary.nodes + ' 节点'),
  warnings: warns,
}, null, 1))
