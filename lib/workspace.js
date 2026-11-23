/**
 * lib/workspace.js — DSH 工作区绑定与文本落盘。
 *
 * 三件事：
 *   1. 列工作区（宿主 `ctx.workspaceRegistry.list()`）
 *   2. 绑定一个真实目录：先 mkdir，再在有 registry 时补一条记录
 *   3. 把输入框内容写进 `<工作区>\.dsh-comfy\<日期>.md`，写入前过白名单
 *
 * 「填进会话草稿」不在这里：那是浏览器侧的 `uiWorkspace.startSession`，
 * 只有页面能调，宿主半碰不到。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 插件在绑定工作区里唯一允许写的子目录。 */
export const NOTE_DIR = '.dsh-comfy'

function registryOf(ctx) {
  const registry = ctx.get?.('workspaceRegistry')
  return registry && typeof registry.list === 'function' ? registry : null
}

/** 宿主注册表里的工作区，拍平成页面能直接渲染的形状。 */
export function listWorkspaces(ctx) {
  const registry = registryOf(ctx)
  if (!registry) return []
  let rows = []
  try {
    rows = registry.list()
  } catch {
    return []
  }
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    workspaceId: row.id,
    path: row.path,
    title: row.title || path.basename(row.path) || row.path,
    status: row.status ?? null,
  }))
}

/** 校验一个路径是绝对路径，且落在允许的根里。 */
function assertInside(root, target) {
  const realRoot = (() => {
    try {
      return fs.realpathSync.native(root)
    } catch {
      return path.resolve(root)
    }
  })()
  const realTarget = path.resolve(target)
  const relative = path.relative(realRoot, realTarget)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    const error = new Error('路径越界，拒绝写入：' + target)
    error.code = 'path-outside-workspace'
    throw error
  }
  return realTarget
}

/**
 * 绑定一个目录：不存在就建，没注册就补一条工作区记录。
 * @param ctx - 宿主 Context。
 * @param input - `{ path, title? }`
 */
export async function ensureWorkspace(ctx, input = {}) {
  const raw = String(input.path ?? '').trim()
  if (raw.length === 0) {
    const error = new Error('没有给路径')
    error.code = 'path-required'
    throw error
  }
  if (!path.isAbsolute(raw)) {
    const error = new Error('工作区必须是绝对路径：' + raw)
    error.code = 'path-not-absolute'
    throw error
  }
  fs.mkdirSync(raw, { recursive: true })
  const resolved = fs.realpathSync.native(raw)
  const title = String(input.title ?? '').trim() || path.basename(resolved)

  const existing = listWorkspaces(ctx).find((row) => {
    try {
      return fs.realpathSync.native(row.path) === resolved
    } catch {
      return path.resolve(row.path) === resolved
    }
  })
  if (existing) return { ...existing, created: false }

  const registry = registryOf(ctx)
  if (!registry || typeof registry.create !== 'function') {
    return { workspaceId: null, path: resolved, title, created: false, registered: false }
  }
  const created = await registry.create(resolved, title)
  return {
    workspaceId: created?.id ?? null,
    path: created?.path ?? resolved,
    title: created?.title ?? title,
    created: true,
    registered: true,
  }
}

/** 按绑定解析出真实目录；绑了 id 用 id，否则用记下的 path。 */
export function resolveWorkspacePath(ctx, state) {
  const rows = listWorkspaces(ctx)
  if (state.workspaceId) {
    const hit = rows.find((row) => row.workspaceId === state.workspaceId)
    if (hit) return hit.path
  }
  if (state.workspacePath) return state.workspacePath
  return null
}

function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return {
    day: date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()),
    clock: pad(date.getHours()) + ':' + pad(date.getMinutes()),
  }
}

/**
 * 把文本追加到工作区的 `.dsh-comfy/<日期>.md`。
 * @param workspacePath - 绑定的工作区根目录（必须存在）。
 * @param text - 输入框内容。
 * @returns `{ file, appended }`，file 是绝对路径。
 */
export function writeNote(workspacePath, text) {
  const content = String(text ?? '').trim()
  if (content.length === 0) {
    const error = new Error('输入框是空的，没有可保存的内容')
    error.code = 'empty-input'
    throw error
  }
  if (!workspacePath) {
    const error = new Error('还没有绑定工作区')
    error.code = 'workspace-unbound'
    throw error
  }
  const root = fs.realpathSync.native(workspacePath)
  const dir = assertInside(root, path.join(root, NOTE_DIR))
  fs.mkdirSync(dir, { recursive: true })
  const now = new Date()
  const { day, clock } = stamp(now)
  const file = assertInside(root, path.join(dir, day + '.md'))
  const existed = fs.existsSync(file)
  const block = (existed ? '\n\n' : '') + '## ' + clock + '\n\n' + content + '\n'
  fs.appendFileSync(file, block, 'utf8')
  return { file, appended: existed }
}
