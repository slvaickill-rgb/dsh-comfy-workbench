/**
 * lib/workflows.js — 工作台自己的工作流目录。
 *
 * 目录：<repo>/workflows/，由 tools/import-workflows.mjs 从 comfyui-* 技能导入，
 * 每份一个 *.api.json + 一份 index.json 汇总（标题、来源技能、模型需求、采样参数）。
 *
 * 页面只认这里的 id；不再直接把技能目录里的路径硬编码进来。
 * 兼容旧配置：`state.workflow` 里还是绝对路径时照样能用（文件在就放行）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 工作流目录（只读）。 */
export const WORKFLOW_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workflows')
const MANIFEST = path.join(WORKFLOW_DIR, 'index.json')

let cache = { stamp: '', manifest: null }

function statStamp(file) {
  try {
    const stat = fs.statSync(file)
    return String(stat.mtimeMs) + ':' + String(stat.size)
  } catch {
    return ''
  }
}

/**
 * 读汇总清单（按 mtime+size 缓存）。
 * @returns `{ dir, importedAt, items, warnings }`；清单缺失时 `items: []`。
 */
export function readManifest() {
  const stamp = statStamp(MANIFEST)
  if (stamp.length === 0) return { dir: WORKFLOW_DIR, importedAt: null, items: [], warnings: ['没有 workflows/index.json：先跑 node tools/import-workflows.mjs'] }
  if (cache.stamp === stamp && cache.manifest !== null) return cache.manifest
  try {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
    const items = Array.isArray(parsed?.items) ? parsed.items : []
    const manifest = {
      dir: WORKFLOW_DIR,
      importedAt: typeof parsed?.importedAt === 'string' ? parsed.importedAt : null,
      warnings: Array.isArray(parsed?.warnings) ? parsed.warnings : [],
      items: items.map((item) => ({
        id: String(item.id ?? ''),
        file: String(item.file ?? ''),
        title: String(item.title ?? item.id ?? ''),
        skill: String(item.skill ?? ''),
        format: String(item.format ?? ''),
        source: typeof item.source === 'string' ? item.source : null,
        summary: item.summary && typeof item.summary === 'object' ? item.summary : {},
      })),
    }
    cache = { stamp, manifest }
    return manifest
  } catch {
    return { dir: WORKFLOW_DIR, importedAt: null, items: [], warnings: ['workflows/index.json 坏了，重新跑一次导入'] }
  }
}

/**
 * 列工作流：只保留磁盘上真实存在的文件。
 */
export function listWorkflows() {
  const manifest = readManifest()
  const items = manifest.items
    .filter((item) => item.file.length > 0 && fs.existsSync(path.join(WORKFLOW_DIR, item.file)))
    .map((item) => ({ ...item, path: path.join(WORKFLOW_DIR, item.file) }))
  return { ...manifest, items }
}

/**
 * 把 id / 文件名 / 旧配置里的绝对路径解析成可用文件。
 * @param value - 工作流 id、文件名，或绝对路径。
 * @returns 绝对路径；解析不了返回 null。
 */
export function resolveWorkflow(value) {
  const raw = String(value ?? '').trim()
  if (raw.length === 0) return null
  // 旧配置：直接存过绝对路径（老版本 generate 就是这么用的，照旧放行，但只认存在的 .json）。
  if (path.isAbsolute(raw)) {
    if (!raw.toLowerCase().endsWith('.json') || !fs.existsSync(raw)) return null
    return raw
  }
  const manifest = readManifest()
  const hit = manifest.items.find((item) => item.id === raw || item.file === raw)
  if (hit === undefined) return null
  const target = path.join(WORKFLOW_DIR, hit.file)
  if (!fs.existsSync(target)) return null
  return target
}

/**
 * 按 id 取一份工作流的元数据（给页面显示用）。
 */
export function workflowMeta(value) {
  const manifest = readManifest()
  return manifest.items.find((item) => item.id === String(value ?? '')) ?? null
}
