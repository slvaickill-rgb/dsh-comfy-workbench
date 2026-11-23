/**
 * tools/selftest-asset.mjs — 「深度求索中」动图路由的校验单测（不启宿主）。
 *
 * 跑：node tools/selftest-asset.mjs
 * 断言：默认位置能过、缺文件 404、不是 GIF 422、超 2MB 422、反斜杠路径也认。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { THINKING_GIF_DEFAULT, resolveThinkingGif } from '../lib/thinkingAsset.js'

const BS = String.fromCharCode(92)
let failures = 0
let checks = 0

function check(name, fn) {
  try {
    fn()
    checks += 1
    console.log('ok   ' + name)
  } catch (error) {
    failures += 1
    console.log('FAIL ' + name + ' → ' + (error && error.message ? error.message : error))
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function expectCode(configured, code) {
  try {
    resolveThinkingGif(configured)
  } catch (error) {
    assert(error.code === code, '期望 ' + code + '，实际 ' + error.code + '（' + error.message + '）')
    return
  }
  throw new Error('期望抛 ' + code + '，实际通过了')
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-comfy-asset-'))
const notGif = path.join(tmp, 'not-a-gif.gif')
fs.writeFileSync(notGif, 'this is not a gif', 'utf8')
const tooBig = path.join(tmp, 'too-big.gif')
fs.writeFileSync(tooBig, Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(3 * 1024 * 1024, 0)]))
const textFile = path.join(tmp, 'note.txt')
fs.writeFileSync(textFile, 'hello', 'utf8')

check('默认位置就是 C:/DSH/深度求索中.gif', () => {
  assert(THINKING_GIF_DEFAULT === 'C:/DSH/深度求索中.gif', '默认值变了：' + THINKING_GIF_DEFAULT)
})

check('空配置 → 用默认那份，227825 字节', () => {
  const hit = resolveThinkingGif(null)
  assert(hit.file === path.resolve(THINKING_GIF_DEFAULT), '解析出的路径不对：' + hit.file)
  assert(hit.stat.size === 227825, '字节数变了：' + hit.stat.size)
})

check('正斜杠 / 反斜杠两种写法都认', () => {
  const forward = resolveThinkingGif(THINKING_GIF_DEFAULT)
  const backward = resolveThinkingGif('C:' + BS + 'DSH' + BS + '深度求索中.gif')
  assert(forward.file === backward.file, '两种写法解析到不同文件')
})

check('文件不存在 → asset-missing', () => {
  expectCode(path.join(tmp, 'missing.gif'), 'asset-missing')
})

check('扩展名不是 .gif → asset-invalid', () => {
  expectCode(textFile, 'asset-invalid')
})

check('内容不是 GIF → asset-invalid', () => {
  expectCode(notGif, 'asset-invalid')
})

check('超过 2MB → asset-invalid', () => {
  expectCode(tooBig, 'asset-invalid')
})

check('相对路径 → asset-invalid', () => {
  expectCode('深度求索中.gif', 'asset-invalid')
})

fs.rmSync(tmp, { recursive: true, force: true })

console.log('')
if (failures > 0) {
  console.log('有 ' + failures + ' 项没通过')
  process.exitCode = 1
} else {
  console.log('全部 ' + checks + ' 项通过')
}
