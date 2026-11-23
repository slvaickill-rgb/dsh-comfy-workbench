/**
 * tools/install.mjs — 把插件挂进 desktop profile。
 *
 *   node tools/install.mjs
 *
 * 做两件事：
 *   1. 在 `<profile>/node_modules/dsh-comfy-workbench` 建目录联接（junction）指向本目录，
 *      宿主按真实路径解析，改完源码即可，不用再复制一遍。
 *   2. 校验 profile 的 package.json 里有依赖行和 bundles 条目，缺了直接报出来。
 *
 * 为什么不用复制：复制件与源码会漂移，改一处忘一处；联接只有一份。
 * 为什么必须有依赖行：宿主按安装依赖图 + bundle 列表算 runtime 解析，
 * 只放 node_modules 不写 package.json 会被跳过。同理，`@deepseek-ai/*` 的裸导入
 * 要能被解析，package.json 必须声明 peerDependencies（与 dsh-plugin-shop 同款）。
 *
 * 卸载：删掉联接、去掉依赖行与 bundles 条目，重启 DSH。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = 'dsh-comfy-workbench'
const HOME = os.homedir()
const PROFILE_DIR = process.env.DSH_COMFY_PROFILE_DIR
  || path.join(HOME, '.dsh', 'profiles', 'desktop')
const LINK_PATH = path.join(PROFILE_DIR, 'node_modules', PACKAGE_NAME)
const MANIFEST = path.join(PROFILE_DIR, 'package.json')

if (!fs.existsSync(PROFILE_DIR)) {
  console.error('找不到 profile：' + PROFILE_DIR)
  process.exit(1)
}

// 1) 联接
let existing = null
try {
  existing = fs.lstatSync(LINK_PATH)
} catch {
  existing = null
}
if (existing !== null) {
  const real = fs.realpathSync(LINK_PATH)
  if (path.resolve(real) !== SOURCE_ROOT) {
    fs.rmSync(LINK_PATH, { recursive: true, force: true })
    console.log('清掉旧副本/旧链接：' + real)
  } else {
    console.log('联接已存在且指向本目录')
  }
}
if (!fs.existsSync(LINK_PATH)) {
  fs.mkdirSync(path.dirname(LINK_PATH), { recursive: true })
  fs.symlinkSync(SOURCE_ROOT, LINK_PATH, 'junction')
  console.log('已建联接：' + LINK_PATH + ' → ' + SOURCE_ROOT)
}

// 2) profile 清单
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
const spec = 'link:' + SOURCE_ROOT.replace(/\\/g, '/')
const problems = []
if (manifest.dependencies?.[PACKAGE_NAME] === undefined) {
  manifest.dependencies = { ...(manifest.dependencies ?? {}), [PACKAGE_NAME]: spec }
  problems.push('补上 dependencies["' + PACKAGE_NAME + '"] = ' + spec)
}
const bundles = manifest.dsh?.profile?.bundles
if (!Array.isArray(bundles)) {
  problems.push('profile 没有 dsh.profile.bundles')
} else if (!bundles.includes(PACKAGE_NAME)) {
  bundles.push(PACKAGE_NAME)
  problems.push('补上 dsh.profile.bundles 里的 ' + PACKAGE_NAME)
}
if (problems.length > 0) {
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  for (const line of problems) console.log(line)
} else {
  console.log('profile 清单已登记（依赖 + bundle）')
}

console.log('')
console.log('下一步：重启 DSH。新 bundle 不作用于正在跑的进程。')
