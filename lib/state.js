/**
 * lib/state.js — 插件自己的配置落盘。
 *
 * 放 `~/.dsh/profiles/desktop/.dsh-comfy/config.json`，不碰宿主核心 storage，
 * 也不写进工作流（ComfyUI 的 Prompt-Agent 节点会把 key 写进工作流文件，那套不学）。
 * 所有写入走临时文件 + rename，半个 JSON 不会留在盘上。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_STATE = {
  workspaceId: null,
  workspacePath: null,
  workspaceAlias: '代码开发',
  comfyUrl: null,
  comfyRoot: null,
  input: null,
  output: null,
  launchScript: null,
  workflow: null,
  checkpoint: null,
  loras: [],
  width: 768,
  height: 1024,
  steps: 10,
  provider: null,
  model: null,
  lastPrompt: '',
  catalogRoot: null,
  galleryFolder: '',
  previewEnabled: true,
  previewMethod: 'latent2rgb',
  previewLimit: 60,
  // 「大模型改写」busy 时按钮上那张动图；只读引用，不搬文件、不改原图。
  thinkingGif: 'C:/DSH/深度求索中.gif',
  // 单阶段改写超时（毫秒）：判定与改写各自计时。
  rewriteTimeoutMs: 30000,
  // 原文没写「不要什么」时，是否也建议通用质量负面词。默认关。
  rewriteAutoQuality: false,
  // 改写时是否把全局人设（AGENTS.md §4 内容尺度）接进 system prompt。默认开。
  rewritePersona: true,
  // 「角色外貌锚定」：提示词里点名了知识库里有的角色，出图前自动把外貌串插进去（只对 MOSS 工作流）。
  characterAnchor: true,
  // 萌娘百科知识库目录；null = C:\\RP专用目录\\萌娘百科知识库（环境变量 DSH_COMFY_CHAR_KB 优先）。
  characterKbRoot: null,
}

/** 配置目录：优先 profile 内的 `.dsh-comfy`，没有 profile 就落到 harness home 下。 */
export function stateDir() {
  if (process.env.DSH_COMFY_STATE_DIR) return process.env.DSH_COMFY_STATE_DIR
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const profile = path.join(home, 'profiles', 'desktop')
  if (fs.existsSync(profile)) return path.join(profile, '.dsh-comfy')
  return path.join(home, 'comfy-workbench')
}

export function stateFile() {
  return path.join(stateDir(), 'config.json')
}

/** 读配置；文件缺失或坏掉都退回默认值，不让页面白屏。 */
export function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_STATE }
    return { ...DEFAULT_STATE, ...parsed }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

/**
 * 合并写入（只覆盖传进来的键，值为 undefined 的键跳过）。
 * @param patch - 要合并的字段。
 * @returns 合并后的完整配置。
 */
export function writeState(patch = {}) {
  const current = readState()
  const next = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    next[key] = value
  }
  const dir = stateDir()
  fs.mkdirSync(dir, { recursive: true })
  const target = stateFile()
  const temp = target + '.tmp-' + process.pid
  fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  fs.renameSync(temp, target)
  return next
}
