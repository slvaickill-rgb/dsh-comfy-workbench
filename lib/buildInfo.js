/**
 * lib/buildInfo.js — 插件版本与源码版本（给 /v1/health 用）。
 *
 * 版本读 package.json；commit 直接读 .git（不 spawn git，宿主里不一定有 PATH）。
 * 只在进程内缓存一次：插件是 junction 安装，改源码必须重启宿主才生效，
 * 所以「跑着的进程」的版本号本来就不会变。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function readPackageVersion() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    return typeof raw.version === 'string' ? raw.version : null
  } catch {
    return null
  }
}

/** 读 .git/HEAD：支持普通分支、detached HEAD、packed-refs。读不到就 null。 */
function readCommit() {
  const gitDir = path.join(ROOT, '.git')
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim()
      try {
        const sha = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim()
        return /^[0-9a-f]{40}$/.test(sha) ? sha : null
      } catch {
        try {
          const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8')
          const hit = packed.split('\n').find((line) => line.endsWith(' ' + ref))
          return hit && /^[0-9a-f]{40}/.test(hit) ? hit.slice(0, 40) : null
        } catch {
          return null
        }
      }
    }
    return /^[0-9a-f]{40}$/.test(head) ? head : null
  } catch {
    return null
  }
}

let cache = null

/**
 * @returns `{ version, commit, commitShort, root }`；读不到的字段为 null。
 */
export function readBuildInfo() {
  if (cache !== null) return cache
  const commit = readCommit()
  cache = {
    version: readPackageVersion(),
    commit,
    commitShort: commit === null ? null : commit.slice(0, 7),
    root: ROOT,
  }
  return cache
}

export default { readBuildInfo }
