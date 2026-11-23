/**
 * lib/thinkingAsset.js — 「深度求索中」动图的路径校验。
 *
 * 单独成文件只为能脱离宿主测：index.js 会 import cordis，本机没有独立可用的那份包，
 * 一 import 就起不来；把纯校验抽出来后，`node tools/selftest-asset.mjs` 就能把 404/422 跑一遍。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 用户指定的就是 C:/DSH 根目录那份，不复制进 assets/、不改原图。 */
export const THINKING_GIF_DEFAULT = 'C:/DSH/深度求索中.gif'

/** 上限 2 MB：一张 480×160 的动图 227 KB，超了基本不是这张。 */
export const THINKING_GIF_MAX_BYTES = 2 * 1024 * 1024

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

/** 读文件头 6 字节，认 GIF87a / GIF89a。 */
function magicOf(file) {
  const handle = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(6)
    fs.readSync(handle, head, 0, 6, 0)
    return head.toString('latin1')
  } finally {
    fs.closeSync(handle)
  }
}

/**
 * 校验并返回可发送的文件。
 * @param configured - state.thinkingGif；空则用默认位置。
 * @returns `{ file, stat }`
 * @throws `asset-missing`（文件不在）/ `asset-invalid`（不是绝对路径、不是 .gif、超 2 MB、magic 不对）
 */
export function resolveThinkingGif(configured) {
  const raw = typeof configured === 'string' && configured.trim().length > 0
    ? configured.trim()
    : THINKING_GIF_DEFAULT
  if (!path.isAbsolute(raw)) throw fail('asset-invalid', 'thinkingGif 必须是绝对路径：' + raw)
  const file = path.resolve(raw)
  if (path.extname(file).toLowerCase() !== '.gif') throw fail('asset-invalid', 'thinkingGif 不是 .gif：' + raw)
  let stat = null
  try {
    stat = fs.statSync(file)
  } catch {
    throw fail('asset-missing', '动图不存在：' + file)
  }
  if (!stat.isFile()) throw fail('asset-missing', '动图不是普通文件：' + file)
  if (stat.size > THINKING_GIF_MAX_BYTES) throw fail('asset-invalid', '动图超过 2MB：' + stat.size + ' 字节')
  let magic = ''
  try {
    magic = magicOf(file)
  } catch {
    throw fail('asset-invalid', '动图读不出来：' + file)
  }
  if (magic !== 'GIF87a' && magic !== 'GIF89a') {
    throw fail('asset-invalid', '不是 GIF（magic=' + magic + '）：' + file)
  }
  return { file, stat }
}

export default { resolveThinkingGif, THINKING_GIF_DEFAULT, THINKING_GIF_MAX_BYTES }
