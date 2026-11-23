/**
 * tools/selftest-buildinfo.mjs — 版本与 commit 读取的桩测（不联网、不需要 git 命令）。
 */

import fs from 'node:fs'
import path from 'node:path'

import { readBuildInfo } from '../lib/buildInfo.js'

let checks = 0
let failures = 0

function check(name, fn) {
  try {
    fn()
    checks += 1
    console.log('ok   ' + name)
  } catch (error) {
    failures += 1
    console.log('FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error)))
  }
}

function assert(cond, message) { if (!cond) throw new Error(message || '断言失败') }

const info = readBuildInfo()

check('版本号与 package.json 一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\//, ''), '..', 'package.json'), 'utf8'))
  assert(typeof info.version === 'string' && /^\d+\.\d+\.\d+/.test(info.version), '版本号格式不对：' + info.version)
  assert(info.version === pkg.version, '与 package.json 不一致：' + info.version + ' vs ' + pkg.version)
})

check('commit 是 40 位 sha 或 null', () => {
  assert(info.commit === null || /^[0-9a-f]{40}$/.test(info.commit), 'commit 不合法：' + info.commit)
})

check('commitShort 是 commit 前 7 位', () => {
  if (info.commit === null) { assert(info.commitShort === null, 'commit 为空时短号也应为空'); return }
  assert(info.commitShort === info.commit.slice(0, 7), '短号不对：' + info.commitShort)
})

check('root 指向仓库根', () => {
  assert(fs.existsSync(path.join(info.root, 'package.json')), 'root 下没有 package.json：' + info.root)
})

if (failures === 0) console.log('全部 ' + checks + ' 项通过')
else { console.log('有 ' + failures + ' 项没通过'); process.exitCode = 1 }
