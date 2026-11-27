/**
 * tools/selftest-index.mjs — 校验 plugin-index.json 符合 DSH 插件市场索引 format 1。
 *
 *   node tools/selftest-index.mjs
 *
 * 规则照 @deepseek-ai/dsh-plugin-market-index 的 parseMarketIndex 抄的关键几条：
 * format=1 / title 必须含 en / name 是合法包名 / versions 非空且严格降序 /
 * version 是精确 SemVer / publishTimestamp 是整数 Unix 秒 / git commit 是 40 位小写 hex /
 * git url 是规范 https 且至少两段路径 / engines.dsh 是 SemVer 范围 /
 * 最新版本必须等于 package.json 的 version。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin-index.json'), 'utf8'))
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

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

const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const COMMIT = /^[0-9a-f]{40}$/
const PACKAGE_NAME = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
const plugin = INDEX.plugins[0]

check('format = 1 且 title 含 en', () => {
  assert(INDEX.format === 1, 'format 必须是 1，实际 ' + JSON.stringify(INDEX.format))
  assert(INDEX.title && typeof INDEX.title.en === 'string' && INDEX.title.en.length > 0, 'title 必须含非空 en')
  assert(INDEX.title.zh, 'title 应该有 zh，中文界面才有中文名')
})

check('plugins 是非空数组，name 是合法包名且与 package.json 一致', () => {
  assert(Array.isArray(INDEX.plugins) && INDEX.plugins.length > 0, 'plugins 不能为空')
  assert(PACKAGE_NAME.test(plugin.name), '不是合法 npm 包名：' + plugin.name)
  assert(plugin.name === PKG.name, '索引里的 name（' + plugin.name + '）和 package.json（' + PKG.name + '）不一致')
})

check('每个版本：SemVer / 时间戳 / git source / engines', () => {
  assert(Array.isArray(plugin.versions) && plugin.versions.length > 0, 'versions 不能为空')
  for (const row of plugin.versions) {
    assert(SEMVER.test(row.version), '不是精确 SemVer：' + JSON.stringify(row.version))
    assert(Number.isInteger(row.publishTimestamp) && row.publishTimestamp >= 0 && row.publishTimestamp < 1e11, 'publishTimestamp 必须是整数 Unix 秒：' + row.version)
    assert(row.source && row.source.type === 'git', '这一版只支持 git source：' + row.version)
    assert(COMMIT.test(row.source.commit), 'commit 必须是 40 位小写 hex：' + row.version + ' → ' + JSON.stringify(row.source.commit))
    assert(/^https:\/\/[^?#]+$/.test(row.source.url), 'git url 必须是规范 https（不带查询/片段）：' + row.source.url)
    assert(row.source.url.split('/').length >= 5, 'git url 至少要两段路径：' + row.source.url)
    assert(row.engines && typeof row.engines.dsh === 'string' && row.engines.dsh.length > 0, '缺 engines.dsh：' + row.version)
    assert(row.engines.dsh === PKG.engines.dsh, 'engines.dsh 要和 package.json 一致')
  }
})

check('versions 严格降序、无重复', () => {
  const seen = new Set()
  for (let i = 0; i < plugin.versions.length; i += 1) {
    const v = plugin.versions[i].version
    assert(!seen.has(v), '版本重复：' + v)
    seen.add(v)
    if (i > 0) {
      const prev = plugin.versions[i - 1].version
      const [pa, pb] = [prev, v].map((x) => x.split('-')[0].split('.').map(Number))
      const newer = pa[0] !== pb[0] ? pa[0] > pb[0] : pa[1] !== pb[1] ? pa[1] > pb[1] : pa[2] > pb[2]
      const sameCore = pa[0] === pb[0] && pa[1] === pb[1] && pa[2] === pb[2]
      assert(newer || (sameCore && prev.includes('-') && !v.includes('-')), '顺序不是降序：' + prev + ' 在 ' + v + ' 之前')
    }
  }
})

check('最新版本 = package.json 的 version（忘了跑 make-index 会在这里炸）', () => {
  assert(plugin.versions[0].version === PKG.version, '索引最新是 ' + plugin.versions[0].version + '，而 package.json 是 ' + PKG.version + '——跑一次 node tools/make-index.mjs')
})

check('展示字段齐全（title/description/author/homepage/repository/keywords）', () => {
  assert(plugin.title && plugin.title.en, '缺 title.en')
  assert(plugin.description && plugin.description.zh, '缺 description.zh')
  assert(typeof plugin.author === 'string' && plugin.author.length > 0, '缺 author')
  assert(/^https?:\/\//.test(plugin.homepage), 'homepage 不是绝对 URL')
  assert(plugin.repository && /^https:\/\//.test(plugin.repository.url), 'repository.url 必须是 https')
  assert(Array.isArray(plugin.metadata.keywords) && plugin.metadata.keywords.length > 0, '缺 keywords')
  assert(typeof plugin.icon === 'string' && plugin.icon.length > 0, '缺 icon')
})

console.log('')
if (failures > 0) {
  console.log('有 ' + failures + ' 项没通过')
  process.exitCode = 1
} else {
  console.log('全部 ' + checks + ' 项通过')
}