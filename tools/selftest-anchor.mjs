/**
 * tools/selftest-anchor.mjs — 「角色外貌锚定」的桩测：不联网、不需要 ComfyUI。
 *
 * 跑：node tools/selftest-anchor.mjs
 * 覆盖：档案解析、外貌串提取、名字命中（中日英）、画风句后插入、已锚定跳过、单字名不误伤。
 */

import fs from 'node:fs'
import path from 'node:path'

import { anchorPrompt, kbRoot, loadKb, matchCharacters, parseCharacterFile, splitStyleLead } from '../lib/characters.js'

const FENCE = String.fromCharCode(96, 96, 96)
const NL = String.fromCharCode(10)
let checks = 0
let failures = 0

function ok(name) {
  checks += 1
  console.log('ok   ' + name)
}

function bad(name, error) {
  failures += 1
  console.log('FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error)))
}

function check(name, fn) {
  try { fn(); ok(name) } catch (error) { bad(name, error) }
}

function assert(cond, message) { if (!cond) throw new Error(message || '断言失败') }

function assertIncludes(text, part, message) {
  assert(String(text).includes(part), (message || '没找到片段') + '：' + part)
}

function sampleFile() {
  return [
    '---',
    'id: THE IDOLM@STER SHINY COLORS - Higuchi Madoka',
    'work_en: THE IDOLM@STER SHINY COLORS',
    'name_en: Higuchi Madoka',
    'name_zh: 樋口圆香',
    'name_jp: 樋口円香',
    'kana: ひぐちまどか',
    '---',
    '',
    '# 樋口圆香',
    '',
    '## 角色生成串（直接进 MOSS 提示词）',
    '',
    FENCE,
    'THE IDOLM@STER SHINY COLORS - Higuchi Madoka - short light-brown bob, purple eyes, pale skin, expressionless',
    FENCE,
    '',
    '## 使用记录',
  ].join(NL)
}

const ANCHOR = 'THE IDOLM@STER SHINY COLORS - Higuchi Madoka - short light-brown bob, purple eyes, pale skin, expressionless'

// ---------------------------------------------------------------- 解析

check('解析 front matter 与角色生成串', () => {
  const entry = parseCharacterFile(sampleFile(), '樋口圆香.md')
  assert(entry !== null, '应当解析成功')
  assert(entry.nameZh === '樋口圆香', '中文名不对')
  assert(entry.nameJp === '樋口円香', '日文名不对')
  assert(entry.nameEn === 'Higuchi Madoka', '英文名不对')
  assert(entry.anchor === ANCHOR, '外貌串不对：' + entry.anchor)
})

check('没有角色生成串的档案也能解析（anchor 为空）', () => {
  const entry = parseCharacterFile('---' + NL + 'name_zh: 测试' + NL + '---' + NL + '# x', 'x.md')
  assert(entry !== null && entry.anchor === '', '应当解析出空 anchor')
})

check('非档案文件返回 null', () => {
  assert(parseCharacterFile('# 随便写写', 'a.md') === null, '不该解析成功')
})

// ---------------------------------------------------------------- 匹配

const entries = [parseCharacterFile(sampleFile(), '樋口圆香.md')]

check('日文名命中（樋口円香）', () => {
  const hits = matchCharacters('樋口円香，成熟少妇风针织毛衣', entries)
  assert(hits.length === 1, '应当命中一条')
  assert(hits[0].entry.nameZh === '樋口圆香', '命中的角色不对')
})

check('中文名命中（樋口圆香）', () => {
  assert(matchCharacters('樋口圆香在沙发上', entries).length === 1, '应当命中')
})

check('英文罗马音命中（Higuchi Madoka）', () => {
  assert(matchCharacters('1girl, Higuchi Madoka, sitting', entries).length === 1, '应当命中')
})

check('无关提示词不命中', () => {
  assert(matchCharacters('雨夜面馆，招牌写着营业中', entries).length === 0, '不该命中')
})

// ---------------------------------------------------------------- 注入

check('画风句之后插入外貌串', () => {
  const result = anchorPrompt('厚涂风格。樋口円香，坐在沙发上', { entries })
  assert(result.inserted.length === 1, '应当插入一条')
  assert(result.text.startsWith('厚涂风格。'), '画风句必须保持在最前：' + result.text)
  assertIncludes(result.text, ANCHOR, '没插进外貌串')
  assert(result.text.endsWith('，坐在沙发上'), '原描述要留在最后：' + result.text)
})

check('没有画风句时插到最前面', () => {
  const result = anchorPrompt('樋口円香坐在沙发上', { entries })
  assert(result.text.startsWith(ANCHOR), '应当开头就是外貌串：' + result.text)
  assert(result.text.endsWith('，樋口円香坐在沙发上'), '原文不能丢：' + result.text)
})

check('提示词里已经有外貌串时跳过', () => {
  const result = anchorPrompt('厚涂风格。' + ANCHOR + '，坐在沙发上', { entries })
  assert(result.inserted.length === 0, '不该重复插入')
  assert(result.text === '厚涂风格。' + ANCHOR + '，坐在沙发上', '原文不该被改')
})

check('提示词里有英文罗马音时按已锚定跳过', () => {
  const result = anchorPrompt('Higuchi Madoka, sitting on sofa', { entries })
  assert(result.inserted.length === 0, '不该重复插入')
})

check('空提示词原样返回', () => {
  const result = anchorPrompt('', { entries })
  assert(result.text === '' && result.inserted.length === 0, '空串应该原样返回')
})

check('单字角色名不自动锚定', () => {
  const single = parseCharacterFile([
    '---', 'name_zh: 光', '---',
    '## 角色生成串', '', FENCE, 'Some Work - Hikari - short hair', FENCE,
  ].join(NL), '光.md')
  const result = anchorPrompt('窗边的光很暖', { entries: [single] })
  assert(result.inserted.length === 0, '单字名不该命中')
})

check('画风句判别只认带画风词的首句', () => {
  assert(splitStyleLead('厚涂风格。后面').style === '厚涂风格。', '带画风词应当切开')
  assert(splitStyleLead('樋口円香，坐在沙发上。').style === '', '不带画风词不该切开')
})

check('画风句自带句号时不补多余逗号', () => {
  const result = anchorPrompt('厚涂风格。樋口円香，坐着', { entries })
  assert(!result.text.includes('。，'), '不该出现「。，」：' + result.text)
  assert(result.text.startsWith('厚涂风格。THE IDOLM@STER'), '外貌串应紧跟在句号后：' + result.text)
})

// ---------------------------------------------------------------- 真库

check('真知识库能读到角色（存在时）', () => {
  const root = kbRoot(null)
  let exists = true
  try { fs.statSync(root) } catch { exists = false }
  if (!exists) { console.log('     （跳过：' + root + ' 不存在）'); return }
  const kb = loadKb(null)
  assert(kb.length > 0, '知识库应当至少有一条带外貌串的档案')
  const names = kb.map((entry) => entry.nameZh)
  assert(!names.includes('README'), 'README 不该被当成角色')
})

// ---------------------------------------------------------------- 汇总

if (failures === 0) console.log('全部 ' + checks + ' 项通过')
else console.log('失败 ' + failures + ' 项 / 共 ' + checks + ' 项')
process.exitCode = failures === 0 ? 0 : 1
