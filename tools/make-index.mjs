/**
 * tools/make-index.mjs — 生成/更新插件市场索引（format 1）。
 *
 *   node tools/make-index.mjs                 # 用当前 HEAD 当发布提交
 *   node tools/make-index.mjs --commit <sha>  # 指定提交
 *
 * 为什么要它：主机判更新有两条路——npm 的 `pnpm view`（我们是本地/私有包，用不上），
 * 和插件市场的索引源（format 1 JSON，版本里可以钉 git commit）。走后者。
 *
 * 发布流程：
 *   1. 改 package.json 的 version
 *   2. git commit（这一提交里就得是新版本代码）
 *   3. node tools/make-index.mjs   ← 把版本+这个提交钉进索引
 *   4. git commit plugin-index.json && git push
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_FILE = path.join(ROOT, 'plugin-index.json')
const REPO = 'https://github.com/slvaickill-rgb/dsh-comfy-workbench'
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

const argv = process.argv.slice(2)
const flag = argv.indexOf('--commit')
const commit = flag >= 0 ? String(argv[flag + 1] ?? '') : git(['rev-parse', 'HEAD'])
if (!/^[0-9a-f]{40}$/.test(commit)) {
  console.error('commit 必须是 40 位小写十六进制 SHA：' + commit)
  process.exit(1)
}

/** SemVer 降序比较（够用版：数值三段 + 有无预发布）。 */
function compareDesc(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split('-')
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0)
    return { nums, pre: pre === undefined ? null : pre }
  }
  const left = parse(a.version)
  const right = parse(b.version)
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) return right.nums[i] - left.nums[i]
  }
  // 有预发布标记的排在正式版之后
  if (left.pre === null && right.pre !== null) return -1
  if (left.pre !== null && right.pre === null) return 1
  if (left.pre === right.pre) return 0
  return String(right.pre) > String(left.pre) ? 1 : -1
}

const previous = fs.existsSync(INDEX_FILE)
  ? JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'))?.plugins?.[0]?.versions ?? []
  : []
const versions = previous.filter((row) => row.version !== pkg.version)
versions.push({
  version: pkg.version,
  publishTimestamp: Math.floor(Date.now() / 1000),
  source: { type: 'git', url: REPO, commit },
  engines: { dsh: pkg.engines?.dsh ?? '>=0.2.2-rc.1 <0.2.3-0' },
})
versions.sort(compareDesc)

const index = {
  format: 1,
  title: { en: 'ComfyUI Workbench', zh: 'ComfyUI 工作台' },
  description: {
    en: 'Local ComfyUI image-generation workbench for DeepSeek Harness: workflow picker, LoRA multi-select, prompt rewriting, gallery and model hub.',
    zh: '给 DSH 的本地 ComfyUI 出图工作台：工作流选择、LoRA 多选、大模型改写、图库与模型库。',
  },
  metadata: { categories: {}, labels: {}, sortKeys: {} },
  plugins: [{
    name: pkg.name,
    title: { en: 'ComfyUI Workbench', zh: 'ComfyUI 工作台' },
    description: {
      en: 'Local ComfyUI image-generation workbench for DeepSeek Harness.',
      zh: '给 DSH 的本地 ComfyUI 出图工作台。',
    },
    icon: './assets/icon.svg',
    author: 'slvaickill-rgb',
    homepage: REPO,
    repository: { url: REPO },
    metadata: {
      keywords: ['comfyui', 'image', 'workbench', 'llm', 'stable-diffusion'],
      labels: [],
      sortKeys: {},
    },
    versions,
  }],
}

fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2) + String.fromCharCode(10), 'utf8')
console.log('索引已写入：' + INDEX_FILE)
console.log('  ' + pkg.name + '  ' + pkg.version + '  @ ' + commit.slice(0, 7) + '  （共 ' + versions.length + ' 个版本）')
for (const row of versions) console.log('    - ' + row.version + '  ' + row.source.commit.slice(0, 7) + '  ' + new Date(row.publishTimestamp * 1000).toISOString())