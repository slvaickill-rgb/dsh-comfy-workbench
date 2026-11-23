/**
 * tools/selftest-upscale.mjs —— 不走页面，直接验「放大超分」通道。
 *
 * 用法：
 *   node tools/selftest-upscale.mjs                              # 拿图库里最新一张成品，放大 2x
 *   node tools/selftest-upscale.mjs --scale 4
 *   node tools/selftest-upscale.mjs --source catalog --rel app/outputs/user_items/<hash>/original.webp
 *   node tools/selftest-upscale.mjs --model 4xUltrasharp_v10.pt
 *
 * 前提：ComfyUI 在 8188 上、upscale_models 里有 RealESRGAN / 4xUltrasharp 之一。
 */
import { createApi } from '../lib/api.js'

const args = process.argv.slice(2)
const opt = (name, fallback = '') => {
  const index = args.indexOf('--' + name)
  if (index < 0) return fallback
  const value = args[index + 1]
  return value && !value.startsWith('--') ? value : fallback
}
const source = opt('source', 'output') === 'catalog' ? 'catalog' : 'output'
const scale = Number(opt('scale', '2'))
const model = opt('model', '') || undefined
const api = createApi({})

const listed = await api.dirs({ refresh: true })
console.log('service=' + listed.service + '  超分模型=' + JSON.stringify(listed.files?.upscale_models ?? []))
if (listed.service !== 'up') {
  console.error('ComfyUI 没在跑：先 node 一键拉起，或点面板上的「一键拉起」')
  process.exit(1)
}

let rel = opt('rel', '')
if (rel.length === 0) {
  const view = source === 'catalog' ? await api.catalog({ limit: 1 }) : await api.gallery({ limit: 1 })
  const first = view.images?.[0]
  if (!first) {
    console.error('图库里没有图：先出一张，或用 --rel 指一张')
    process.exit(1)
  }
  rel = first.rel
}

const job = await api.upscale({ items: [{ source, rel }], model, scale })
console.log('提交：' + JSON.stringify(job))
let view = null
for (let tick = 0; tick < 120; tick += 1) {
  view = await api.job({ promptId: job.promptId })
  if (['done', 'failed', 'timeout', 'missing'].includes(view.state)) break
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
console.log('状态=' + view?.state)
console.log('产物=' + JSON.stringify(view?.images ?? []))
console.log('落盘=' + JSON.stringify(view?.filePath))
if (Array.isArray(view?.messages) && view.messages.length > 0) console.log('消息=' + view.messages.join('；'))
process.exit(view?.state === 'done' ? 0 : 1)
