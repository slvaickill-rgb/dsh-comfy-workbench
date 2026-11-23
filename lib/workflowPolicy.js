/**
 * lib/workflowPolicy.js — 判定「这份工作流的反向提示词到底生不生效」。
 *
 * 依据是 ComfyUI 自己：`comfy/samplers.py` 的 sampling_function 在 cond_scale === 1
 * 时把 uncond_ 置空，cfg_result 直接等于 cond_pred——负面分支根本不参与采样。
 * 所以 cfg=1 的工作流里往反向框写词是纯浪费，甚至会让人误以为生效。
 *
 * 这里只读文件、不调模型；纯 Node 内置，没有第三方依赖。
 */

import fs from 'node:fs'
import path from 'node:path'

import { readManifest, resolveWorkflow } from './workflows.js'

/** 列表里都找不到工作流时的兜底（与 generate() 的顺序一致）。 */
export const DEFAULT_WORKFLOW_ID = 'anima__Anima Aesthetic v1.1'

/** 采样器类名统一前缀：KSampler / KSamplerAdvanced / KSampler (Efficient) 都算。 */
const SAMPLER_PREFIX = 'KSampler'

/** 按 mtime+size 缓存的 API 图，11 份加起来也就几百 KB。 */
const graphCache = new Map()

function loadGraph(file) {
  const key = String(file ?? '')
  if (key.length === 0) return null
  let stamp = ''
  try {
    const stat = fs.statSync(key)
    stamp = String(stat.mtimeMs) + ':' + String(stat.size)
  } catch {
    return null
  }
  const hit = graphCache.get(key)
  if (hit !== undefined && hit.stamp === stamp) return hit.graph
  try {
    const parsed = JSON.parse(fs.readFileSync(key, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    graphCache.set(key, { stamp, graph: parsed })
    return parsed
  } catch {
    return null
  }
}

function linkTarget(value) {
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null
}

/**
 * 顺着 link 找「真正装着人写的那段字」的节点。
 * 与 comfy.js 的 patchWorkflow 同一套思路：MOSS 开关版把文本串成
 * StringConcatenate(PrimitiveString, PrimitiveString)，直接读 CLIPTextEncode 会没有 text。
 */
function findTextSlot(graph, startId, depth = 0) {
  if (typeof startId !== 'string' || depth > 6) return null
  const node = graph[startId]
  if (node === undefined || node === null) return null
  if (typeof node.inputs?.text === 'string') return { id: startId, field: 'text' }
  if (typeof node.inputs?.value === 'string') return { id: startId, field: 'value' }
  const candidates = []
  for (const field of ['text', 'value', 'string_a', 'string_b']) {
    const upstream = linkTarget(node.inputs?.[field])
    if (upstream === null) continue
    const slot = findTextSlot(graph, upstream, depth + 1)
    if (slot === null) continue
    candidates.push({ ...slot, length: String(graph[slot.id]?.inputs?.[slot.field] ?? '').length })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.length - a.length)
  return { id: candidates[0].id, field: candidates[0].field }
}

function samplerIds(graph) {
  return Object.keys(graph)
    .filter((id) => typeof graph[id]?.class_type === 'string' && graph[id].class_type.startsWith(SAMPLER_PREFIX))
    .sort((a, b) => {
      const na = Number(a)
      const nb = Number(b)
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
      return a < b ? -1 : (a > b ? 1 : 0)
    })
}

/** cfg 是字面量就给数；是连线（MOSS 开关版的 ComfySwitchNode）就标 cfgLinked。 */
function samplerCfg(graph, ids) {
  for (const id of ids) {
    const inputs = graph[id]?.inputs ?? {}
    if (!('cfg' in inputs)) continue
    const value = inputs.cfg
    if (typeof value === 'number' && Number.isFinite(value)) return { cfg: value, cfgLinked: false }
    if (Array.isArray(value)) return { cfg: null, cfgLinked: true }
  }
  return { cfg: null, cfgLinked: false }
}

/** 采样器 negative 连线上能不能反查到文本节点；查不到就写不进去。 */
function negativeSlot(graph, ids) {
  for (const id of ids) {
    const target = linkTarget(graph[id]?.inputs?.negative)
    if (target === null) continue
    const slot = findTextSlot(graph, target)
    if (slot !== null) return slot
  }
  return null
}

/** 工作流风格口径：决定第二阶段用什么改写模板。 */
export function styleOfSkill(skill) {
  const value = String(skill ?? '').toLowerCase()
  if (value.includes('moss')) return 'moss'
  if (value.includes('anima')) return 'anima'
  if (value.includes('wai')) return 'wai'
  return 'unknown'
}

function metaFor(file) {
  const base = path.basename(String(file ?? ''))
  try {
    const items = readManifest().items
    return items.find((item) => item.file === base) ?? null
  } catch {
    return null
  }
}

/** 工作流文件缺失 / 读不出来时的保守值：按「负面可能生效」处理，但不给写不进去的谎。 */
function unresolved(file, reason) {
  return {
    workflowId: null,
    title: file === null ? null : path.basename(String(file)),
    skill: null,
    style: 'unknown',
    cfg: null,
    cfgLinked: false,
    steps: null,
    hasNegativeSlot: false,
    negativeDefault: '',
    negativeEffective: true,
    negativeNode: null,
    file: file === null ? null : String(file),
    reason,
  }
}

/**
 * 产出一份判定策略。
 * @param workflowId - 页面当前选的工作流 id（可为空）。
 * @param fallbackId - 页面没选时的兜底（通常是配置里的 state.workflow）。
 * @returns §5.2 的 policy 对象；任何一步读不到都不抛，只把 reason 写清楚。
 */
export function policyFor(workflowId, fallbackId = null) {
  const candidates = [String(workflowId ?? '').trim(), String(fallbackId ?? '').trim(), DEFAULT_WORKFLOW_ID]
  let file = null
  let usedId = null
  for (const candidate of candidates) {
    if (candidate.length === 0) continue
    const resolved = resolveWorkflow(candidate)
    if (resolved !== null) {
      file = resolved
      usedId = candidate
      break
    }
  }
  if (file === null) return unresolved(null, '找不到任何工作流文件：按「负面可能生效」保守处理')
  const graph = loadGraph(file)
  if (graph === null) return unresolved(file, '工作流文件读不出来：按「负面可能生效」保守处理')

  const meta = metaFor(file)
  const ids = samplerIds(graph)
  const { cfg, cfgLinked } = samplerCfg(graph, ids)
  const slot = negativeSlot(graph, ids)
  const negativeDefault = slot === null ? '' : String(graph[slot.id]?.inputs?.[slot.field] ?? '')

  let negativeEffective = true
  let reason = ''
  if (cfgLinked) {
    reason = 'cfg 由工作流连线决定（开关版可能切到 cfg>1），按可能生效处理'
  } else if (typeof cfg === 'number' && Math.abs(cfg - 1) < 1e-6) {
    negativeEffective = false
    reason = 'cfg=1：ComfyUI sampling_function 丢弃 uncond 分支，负面提示词不参与采样'
  } else if (typeof cfg === 'number') {
    reason = 'cfg=' + String(cfg) + '：负面分支参与采样'
  } else {
    reason = '读不到 cfg：按「负面可能生效」保守处理'
  }
  if (slot === null) {
    negativeEffective = false
    reason = reason + '；采样器负面连线上没有文本节点，写不进去'
  }

  return {
    workflowId: meta?.id ?? (usedId === null ? null : usedId),
    title: meta?.title ?? path.basename(file),
    skill: meta?.skill ?? null,
    style: styleOfSkill(meta?.skill),
    cfg: typeof cfg === 'number' ? cfg : null,
    cfgLinked,
    steps: Number.isFinite(meta?.summary?.steps) ? meta.summary.steps : null,
    hasNegativeSlot: slot !== null,
    negativeDefault,
    negativeEffective,
    negativeNode: slot === null ? null : { id: slot.id, field: slot.field, classType: String(graph[slot.id]?.class_type ?? '') },
    file: String(file),
    reason,
  }
}

export default { policyFor, styleOfSkill, DEFAULT_WORKFLOW_ID }
