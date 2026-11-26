/**
 * lib/api.js — 插件业务层。宿主服务方法与同源 HTTP 端点都走这里，只有一份实现。
 *
 * 每个方法返回纯 JSON（可跨 Typert 序列化）：不带 Date、不带 Buffer、不带循环引用。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { MODEL_CATEGORIES, MODEL_EXTENSIONS, collectDirs, defaultLaunchScripts, probeService, realPath } from './dirs.js'
import {
  DEFAULT_UPSCALE_MODEL,
  buildUpscaleGraph,
  cancelJob,
  defaultWorkflowFile,
  history,
  loadWorkflow,
  normalizeOutputFolder,
  patchWorkflow,
  pollJob,
  queuePosition,
  readHistoryEntry,
  submitPrompt,
} from './comfy.js'
import { complete as llmComplete, listModels, rewritePrompt } from './llm.js'
import {
  disposeRewrites,
  rewriteApply as applyRewrite,
  rewriteCancel as cancelRewrite,
  rewritePlan as planRewrite,
} from './rewrite.js'
import { readState, stateDir, writeState } from './state.js'
import { readBuildInfo } from './buildInfo.js'
import { ensureWorkspace, listWorkspaces, resolveWorkspacePath, writeNote } from './workspace.js'
import { IMAGE_EXTENSIONS, PAGE_DEFAULT, buildListing, readImageTreeFast, resolveImage } from './gallery.js'
import { PreviewHub, normalizePreviewMethod } from './preview.js'
import { RELEASE, catalogAppEntry, catalogInfo, inspectBindTarget, resolveCatalogRoot } from './catalog.js'
import { loadIndex } from './catalogIndex.js'
import { listWorkflows, resolveWorkflow, workflowMeta } from './workflows.js'
import { DEFAULT_MAX_BYTES, CredentialStore, HubDownloader } from './hub.js'
import { API_ORIGIN, fetchCover, fetchJson, normalizeModel, parseRef } from './civitai.js'
import { detectProxy } from './proxy.js'
import { mergeTriggers, readTriggers } from './triggers.js'
import { SYSTEM_PROMPT_CHAT, SYSTEM_PROMPT_HUB, SYSTEM_PROMPT_TRANSLATE, SYSTEM_PROMPT_TRANSLATE_LORA, adviceReport, buildFacts, fallbackAdvice, factsPrompt, parseAdvice, parseChat, parseTranslations } from './hubAgent.js'
import { anchorPrompt } from './characters.js'
import {
  annotate as annotateNsfw,
  countVerdicts as countNsfw,
  discover as discoverNsfw,
  readIndex as readNsfwIndex,
  stopTagger as stopNsfwTagger,
  tagFile as tagNsfwFile,
  verdictOf as nsfwVerdictOf,
  writeIndex as writeNsfwIndex,
} from './nsfw.js'

const DIRS_TTL_MS = 15_000
/** 原始清单缓存：产物目录变得勤（15 秒），画风库基本不动（10 分钟）。 */
/** 产物目录缓存 5 分钟（过期后走后台补扫，不再卡页面）；画风库 10 分钟。 */
// 画风库解压后基本不变，10 分钟一刷等于每 10 分钟重扫 34,709 个目录、重写 6.9 MB 索引。
const RAW_TTL_MS = { output: 300_000, catalog: 1_800_000 }
const RAW_CACHE_MAX = 8
/** 任务结束后预览帧保留多久（够回看，不常驻内存）。 */
const PREVIEW_KEEP_MS = 60_000
const PREVIEW_LIMIT_MAX = 200

/**
 * 自动分桶：源/年-月。
 *
 * 源取自工作流文件名前缀（`moss__moss-4step.api.json` → `moss`），年-月取本机当前时间；
 * 用户在「生图归入」里手填了名字就不用它。和 AGENTS.md 里定下的
 * `C:\DSH生图\<源>\<YYYY-MM>\` 结构保持一致。
 */
export function autoOutputFolder(workflowFile, now = new Date()) {
  const base = path.basename(String(workflowFile ?? ''))
  const prefix = base.includes('__') ? base.slice(0, base.indexOf('__')) : ''
  const bucket = /^[a-z0-9][a-z0-9-]*$/i.test(prefix) ? prefix.toLowerCase() : 'misc'
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return bucket + '/' + now.getFullYear() + '-' + month
}

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * @param ctx - 宿主 Context（cordis）。
 * @returns 业务方法集合，全部 async。
 */
export function createApi(ctx) {
  /** 目录快照缓存：15 秒内复用，页面点「刷新」强制重跑。 */
  let dirsCache = null
/** light 探测（只要路径）单独缓存：不能拿它顶替带模型清单的那份。 */
let dirsLightCache = null

  /**
   * 原始清单缓存：按根缓存一次扫描结果，换分类/搜索只在内存里重排。
   * 34,709 张冷扫约 13 秒，按筛选条件分键会导致每点一次分类重扫一遍。
   */
  const rawCache = new Map()

  /** 逐步预览：同一时间只有一个会话，任务结束后保留 60 秒供回看。 */
  const previewHub = new PreviewHub()

  /**
   * 凭据仓：工厂里读一次文件，之后所有请求只读内存副本。
   * 写盘、断继承、清除都在 `CredentialStore` 里，这里只负责持有。
   */
  const hubCredentials = new CredentialStore()
  hubCredentials.load()
  /** 搜索短缓存（30 秒）：翻版本、换筛选不该每点一次都打上游。 */
  const hubSearchCache = new Map()
  let previewCloseTimer = null

  const schedulePreviewClose = () => {
    if (previewCloseTimer !== null) clearTimeout(previewCloseTimer)
    previewCloseTimer = setTimeout(() => {
      previewHub.close()
      previewCloseTimer = null
    }, PREVIEW_KEEP_MS)
    previewCloseTimer.unref?.()
  }

  const cancelPreviewClose = () => {
    if (previewCloseTimer === null) return
    clearTimeout(previewCloseTimer)
    previewCloseTimer = null
  }

  const stateOf = () => readState()

  /**
   * 探测目录。`light: true` 只要路径、不要模型清单（跳过 /object_info 与模型扫盘），
   * 图库、NSFW 判定这些只关心输出根的调用走这条，快点开也轻点。
   */
  const dirs = async ({ refresh = false, light = false } = {}) => {
    const now = Date.now()
    const cached = light ? dirsLightCache : dirsCache
    if (!refresh && cached !== null && now - cached.at < DIRS_TTL_MS) return cached.value
    const state = stateOf()
    const value = await collectDirs({
      overrides: {
        comfyUrl: state.comfyUrl ?? undefined,
        comfyRoot: state.comfyRoot ?? undefined,
        input: state.input ?? undefined,
        output: state.output ?? undefined,
        launchScript: state.launchScript ?? undefined,
      },
      refresh,
      light,
    })
    if (light) {
      dirsLightCache = { at: now, value }
    } else {
      dirsCache = { at: now, value }
      dirsLightCache = null
    }
    return value
  }

  /**
   * 磁盘索引：宿主重启后第一次打开图库也不用重扫整棵树。
   *
   * 画风库 34,709 张、解压在 user_items/<hash>/ 下，同步扫要 7 秒、并发扫 1.9 秒；
   * 落一份 2.6 MB 的 JSON 后读盘约 200 ms。两边的键各用一份文件，互不覆盖。
   */
  const diskIndexFile = (source) => path.join(stateDir(), source === 'catalog' ? 'catalog-tree.json' : 'output-index.json')

  /** 读磁盘索引；根对不上、文件坏了都当没有。 */
  const readDiskIndex = (source, root) => {
    try {
      const data = JSON.parse(fs.readFileSync(diskIndexFile(source), 'utf8'))
      if (data === null || typeof data !== 'object' || data.root !== root) return null
      if (!Array.isArray(data.items)) return null
      return { at: Number(data.at) || 0, items: data.items, meta: data.meta ?? { truncated: false, unreadable: 0 } }
    } catch {
      return null
    }
  }

  const writeDiskIndex = (source, root, entry) => {
    try {
      const dir = stateDir()
      fs.mkdirSync(dir, { recursive: true })
      const target = diskIndexFile(source)
      const temp = target + '.tmp-' + String(process.pid)
      fs.writeFileSync(temp, JSON.stringify({ root, at: entry.at, items: entry.items, meta: entry.meta }), 'utf8')
      fs.renameSync(temp, target)
    } catch {
      // 写不进去只影响下次冷启动快不快，读数照旧
    }
  }

  const putRaw = (key, entry) => {
    if (rawCache.size >= RAW_CACHE_MAX) rawCache.clear()
    rawCache.set(key, entry)
  }

  /** 后台补扫：同一个 key 同时只跑一份；扫完直接换掉缓存，页面下次拿到的就是新的。 */
  const refreshing = new Map()
  const scheduleRefresh = (source, root, key, includeHidden) => {
    if (refreshing.has(key)) return
    const job = (async () => {
      try {
        const scanned = await readImageTreeFast(root, { includeHidden, source })
        const entry = { at: Date.now(), items: scanned.items, meta: scanned.meta }
        putRaw(key, entry)
        writeDiskIndex(source, root, entry)
      } catch {
        // 目录暂时读不到（正在搬文件之类）就下次再说，旧数据不清
      } finally {
        refreshing.delete(key)
      }
    })()
    refreshing.set(key, job)
  }

  /**
   * 拿一个根的原始条目（不做筛选与分页）。
   *
   * 三条路：内存里那份还新鲜 → 直接给；过期了、或进程刚起来只读到磁盘索引 → 先给旧数据、
   * 后台再扫；真的一份都没有 → 当场扫一次。打开图库不再每次都把整棵树 stat 一遍。
   * @param source - `'output'` 或 `'catalog'`，决定缓存时长与错误码。
   * @returns `{ at, items, meta, stale, refreshing }`
   */
  const rawOf = async (source, root, opts = {}) => {
    const includeHidden = opts.includeHidden === true
    const key = root + (includeHidden ? '\u0001hidden' : '')
    const ttl = RAW_TTL_MS[source] ?? RAW_TTL_MS.output
    const now = Date.now()
    const hit = rawCache.get(key)
    const force = opts.refresh === true

    if (!force) {
      if (hit !== undefined) {
        const fresh = now - hit.at < ttl
        if (!fresh) scheduleRefresh(source, root, key, includeHidden)
        return { ...hit, stale: !fresh, refreshing: refreshing.has(key) }
      }
      const cached = readDiskIndex(source, root)
      if (cached !== null) {
        putRaw(key, cached)
        scheduleRefresh(source, root, key, includeHidden)
        return { ...cached, stale: true, refreshing: true }
      }
    }

    let scanned
    try {
      scanned = await readImageTreeFast(root, { includeHidden, source })
    } catch (error) {
      if (error?.code === 'gallery-root-missing' && source === 'catalog') error.code = 'catalog-root-missing'
      throw error
    }
    const entry = { at: Date.now(), items: scanned.items, meta: scanned.meta }
    putRaw(key, entry)
    writeDiskIndex(source, root, entry)
    return { ...entry, stale: false, refreshing: false }
  }

  /**
   * 拿原始条目，再按筛选条件分页。
   * @param source - `'output'` 或 `'catalog'`，决定缓存时长、图片 URL 与错误码。
   */
  const scanCached = async (source, root, opts) => {
    const entry = await rawOf(source, root, opts)
    const listing = buildListing(root, entry.items, entry.meta, {
      folder: opts.folder,
      query: opts.query,
      limit: opts.limit,
      cursor: opts.cursor,
      source,
    })
    return { ...listing, scannedAt: entry.at, stale: entry.stale === true, refreshing: entry.refreshing === true }
  }

  /** 我的图库：只读扫产物根（realpath，穿过 `C:\Comfyui output` 符号链接），顺手挂上 NSFW 判定。 */
  const gallery = async ({ folder = '', query = '', limit, cursor, refresh = false, includeHidden = false, nsfw = '' } = {}) => {
    const listed = await dirs({ refresh: false, light: true })
    const root = listed.outputReal
    const entry = await rawOf('output', root, { refresh: refresh === true, includeHidden })
    // 缓存里有的才算数：nsfw 为 null = 还没扫过，前端据此决定盖不盖毛玻璃。
    const tagged = annotateNsfw(entry.items, readNsfwIndex())
    const filter = nsfw === 'nsfw' || nsfw === 'safe' ? nsfw : ''
    const pool = filter === ''
      ? tagged
      : tagged.filter((item) => (filter === 'nsfw' ? item.nsfw === true : item.nsfw === false))
    const listing = buildListing(root, pool, entry.meta, { folder, query, limit, cursor, source: 'output' })
    return {
      ...listing,
      // scannedAt 用真实扫描时间，别用「这会儿」——不然页面上的「扫描于」永远显示刚刚
      scannedAt: entry.at,
      stale: entry.stale === true,
      refreshing: entry.refreshing === true,
      nsfwFilter: filter,
      nsfwCounts: countNsfw(tagged),
      nsfwEngine: discoverNsfw(listed.comfyRoot),
    }
  }

  /** NSFW 识别：打标器找不找得到、已经标了多少。 */
  const nsfwStatus = async () => {
    const listed = await dirs({ refresh: false, light: true })
    const entry = await rawOf('output', listed.outputReal, { refresh: false })
    const tagged = annotateNsfw(entry.items, readNsfwIndex())
    const engine = discoverNsfw(listed.comfyRoot)
    return {
      ready: engine.ready,
      reason: engine.reason,
      engine: { name: engine.name, model: engine.model, python: engine.python, threshold: engine.threshold },
      scope: listed.outputReal,
      counts: countNsfw(tagged),
    }
  }

  /**
   * NSFW 识别：一次最多 limit 张，新的先扫。每张判完就落盘，中途关页面不丢进度；
   * 打标器挂了就把原因原样带回去，不静默跳过。
   */
  const nsfwScan = async ({ limit = 6 } = {}) => {
    const listed = await dirs({ refresh: false, light: true })
    const root = listed.outputReal
    const entry = await rawOf('output', root, { refresh: false })
    const engine = discoverNsfw(listed.comfyRoot)
    const before = annotateNsfw(entry.items, readNsfwIndex())
    if (engine.ready !== true) {
      return { ok: false, reason: engine.reason ?? '打标器不可用', engine, scanned: 0, found: 0, batch: 0, counts: countNsfw(before) }
    }
    const batch = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 6, 1), 24)
    const todo = before
      .filter((item) => item.nsfw === null)
      .sort((left, right) => right.mtime - left.mtime)
      .slice(0, batch)
    const index = readNsfwIndex()
    const failures = []
    let scanned = 0
    let found = 0
    for (const item of todo) {
      try {
        const rating = await tagNsfwFile(engine, path.join(root, item.rel))
        const verdict = nsfwVerdictOf(rating)
        index.items[item.rel] = {
          s: item.size,
          m: item.mtime,
          n: verdict.nsfw,
          // 置信度存「两个危险档里高的那个」，不然 questionable 判出来的图会显示成 6%
          x: Math.round(verdict.score * 1000) / 1000,
          e: Math.round(verdict.explicit * 1000) / 1000,
          q: Math.round(verdict.questionable * 1000) / 1000,
          at: Date.now(),
        }
        writeNsfwIndex(index)
        scanned += 1
        if (verdict.nsfw) found += 1
      } catch (error) {
        failures.push(item.rel + '：' + (error instanceof Error ? error.message : String(error)))
        break
      }
    }
    const after = annotateNsfw(entry.items, readNsfwIndex())
    return {
      ok: true,
      engine: { name: engine.name },
      scanned,
      found,
      batch: todo.length,
      failures: failures.slice(0, 3),
      counts: countNsfw(after),
    }
  }

  /** 画风图库：根按配置 → 自动探测；没包时返回 found:false 与 release 信息。清单在就补画风名/分类/提示词，并支持筛选。 */
  const catalog = async ({ folder = '', query = '', limit, cursor, refresh = false, includeHidden = false, kind = '', category = '' } = {}) => {
    const state = stateOf()
    const resolved = resolveCatalogRoot(state)
    const info = catalogInfo()
    const emptyShape = {
      found: false,
      root: resolved.root,
      source: 'catalog',
      sourceOfRoot: resolved.source,
      candidates: resolved.candidates,
      release: info.release,
      note: info.note,
      steps: info.steps,
      folders: [],
      images: [],
      total: 0,
      matched: 0,
      folder: '',
      query: '',
      cursor: 0,
      nextCursor: null,
      limit: PAGE_DEFAULT,
      truncated: false,
      scannedAt: Date.now(),
      kind: '',
      category: '',
      indexAvailable: false,
      indexNote: null,
      kindCounts: null,
      categories: [],
    }
    if (resolved.root === null) return emptyShape
    if (resolved.valid !== true) {
      return {
        ...emptyShape,
        note: '这个目录已绑定，但里面还没看到图库文件（index.html / images / data / *.webp）。把 ZIP 解压进来再刷新。',
        steps: [],
      }
    }
    const entry = await rawOf('catalog', resolved.root, { refresh: refresh === true, includeHidden })
    const index = loadIndex(resolved.root)
    const kindFilter = kind === 'style' || kind === 'character' ? kind : ''
    const categoryFilter = String(category ?? '').trim()
    const byRel = index.available === true ? index.items : null
    // 清单在就按画风筛选；清单缺失时退回只按文件名搜，不假装有分类。
    const pool = byRel === null || (kindFilter.length === 0 && categoryFilter.length === 0)
      ? entry.items
      : entry.items.filter((item) => {
        const meta = byRel[item.rel]
        if (meta === undefined) return false
        if (kindFilter.length > 0 && meta.k !== kindFilter) return false
        if (categoryFilter.length > 0 && meta.c !== categoryFilter) return false
        return true
      })
    const scanned = buildListing(resolved.root, pool, entry.meta, {
      folder,
      query,
      limit,
      cursor,
      source: 'catalog',
    })
    const images = byRel === null
      ? scanned.images
      : scanned.images.map((item) => {
        const meta = byRel[item.rel]
        if (meta === undefined) return item
        return {
          ...item,
          kind: meta.k,
          displayName: typeof meta.n === 'string' && meta.n.length > 0 ? meta.n : item.name,
          category: meta.c ?? null,
          tags: meta.t ?? '',
          prompt: meta.p ?? '',
        }
      })
    return {
      found: true,
      ...scanned,
      images,
      source: 'catalog',
      sourceOfRoot: resolved.source,
      release: { ...RELEASE },
      note: RELEASE.notice,
      app: catalogAppEntry(resolved.root),
      kind: kindFilter,
      category: categoryFilter,
      indexAvailable: index.available === true,
      indexNote: index.available === true ? null : (index.reason ?? null),
      kindCounts: index.available === true ? index.counts : null,
      categories: index.available === true ? index.categories : [],
    }
  }

  /** 绑定画风图库目录：不存在 404、非目录或不像图库 422、空目录允许。 */
  const catalogBind = async ({ path: target } = {}) => {
    const raw = String(target ?? '').trim()
    if (raw.length === 0) throw fail('path-required', '缺 path')
    const inspected = inspectBindTarget(raw)
    writeState({ catalogRoot: inspected.root })
    rawCache.clear()
    return {
      ok: true,
      root: inspected.root,
      valid: inspected.valid,
      empty: inspected.empty,
      descended: inspected.descended,
      markers: inspected.unique,
      app: catalogAppEntry(inspected.root),
      note: inspected.valid
        ? null
        : '目录已绑定，但还没看到图库文件；把 ZIP 解压进来后点「刷新」。',
    }
  }

  /**
   * 工作流清单：workflows/ 里导入的那些，附带「模型够不够」的判定。
   * 拿 dirs 的模型清单比，缺什么直接列出来，别等出图时才 400。
   */
  const workflows = async () => {
    const listed = await dirs({ refresh: false })
    const files = listed.files ?? {}
    const clipList = Array.isArray(files.clip) && files.clip.length > 0 ? files.clip : (Array.isArray(files.text_encoders) ? files.text_encoders : [])
    // UNETLoader 的候选来自 unet/ 与 diffusion_models/ 两处（新版 ComfyUI 把底模放后者）。
    const unetList = [...new Set([...(Array.isArray(files.unet) ? files.unet : []), ...(Array.isArray(files.diffusion_models) ? files.diffusion_models : [])])]
    const have = {
      unet: unetList,
      checkpoints: Array.isArray(files.checkpoints) ? files.checkpoints : [],
      vae: Array.isArray(files.vae) ? files.vae : [],
      clip: clipList,
      loras: Array.isArray(files.loras) ? files.loras : [],
    }
    const inventory = listWorkflows()
    const items = inventory.items.map((item) => {
      const summary = item.summary ?? {}
      const missing = []
      for (const kind of ['unet', 'checkpoints', 'vae', 'clip']) {
        for (const name of Array.isArray(summary[kind]) ? summary[kind] : []) {
          if (!have[kind].includes(name)) missing.push(kind + '：' + name)
        }
      }
      for (const lora of Array.isArray(summary.loras) ? summary.loras : []) {
        if (!have.loras.includes(lora.name)) missing.push('loras：' + lora.name)
      }
      return {
        id: item.id,
        title: item.title,
        skill: item.skill,
        format: item.format,
        summary,
        missing,
        ready: missing.length === 0,
      }
    })
    return {
      dir: inventory.dir,
      importedAt: inventory.importedAt,
      warnings: inventory.warnings,
      items,
      counts: { total: items.length, ready: items.filter((item) => item.ready).length },
      // have 给的是实际名单（页面按工作流的 loader 类型铺底模下拉），haveCounts 给计数。
      have,
      haveCounts: Object.fromEntries(Object.entries(have).map(([key, list]) => [key, list.length])),
      service: listed.service,
    }
  }

  /** 只给 HTTP 图片路由用：解析当前根，不扫描。 */
  const catalogRoot = async () => {
    const resolved = resolveCatalogRoot(stateOf())
    return {
      root: resolved.root,
      source: resolved.source,
      valid: resolved.valid,
      app: catalogAppEntry(resolved.root),
    }
  }

  const probe = async () => {
    const state = stateOf()
    const listed = await dirs({ refresh: false })
    const live = await probeService(listed.comfyUrl)
    const workspace = {
      bound: state.workspaceId || state.workspacePath
        ? {
          workspaceId: state.workspaceId,
          path: resolveWorkspacePath(ctx, state),
          alias: state.workspaceAlias,
        }
        : null,
    }
    return {
      service: live.ok ? 'up' : 'down',
      serviceError: live.ok ? null : live.error ?? ('HTTP ' + live.status),
      comfyUrl: listed.comfyUrl,
      stats: live.ok ? live.stats : null,
      modelBase: listed.modelBase,
      counts: listed.counts,
      output: listed.output,
      outputReal: listed.outputReal,
      input: listed.input,
      inputReal: listed.inputReal,
      dshVersion: process.env.DSH_VERSION ?? null,
      build: readBuildInfo(),
      node: process.versions.node,
      workspace,
      probedAt: Date.now(),
    }
  }

  const models = async () => {
    const listed = await listModels(ctx)
    const state = stateOf()
    return {
      ...listed,
      selected: state.provider && state.model ? { provider: state.provider, model: state.model } : listed.default,
    }
  }

  const complete = async (args) => llmComplete(ctx, args ?? {})

  const workspace = async () => {
    const state = stateOf()
    const rows = listWorkspaces(ctx)
    const boundPath = resolveWorkspacePath(ctx, state)
    const bound = boundPath
      ? {
        workspaceId: rows.find((row) => row.path === boundPath)?.workspaceId ?? state.workspaceId,
        path: boundPath,
        alias: state.workspaceAlias,
        exists: fs.existsSync(boundPath),
        noteDir: path.join(boundPath, '.dsh-comfy'),
      }
      : null
    return { workspaces: rows, bound }
  }

  const workspaceBind = async ({ path: target, title, workspaceId } = {}) => {
    if (workspaceId && !target) {
      const hit = listWorkspaces(ctx).find((row) => row.workspaceId === workspaceId)
      if (!hit) throw fail('workspace-not-found', '没有这条工作区记录：' + workspaceId)
      writeState({ workspaceId: hit.workspaceId, workspacePath: hit.path, workspaceAlias: hit.title })
      return { ok: true, bound: { ...hit, alias: hit.title } }
    }
    const ensured = await ensureWorkspace(ctx, { path: target, title })
    writeState({ workspaceId: ensured.workspaceId, workspacePath: ensured.path, workspaceAlias: ensured.title })
    return { ok: true, bound: { ...ensured, alias: ensured.title } }
  }

  /**
   * 三种提交：file 落盘、llm 改写、draft 由页面自己调 uiWorkspace（宿主碰不到）。
   */
  const submit = async ({ text, mode = 'file', provider, model } = {}) => {
    const state = stateOf()
    if (mode === 'llm') {
      const result = await rewritePrompt(ctx, { text, provider: provider ?? state.provider, model: model ?? state.model })
      writeState({ lastPrompt: result.text })
      return { mode, text: result.text, usage: result.usage ?? null, provider: result.provider, model: result.model }
    }
    if (mode === 'file') {
      const target = resolveWorkspacePath(ctx, state)
      if (!target) throw fail('workspace-unbound', '还没有绑定工作区：先点「更改」指一个目录')
      const written = writeNote(target, text)
      writeState({ lastPrompt: String(text ?? '') })
      return { mode, path: written.file, appended: written.appended, workspace: target }
    }
    throw fail('mode-unsupported', 'draft 模式由页面直接调 uiWorkspace.startSession，不走宿主')
  }

  /**
   * 阶段 A：判定要不要写反向提示词（不写就不动反向框）。
   * 超时取本次入参 → 配置 rewriteTimeoutMs → 30 秒。
   */

  /** 改写时告诉模型：当前选了哪些 LoRA、各自要哪些触发词（来自本地映射）。 */
  function loraHintsFor(state, args) {
    const list = Array.isArray(args?.loras) ? args.loras : (Array.isArray(state.loras) ? state.loras : [])
    const map = readTriggers()
    return list.slice(0, 8).map((item) => {
      const name = String(item?.name ?? '').slice(0, 200)
      return {
        name,
        strength: Number(item?.strength),
        words: map[name.toLowerCase()]?.words ?? [],
      }
    })
  }

  const rewritePlan = async (args = {}) => {
    const state = stateOf()
    const asked = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? Math.trunc(args.timeoutMs) : state.rewriteTimeoutMs
    return planRewrite(ctx, {
      ...args,
      loraHints: loraHintsFor(state, args),
      fallbackWorkflowId: state.workflow ?? null,
      timeoutMs: Number.isFinite(asked) && asked > 0 ? asked : 30000,
      autoQuality: args.autoQuality === true || state.rewriteAutoQuality === true,
      persona: state.rewritePersona !== false,
    })
  }

  /** 阶段 B：按工作流风格改写正向提示词，必须带着阶段 A 的 token。 */
  const rewriteApply = async (args = {}) => {
    const state = stateOf()
    const asked = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? Math.trunc(args.timeoutMs) : state.rewriteTimeoutMs
    return applyRewrite(ctx, {
      ...args,
      loraHints: loraHintsFor(state, args),
      fallbackWorkflowId: state.workflow ?? null,
      timeoutMs: Number.isFinite(asked) && asked > 0 ? asked : 30000,
      persona: state.rewritePersona !== false,
    })
  }

  /** 取消：页面点「取消」时按 token 中止当前阶段。 */
  const rewriteCancel = async ({ token } = {}) => cancelRewrite(ctx, { token })

  const generate = async (args = {}) => {
    const state = stateOf()
    // 打标器常驻一份 1.2 GB 的 onnx：出图前先放掉，别跟底模抢内存（本机只有 4 GB 显存）。
    stopNsfwTagger()
    const listed = await dirs({ refresh: false })
    if (listed.service !== 'up') throw fail('service-down', 'ComfyUI 未启动：先点「一键拉起」')
    const rawPrompt = String(args.prompt ?? '').trim()
    if (rawPrompt.length === 0) throw fail('empty-prompt', '提示词是空的')

    // 选择顺序：本次请求的 workflowId → 配置里记住的 → 工作台导入的 anima → 技能目录那份。
    const wanted = args.workflowId ?? args.workflow ?? state.workflow ?? null
    let workflowFile = null
    if (wanted !== null && String(wanted).length > 0) {
      workflowFile = resolveWorkflow(wanted)
      if (workflowFile === null) throw fail('workflow-missing', '找不到这个工作流：' + String(wanted))
    }
    workflowFile = workflowFile ?? resolveWorkflow('anima__Anima Aesthetic v1.1') ?? defaultWorkflowFile()
    if (!fs.existsSync(workflowFile)) throw fail('workflow-missing', '找不到工作流文件：' + workflowFile)
    const base = loadWorkflow(workflowFile)

    // 角色外貌锚定（comfyui-moss 的硬规矩）：MOSS 没有角色库，提示词里点名了知识库里
    // 有的角色也只是弱线索，只写名字会漂成通用脸——出图前把外貌串插在画风句之后。
    // 只对 moss 工作流生效：anima 那条有自己的角色 tag 库，别插两套。
    const meta = wanted === null || String(wanted).length === 0 ? null : workflowMeta(String(wanted))
    const wantAnchor = state.characterAnchor !== false && args.anchorCharacters !== false
    const anchored = wantAnchor && (meta?.skill ?? '') === 'comfyui-moss'
      ? anchorPrompt(rawPrompt, { kbRoot: state.characterKbRoot })
      : { text: rawPrompt, inserted: [], skipped: [], root: '' }
    const prompt = anchored.text
    const anchorNotes = anchored.inserted.length > 0
      ? ['角色锚定：' + anchored.inserted.map((item) => item.name).join('、') + '（' + anchored.root + '）']
      : []

    // 底模必须跟工作流的载入器同类：UNETLoader 只认 unet/diffusion_models，
    // CheckpointLoaderSimple 只认 checkpoints/。这里以前会退回 checkpoints/ 的第一个文件，
    // 于是整包 checkpoint（本机那份 sdpose_wholebody_fp16）被塞进 UNETLoader 的 unet_name，
    // ComfyUI 直接 400 value_not_in_list。现在：没选就交回工作流自己的默认值；
    // 选了但不在候选里，退回默认并明说一句，不再猜。
    const files = listed.files ?? {}
    const unetCandidates = [...new Set([
      ...(Array.isArray(files.unet) ? files.unet : []),
      ...(Array.isArray(files.diffusion_models) ? files.diffusion_models : []),
    ])]
    const checkpointCandidates = Array.isArray(files.checkpoints) ? files.checkpoints : []
    const loaderKinds = new Set()
    for (const node of Object.values(base)) {
      if (node?.class_type === 'UNETLoader' || node?.class_type === 'UnetLoaderGGUF') loaderKinds.add('unet')
      else if (node?.class_type === 'CheckpointLoaderSimple') loaderKinds.add('checkpoint')
    }
    const loaderKind = loaderKinds.size === 1 ? [...loaderKinds][0] : null
    const checkpointPool = loaderKind === 'unet'
      ? unetCandidates
      : loaderKind === 'checkpoint'
        ? checkpointCandidates
        : [...new Set([...unetCandidates, ...checkpointCandidates])]
    const requestedCheckpoint = String(args.checkpoint ?? state.checkpoint ?? '').trim()
    const checkpointNotes = []
    let checkpoint = null
    if (requestedCheckpoint.length > 0) {
      if (checkpointPool.includes(requestedCheckpoint)) {
        checkpoint = requestedCheckpoint
      } else {
        checkpointNotes.push(
          '底模 ' + requestedCheckpoint + ' 不在这次可用的 ' +
          (loaderKind === 'checkpoint' ? 'checkpoints' : 'unet/diffusion_models') +
          ' 列表里，已退回工作流自己的默认底模',
        )
      }
    }
    const loras = Array.isArray(args.loras) ? args.loras : (Array.isArray(state.loras) ? state.loras : [])
    const requestedFolder = String(typeof args.folder === 'string' ? args.folder : (state.galleryFolder ?? '')).trim()
    const explicitFolder = normalizeOutputFolder(requestedFolder) ?? ''
    // 没手填就自动分到 源/年-月（moss/2026-11），别让新图继续堆在输出根上。
    const folder = explicitFolder.length > 0 ? explicitFolder : autoOutputFolder(workflowFile)
    // 名字被拒时要说出来，不能静默落回根目录。
    const folderNotes = requestedFolder.length > 0 && explicitFolder.length === 0
      ? ['分类目录名不合法，已忽略：' + requestedFolder]
      : (requestedFolder.length === 0 ? ['自动归入 ' + folder + '（在「生图归入」里填名字可覆盖）'] : [])
    const patched = patchWorkflow(base, {
      prompt,
      negative: String(args.negative ?? ''),
      seed: Number.isFinite(args.seed) ? args.seed : Math.floor(Math.random() * 2 ** 32),
      steps: Number.isFinite(args.steps) ? args.steps : state.steps,
      cfg: args.cfg,
      width: Number.isFinite(args.width) ? args.width : state.width,
      height: Number.isFinite(args.height) ? args.height : state.height,
      checkpoint,
      checkpointPool,
      loras,
      outputFolder: folder.length > 0 ? folder : undefined,
    })
    // 逐步预览：连接必须在 /prompt 之前建好 —— ComfyUI 只把帧发给这个 client_id 的连接。
    const previewSetting = args.preview ?? state.previewEnabled
    const previewMethod = normalizePreviewMethod(
      typeof previewSetting === 'string'
        ? previewSetting
        : (previewSetting === false ? 'none' : state.previewMethod),
    )
    const clientId = 'dsh-comfy-' + randomUUID()
    previewHub.limit = Math.min(Math.max(Number(state.previewLimit) || 60, 1), PREVIEW_LIMIT_MAX)
    const attached = await previewHub.attach(listed.comfyUrl, clientId, previewMethod)
    const promptId = await submitPrompt(listed.comfyUrl, patched.graph, clientId, { preview_method: previewMethod })
    previewHub.begin(promptId, Number.isFinite(args.steps) ? args.steps : state.steps)
    cancelPreviewClose()
    writeState({
      lastPrompt: prompt,
      checkpoint,
      loras,
      workflow: wanted === null || String(wanted).length === 0 ? state.workflow : String(wanted),
      width: Number.isFinite(args.width) ? args.width : state.width,
      height: Number.isFinite(args.height) ? args.height : state.height,
      // 只记住手填的：自动桶每月会变，写死进配置下个月就不对了
      galleryFolder: explicitFolder,
      previewMethod: previewMethod === 'none' ? state.previewMethod : previewMethod,
    })
    return {
      promptId,
      workflow: path.basename(workflowFile),
      notes: [...folderNotes, ...checkpointNotes, ...anchorNotes, ...patched.notes],
      samplers: patched.samplers,
      output: listed.outputReal,
      folder,
      clientId,
      previewMethod,
      previewEnabled: previewMethod !== 'none',
      previewConnected: attached.connected,
      previewNote: attached.note,
    }
  }

  /**
   * 放大超分：把输入框 / 输出框里的图送进 ESRGAN，产物落到 `<输出根>/upscale/<年-月>/`。
   *
   * 只负责提交、不等结果：页面拿 promptId 走 `job()` 轮询，成品图回「放大输出框」，
   * 不覆盖输出框里那张原图。模型只用 upscale_models 里现有的（默认 RealESRGAN anime 4x，
   * 与 comfyui-moss 的 upscale.mjs 一致），不下载新权重。
   * @param args - `{ items: [{ source: 'output'|'catalog', rel }], model?, scale? }`
   */
  const upscale = async (args = {}) => {
    const state = stateOf()
    // 和出图一样：打标器先让位，别跟放大模型抢显存。
    stopNsfwTagger()
    const listed = await dirs({ refresh: false })
    if (listed.service !== 'up') throw fail('service-down', 'ComfyUI 未启动：先点「一键拉起」')
    const items = (Array.isArray(args.items) ? args.items : [])
      .slice(0, 4)
      .map((item) => ({
        source: item?.source === 'catalog' ? 'catalog' : 'output',
        rel: String(item?.rel ?? '').trim(),
      }))
      .filter((item) => item.rel.length > 0)
    if (items.length === 0) throw fail('image-required', '没有可放大的图：先出一张，或在画风图库里套一个画风')

    const needsCatalog = items.some((item) => item.source === 'catalog')
    const catalog = needsCatalog ? resolveCatalogRoot(state) : { root: null }
    if (needsCatalog && catalog.root === null) throw fail('catalog-unbound', '画风图库还没绑定，输入框里的画风图取不到')

    const files = listed.files ?? {}
    const pool = Array.isArray(files.upscale_models) ? files.upscale_models : []
    const notes = []
    const wanted = String(args.model ?? '').trim()
    let model = ''
    if (wanted.length > 0 && pool.includes(wanted)) model = wanted
    else if (wanted.length > 0) notes.push('放大模型 ' + wanted + ' 不在 upscale_models 里，已改用默认')
    if (model.length === 0) model = pool.includes(DEFAULT_UPSCALE_MODEL) ? DEFAULT_UPSCALE_MODEL : (pool[0] ?? '')
    if (model.length === 0) throw fail('model-missing', 'upscale_models 里没有放大模型：先放一个 RealESRGAN / 4xUltrasharp')

    const rawScale = Number(args.scale)
    const scale = Number.isFinite(rawScale) ? Math.min(Math.max(rawScale, 1.25), 4) : 2

    // 临时输入图攒在 input 根里：超过一小时的清掉，别越跑越肥。
    const inputRoot = listed.inputReal
    try {
      fs.mkdirSync(inputRoot, { recursive: true })
      for (const name of fs.readdirSync(inputRoot)) {
        if (!name.startsWith('dsh_upscale_')) continue
        const file = path.join(inputRoot, name)
        try {
          if (Date.now() - fs.statSync(file).mtimeMs > 3_600_000) fs.rmSync(file, { force: true })
        } catch {
          /* 正在被 ComfyUI 读的不管 */
        }
      }
    } catch {
      /* 清不掉旧临时文件不影响这一次 */
    }

    const now = new Date()
    const month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
    const stamp = String(now.getTime())
    const jobs = []
    const sources = []
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      const root = item.source === 'catalog' ? catalog.root : listed.outputReal
      const abs = resolveImage(root, item.rel)
      if (!fs.existsSync(abs)) throw fail('file-missing', '要放大的图不存在：' + abs)
      const ext = path.extname(abs).toLowerCase()
      if (!IMAGE_EXTENSIONS.includes(ext)) throw fail('save-target-invalid', '不是支持的图片类型：' + ext)
      const stem = path.basename(abs, path.extname(abs)).replace(/[^\p{L}\p{N}_.() -]+/gu, '_').slice(0, 48) || 'image'
      const inputName = 'dsh_upscale_' + stamp + '_' + String(index) + ext
      fs.copyFileSync(abs, path.join(inputRoot, inputName))
      jobs.push({
        inputName,
        prefix: 'upscale/' + month + '/' + stem + '_' + String(Number.isInteger(scale) ? scale : scale.toFixed(1)) + 'x',
      })
      sources.push({ source: item.source, rel: item.rel, name: path.basename(abs) })
    }

    const graph = buildUpscaleGraph({ jobs, model, scale })
    const clientId = 'dsh-comfy-upscale-' + randomUUID()
    const promptId = await submitPrompt(listed.comfyUrl, graph, clientId)
    rawCache.clear()
    return {
      promptId,
      model,
      scale,
      notes,
      sources,
      output: listed.outputReal,
      folder: 'upscale/' + month,
    }
  }
  /**
   * 查一次任务。`waitMs > 0` 时当场轮询到出结果，HTTP 侧用；
   * 页面用 `waitMs: 0`，每个 tick 查一次，不占着 RPC。
   */
  const job = async ({ promptId, waitMs = 0 } = {}) => {
    if (typeof promptId !== 'string' || promptId.length === 0) throw fail('prompt-required', '缺少 promptId')
    const listed = await dirs({ refresh: false })
    // 预览状态只属于当前这个任务；拿别的 id 来问就返回空，不张冠李戴。
    const owns = previewHub.promptId === promptId
    const previewView = {
      step: owns ? previewHub.current : null,
      stepsDone: owns ? previewHub.frames.size : 0,
      previewConnected: owns ? previewHub.connected : false,
      previewMethod: owns ? previewHub.method : null,
      interruptedBy: owns ? previewHub.interruptedBy : null,
    }
    if (waitMs > 0) {
      const result = await pollJob(listed.comfyUrl, promptId, { budgetMs: waitMs })
      const view = toJobView(promptId, result, listed)
      if (view.state === 'done') {
        rawCache.clear()
        previewHub.settle('done')
        schedulePreviewClose()
      }
      return { ...view, ...previewView }
    }
    try {
      const entry = (await history(listed.comfyUrl, promptId))?.[promptId]
      if (!entry) {
        // 中断后 /history 往往查不到这条：以本地标记为准，别一直判 running。
        if (owns && previewHub.state === 'interrupted') {
          return { promptId, state: 'interrupted', images: [], elapsedMs: null, output: listed.outputReal, ...previewView }
        }
        return { promptId, state: 'running', images: [], elapsedMs: null, output: listed.outputReal, ...previewView }
      }
      const read = readHistoryEntry(entry)
      const stat = entry.status?.status_str
      const stateName = stat === 'error' ? 'failed' : (read.images.length > 0 || entry.status?.completed ? 'done' : 'running')
      const view = toJobView(promptId, { state: stateName, ...read }, listed)
      // 新图刚落盘：图库缓存置脏，页面切过去就能看到，不用等 15 秒。
      if (view.state === 'done') {
        rawCache.clear()
        previewHub.settle('done')
        schedulePreviewClose()
      } else if (view.state === 'failed') {
        previewHub.settle('failed')
        schedulePreviewClose()
      }
      const interrupted = owns && previewHub.state === 'interrupted' && view.state !== 'done'
      return { ...view, state: interrupted ? 'interrupted' : view.state, ...previewView }
    } catch (error) {
      if (error?.status === 404) {
        if (owns && previewHub.state === 'interrupted') {
          return { promptId, state: 'interrupted', images: [], elapsedMs: null, output: listed.outputReal, ...previewView }
        }
        return { promptId, state: 'missing', images: [], elapsedMs: null, output: listed.outputReal, ...previewView }
      }
      throw error
    }
  }

  /**
   * 逐步预览快照：页面每 tick 拉一次增量（since = 上次的 nextSince）。
   * 只回元数据与步列表，图片字节走 `/dsh-comfy/preview/<step>`。
   */
  const preview = async ({ promptId, since = 0, limit } = {}) => {
    const snapshot = previewHub.snapshot({ promptId, since, limit })
    const state = stateOf()
    // taesd 没有权重时服务端不出帧：三帧的功夫还没有就判死，下次生成回落 latent2rgb。
    if (snapshot.previewMethod === 'taesd' && snapshot.steps.length === 0 && snapshot.state === 'running' && snapshot.current >= 3) {
      if (state.previewMethod !== 'latent2rgb') writeState({ previewMethod: 'latent2rgb' })
      snapshot.note = '没找到 vae_approx 权重，已改用 latent2rgb 近似预览（下一个任务生效）'
    }
    return snapshot
  }

  /**
   * 停止当前任务。
   * 先看队列在不在，再定向取消；已完成的不误报「已停止」。
   */
  const stop = async ({ promptId } = {}) => {
    const id = String(promptId ?? '').trim()
    if (id.length === 0) throw fail('prompt-required', '缺少 promptId')
    if (previewHub.promptId !== null && previewHub.promptId !== id) {
      throw fail('prompt-id-mismatch', '要停的任务不是当前这一张：' + id)
    }
    const listed = await dirs({ refresh: false })
    const position = await queuePosition(listed.comfyUrl, id).catch(() => null)
    if (position === null) {
      const entry = (await history(listed.comfyUrl, id).catch(() => null))?.[id]
      const done = entry !== undefined && (entry.status?.completed === true || readHistoryEntry(entry).images.length > 0)
      previewHub.push('info', done ? '任务已经结束，无需停止' : '队列里没有这个任务')
      return {
        promptId: id,
        outcome: done ? 'already-done' : 'not-running',
        step: previewHub.current,
        method: 'none',
        message: done ? '任务已经出完' : '队列里没有这个任务',
        at: Date.now(),
      }
    }
    const result = await cancelJob(listed.comfyUrl, id)
    previewHub.markInterrupted()
    previewHub.push('warn', '已发送停止请求（' + result.method + '，' + position + '）')
    schedulePreviewClose()
    return {
      promptId: id,
      outcome: result.outcome,
      step: previewHub.current,
      method: result.method,
      message: result.message,
      at: Date.now(),
    }
  }

  /**
   * 把成品图存一份到工作区：`<工作区>\.dsh-comfy\images\<yyyy-mm>\<文件名>`。
   * 只写白名单内的目录，不覆盖同名文件。
   */
  const saveImage = async ({ promptId, rel, name } = {}) => {
    const state = stateOf()
    const root = resolveWorkspacePath(ctx, state)
    if (!root) throw fail('workspace-unbound', '还没有绑定工作区：先点「更改」指一个目录')
    const listed = await dirs({ refresh: false })
    let sourcePath = null
    if (typeof rel === 'string' && rel.trim().length > 0) {
      sourcePath = resolveImage(listed.outputReal, rel)
    } else if (typeof promptId === 'string' && promptId.length > 0) {
      const entry = (await history(listed.comfyUrl, promptId))?.[promptId]
      const first = readHistoryEntry(entry).images[0]
      if (first === undefined) throw fail('file-missing', '这个任务还没有产物')
      sourcePath = resolveImage(listed.outputReal, path.join(first.subfolder || '', first.filename))
    } else {
      throw fail('path-required', '需要 promptId 或 rel')
    }
    if (!fs.existsSync(sourcePath)) throw fail('file-missing', '产物不存在：' + sourcePath)
    const ext = path.extname(sourcePath).toLowerCase()
    if (!IMAGE_EXTENSIONS.includes(ext)) throw fail('save-target-invalid', '不是支持的图片类型：' + ext)

    const realRoot = fs.realpathSync.native(root)
    const now = new Date()
    const month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
    const dir = path.join(realRoot, '.dsh-comfy', 'images', month)
    const relative = path.relative(realRoot, dir)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw fail('save-target-invalid', '目标路径越界：' + dir)
    }
    fs.mkdirSync(dir, { recursive: true })

    const wanted = path.basename(String(name ?? '') || path.basename(sourcePath))
    const safeName = path.basename(wanted).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    const stem = path.basename(safeName, ext)
    let target = path.join(dir, safeName)
    let index = 0
    // 不覆盖：同名就加 -1、-2……（截图里点两次不该把上一张冲掉）。
    while (fs.existsSync(target)) {
      index += 1
      target = path.join(dir, stem + '-' + index + ext)
      if (index > 999) throw fail('save-target-invalid', '同名文件太多：' + safeName)
    }
    fs.copyFileSync(sourcePath, target)
    return {
      ok: true,
      path: target,
      bytes: fs.statSync(target).size,
      overwritten: false,
      mode: 'workspace',
      note: null,
    }
  }

  /**
   * 拉起 ComfyUI：只负责 detach 启动，不在 RPC 里等。
   * 页面自己轮询 `probe`——把 120 秒的等待塞进一次 Remote 调用会被宿主超时掐掉。
   */
  /**
   * 关掉 ComfyUI 进程。
   *
   * 先看 8188 的监听者是谁：命令行里有 ComfyUI 根目录、或带 comfy / main.py 的 python，
   * 才认作「这台 ComfyUI」；认不出来就一个都不杀，别顺手做了别的服务。
   * 认出来就 taskkill /T /F 整棵树，再轮询端口直到不再响应。
   */
  // ------------------------------------------------------------ 模型库（Civitai）

  /** 目录缓存置脏：下载完成后页面点「刷新目录」能立刻看到新文件。 */
  const invalidateDirs = () => {
    dirsCache = null
    dirsLightCache = null
  }

  /** 数一个类别目录里的模型文件；只下钻两层，26 个类别一起数也不卡。 */
  const countModels = (dir) => {
    let count = 0
    const walk = (target, depth) => {
      let entries
      try {
        entries = fs.readdirSync(target, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (depth < 2) walk(path.join(target, entry.name), depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        if (MODEL_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) count += 1
      }
    }
    walk(dir, 0)
    return count
  }

  /**
   * 下载队列：单任务。结束后把目录缓存与搜索缓存置脏，页面点「刷新目录」就是新的。
   * `invalidateDirs` 在这里之后才声明，但回调只会在下载结束时跑，没有 TDZ 问题。
   */
  const hub = new HubDownloader({
    maxBytes: DEFAULT_MAX_BYTES,
    onFinish: () => {
      invalidateDirs()
      hubSearchCache.clear()
    },
  })

  /** 模型库第一屏：来源、key 三态、26 个目标目录、上限与占用状态。 */
  const hubStatus = async () => {
    const state = stateOf()
    const listed = await dirs({ light: true })
    const targets = MODEL_CATEGORIES.map((category) => {
      const dir = listed.models[category] ?? ''
      let exists = false
      try {
        exists = fs.statSync(dir).isDirectory()
      } catch {
        exists = false
      }
      return { category, path: dir, exists, count: exists ? countModels(dir) : 0 }
    })
    const credential = hubCredentials.status()
    // 封面 / 下载走的通道：探到本机代理就写地址，页面上一眼能看出「现在走没走代理」。
    const proxy = await detectProxy(state.hubProxy)
    const note = credential.error !== null
      ? credential.error.message
      : (credential.hasKey
        ? null
        : '公开列表不用 key；受限（gated）模型才需要填 Civitai API Key')
    return {
      host: String(state.hubHost || API_ORIGIN),
      apiBase: String(state.hubHost || API_ORIGIN) + '/api/v1',
      ...credential,
      keyFile: hubCredentials.filePath(),
      rememberKey: state.hubRememberKey !== false,
      targets,
      maxBytes: Number(state.hubMaxBytes) || DEFAULT_MAX_BYTES,
      overwrite: state.hubOverwrite === true,
      autoAdvice: state.hubAutoAdvice !== false,
      busy: hub.busy(),
      proxy: proxy === null ? null : proxy.url,
      proxySetting: typeof state.hubProxy === 'string' ? state.hubProxy : null,
      note,
    }
  }

  /**
   * 保存 / 清除 API Key。**返回体里永远没有 key 本身**。
   * `key:''` 恒等于清除；`persist` 省略时取「记住在本机」的默认值。
   */
  const hubKey = async ({ key, persist } = {}) => {
    const state = stateOf()
    if (typeof key === 'string' && key.trim().length === 0) {
      const cleared = await hubCredentials.clear()
      return { ...cleared, keyFile: hubCredentials.filePath() }
    }
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw fail('hub-invalid-url', '没有拿到 API Key')
    }
    const remember = persist === undefined ? state.hubRememberKey !== false : persist === true
    const result = await hubCredentials.setKey(key, { persist: remember })
    return { ...result, keyFile: hubCredentials.filePath() }
  }

  /** 搜模型：公开列表不需要 key；30 秒内同样的参数直接复用。 */
  const hubSearch = async (args = {}) => {
    const state = stateOf()
    const started = Date.now()
    const limit = Math.min(Math.max(Number.isFinite(args.limit) ? Math.trunc(args.limit) : 12, 1), 100)
    const params = new URLSearchParams()
    params.set('limit', String(limit))
    params.set('primaryFileOnly', args.primaryFileOnly === false ? 'false' : 'true')
    if (typeof args.types === 'string' && args.types.length > 0) params.set('types', args.types)
    if (typeof args.baseModels === 'string' && args.baseModels.length > 0) params.set('baseModels', args.baseModels)
    if (typeof args.sort === 'string' && args.sort.length > 0) params.set('sort', args.sort)
    if (typeof args.period === 'string' && args.period.length > 0) params.set('period', args.period)
    const nsfw = args.nsfw === undefined ? state.hubNsfw === true : args.nsfw === true
    if (nsfw) params.set('nsfw', 'true')
    if (typeof args.query === 'string' && args.query.trim().length > 0) {
      params.set('query', args.query.trim())
      // 全文搜索必须配 cursor 分页；没给 sort 时按下载量排，结果稳定点。
      if (!params.has('sort')) params.set('sort', 'Most Downloaded')
    }
    if (typeof args.cursor === 'string' && args.cursor.length > 0) params.set('cursor', args.cursor)
    else if (Number.isFinite(args.page) && args.page > 1) params.set('page', String(Math.trunc(args.page)))

    const key = params.toString()
    const hit = hubSearchCache.get(key)
    if (hit !== undefined && started - hit.at < 30_000) return { ...hit.value, cached: true, elapsedMs: Date.now() - started }

    const { json } = await fetchJson('/api/v1/models?' + key, { token: hubCredentials.current(), proxySetting: state.hubProxy })
    const rawItems = Array.isArray(json?.items) ? json.items : []
    // 逐条兜：上游字段形状随时会变（缺 images、缺 modelVersions、files 是 null），
    // 一条坏数据不该让整页只剩一句红色 gateway 错误。坏几条就少几条，其余照出。
    const items = []
    for (const raw of rawItems) {
      try {
        const model = normalizeModel(raw)
        if (model !== null) items.push(model)
      } catch {
        /* 这一条跳过 */
      }
    }
    const value = {
      host: String(state.hubHost || API_ORIGIN),
      items,
      nextCursor: typeof json?.metadata?.nextCursor === 'string' ? json.metadata.nextCursor : null,
      total: Number(json?.metadata?.totalItems ?? 0) || null,
      limit,
      elapsedMs: Date.now() - started,
      cached: false,
      note: items.length === 0 ? '没有匹配的模型，换个词或放宽类型' : null,
    }
    if (hubSearchCache.size >= 24) hubSearchCache.clear()
    hubSearchCache.set(key, { at: started, value })
    return value
  }

  /**
   * 粘贴链接 / 填 ID 直接定位。
   * 裸数字分不清是 model 还是 version：先按 model 试，404 再按 version 试。
   */
  const hubResolve = async ({ url, modelId, versionId } = {}) => {
    const state = stateOf()
    const positive = (value) => {
      const parsed = Number(value)
      return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
    }
    let kind = null
    let id = 0
    if (positive(modelId) > 0) {
      kind = 'model'
      id = positive(modelId)
    } else if (positive(versionId) > 0) {
      kind = 'version'
      id = positive(versionId)
    } else {
      const ref = parseRef(url)
      if (ref === null) {
        throw fail('hub-invalid-url', '认不出这个链接或 ID：支持 /models/<数字>、?modelVersionId=<数字>、/api/download/models/<数字>、纯数字')
      }
      kind = ref.kind
      id = ref.id
    }
    const token = hubCredentials.current()
    if (kind === 'model' || kind === 'id') {
      try {
        const { json } = await fetchJson('/api/v1/models/' + String(id), { token, proxySetting: state.hubProxy })
        const model = normalizeModel(json)
        if (model === null) throw fail('hub-api-error', '这个 ID 不是有效的模型')
        return { model, suggestedCategory: model.suggestedCategory, reason: '按模型 ID 定位', source: 'modelId' }
      } catch (error) {
        if (kind !== 'id' || error?.code !== 'hub-api-error') throw error
      }
    }
    const { json } = await fetchJson('/api/v1/model-versions/' + String(id), { token, proxySetting: state.hubProxy })
    const version = json !== null && typeof json === 'object' ? json : {}
    const meta = version.model !== null && typeof version.model === 'object' ? version.model : {}
    const model = normalizeModel({
      id: Number(version.modelId) || Number(meta.id) || 0,
      name: meta.name ?? ('版本 ' + String(id)),
      type: meta.type ?? '',
      nsfw: meta.nsfw === true,
      tags: [],
      stats: {},
      modelVersions: [version],
    })
    if (model === null) throw fail('hub-api-error', '这个版本号解析不出模型')
    return { model, suggestedCategory: model.suggestedCategory, reason: '按版本 ID 定位', source: 'versionId' }
  }

  /** 入队。校验、拆 `rejected`、起单任务都在 `HubDownloader` 里。 */
  const hubDownload = async ({ items, overwrite, token } = {}) => {
    const state = stateOf()
    const listed = await dirs({ light: true })
    return hub.start({
      token,
      items,
      overwrite: overwrite === undefined ? state.hubOverwrite === true : overwrite === true,
      credential: hubCredentials.current(),
      dirs: { models: listed.models, modelBase: listed.modelBase },
      maxBytes: Number(state.hubMaxBytes) || DEFAULT_MAX_BYTES,
    })
  }

  /** 只读轮询；页面刷新后只要宿主还活着就能接着看进度。 */
  const hubJob = async ({ token } = {}) => hub.snapshot(token)

  const hubCancel = async ({ token } = {}) => hub.cancel(token)

  /**
   * 安装建议：结构化事实 → 模型 → 白名单校验。
   * 模型挂了 / 没 provider / 输出不是 JSON 都降级成事实卡片，不报错中断。
   */
  const hubAdvice = async ({ token, question, provider, model, timeoutMs } = {}) => {
    const job = hub.snapshot(token)
    if (job.state === 'idle') throw fail('hub-job-missing', '还没有下载任务')
    const listed = await dirs({ refresh: false })
    const facts = buildFacts({ job, dirs: listed, workflows: listWorkflows(), question })
    if (facts.files.length === 0) throw fail('hub-job-missing', '这个任务没有已完成的文件')
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : 45_000
    try {
      const result = await llmComplete(ctx, {
        provider,
        model,
        system: SYSTEM_PROMPT_HUB,
        messages: [{ role: 'user', content: factsPrompt(facts) }],
        maxTokens: 900,
        temperature: 0.2,
        timeoutMs: budget,
      })
      const advice = parseAdvice(result.text)
      return {
        ...advice,
        usage: result.usage,
        provider: result.provider,
        model: result.model,
        degraded: false,
        reasonText: null,
        facts,
        report: adviceReport(advice, facts),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const advice = fallbackAdvice(facts, '没有拿到模型结论（' + message + '），下面只是事实')
      return {
        ...advice,
        usage: null,
        provider: provider ?? null,
        model: model ?? null,
        degraded: true,
        code: typeof error?.code === 'string' ? error.code : null,
        facts,
        report: adviceReport(advice, facts),
      }
    }
  }

/**
   * 模型库对话（标签 + 配置）：一轮一问，历史由页面带上来（只留最近 8 条）。
   * 跟 `hubAdvice` 的分工：那个是「下完自动给一次结论」，这个是用户能追问的对话框。
   */
  const hubChat = async ({ messages, context, provider, model, timeoutMs } = {}) => {
    const state = stateOf()
    const clean = (Array.isArray(messages) ? messages : [])
      .filter((item) => item && (item.role === 'user' || item.role === 'assistant')
        && typeof item.content === 'string' && item.content.trim().length > 0)
      .slice(-8)
      .map((item) => ({ role: item.role, content: item.content.slice(0, 4000) }))
    if (clean.length === 0 || clean[clean.length - 1].role !== 'user') throw fail('hub-chat-empty', '先说一句想问什么')
    const asked = context !== null && typeof context === 'object' ? context : {}
    const listed = await dirs({ refresh: false })
    const modelIn = asked.model !== null && typeof asked.model === 'object' ? asked.model : null
    const facts = {
      model: modelIn === null ? null : {
        name: String(modelIn.name ?? '').slice(0, 200),
        type: String(modelIn.type ?? '').slice(0, 40),
        creator: typeof modelIn.creator === 'string' ? modelIn.creator.slice(0, 80) : null,
        baseModels: (Array.isArray(modelIn.baseModels) ? modelIn.baseModels : []).filter((name) => typeof name === 'string').slice(0, 6),
        description: String(modelIn.description ?? '').slice(0, 1200),
        stats: modelIn.stats !== null && typeof modelIn.stats === 'object' ? modelIn.stats : null,
      },
      files: (Array.isArray(asked.selection) ? asked.selection : []).slice(0, 12).map((item) => ({
        name: String(item?.name ?? '').slice(0, 200),
        category: String(item?.targetCategory ?? '').slice(0, 40),
        baseModel: typeof item?.baseModel === 'string' ? item.baseModel.slice(0, 80) : null,
        trainedWords: (Array.isArray(item?.trainedWords) ? item.trainedWords : [])
          .filter((word) => typeof word === 'string').slice(0, 20),
        sizeBytes: Number(item?.sizeBytes) || 0,
      })),
      prompt: typeof asked.prompt === 'string' ? asked.prompt.slice(0, 600) : '',
      host: {
        modelBase: listed.modelBase ?? null,
        checkpoints: (listed.files?.checkpoints ?? []).slice(0, 12),
        loraCount: (listed.files?.loras ?? []).length,
        loras: (listed.files?.loras ?? []).slice(0, 24),
        categories: MODEL_CATEGORIES,
      },
      workflows: (listWorkflows().items ?? []).map((item) => ({
        id: item.id,
        title: item.title,
        loraSlots: Array.isArray(item.summary?.loras) ? item.summary.loras.length : 0,
        steps: item.summary?.steps ?? null,
        cfg: item.summary?.cfg ?? null,
      })),
    }
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : 45_000
    const result = await llmComplete(ctx, {
      provider: provider ?? state.provider,
      model: model ?? state.model,
      system: SYSTEM_PROMPT_CHAT,
      messages: [{ role: 'user', content: factsPrompt(facts) }, ...clean],
      maxTokens: 900,
      temperature: 0.3,
      timeoutMs: budget,
    })
    const answer = parseChat(result.text)
    return {
      ...answer,
      provider: result.provider ?? null,
      model: result.model ?? null,
      usage: result.usage ?? null,
      facts,
    }
  }

/** 翻译缓存：同一句只翻一次；名字与简介共用一份。 */
  const translateCache = new Map()
  const TRANSLATE_CACHE_MAX = 800

  /**
   * 批量英→中（模型名 / 简介）。只做翻译，不解释；同一句命中缓存就不再花钱。
   * @param args - `{ texts, provider, model, timeoutMs }`；最多 24 段、每段 1500 字。
   */
  const hubTranslate = async ({ texts, provider, model, timeoutMs, style } = {}) => {
    const state = stateOf()
    // 两种口吻：`lora` 是给文件名起中文短名（允许改写），其余是逐句翻译（专名保留）。
    const loraStyle = style === 'lora'
    const systemPrompt = loraStyle ? SYSTEM_PROMPT_TRANSLATE_LORA : SYSTEM_PROMPT_TRANSLATE
    const asked = [...new Set((Array.isArray(texts) ? texts : [])
      .filter((text) => typeof text === 'string' && text.trim().length > 0)
      .map((text) => text.trim().slice(0, 1500)))]
      .slice(0, 24)
    if (asked.length === 0) throw fail('hub-translate-empty', '没有要翻译的文本')
    const keyOf = (text) => (loraStyle ? 'lora:' : 'text:') + text
    const missing = asked.filter((text) => !translateCache.has(keyOf(text)))
    let providerUsed = null
    let modelUsed = null
    if (missing.length > 0) {
      const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : 40_000
      const result = await llmComplete(ctx, {
        provider: provider ?? state.provider,
        model: model ?? state.model,
        system: systemPrompt,
        messages: [{ role: 'user', content: missing.map((text, index) => String(index + 1) + '. ' + text).join('\n') }],
        maxTokens: 2500,
        temperature: 0.1,
        timeoutMs: budget,
      })
      const parsed = parseTranslations(result.text, missing.length)
      providerUsed = result.provider ?? null
      modelUsed = result.model ?? null
      for (let index = 0; index < missing.length; index += 1) {
        if (parsed[index].length === 0) continue
        translateCache.set(keyOf(missing[index]), parsed[index])
        while (translateCache.size > TRANSLATE_CACHE_MAX) {
          const oldest = translateCache.keys().next().value
          translateCache.delete(oldest)
        }
      }
    }
    return {
      items: asked.map((text) => ({ source: text, zh: translateCache.get(keyOf(text)) ?? '' })),
      provider: providerUsed,
      model: modelUsed,
      cached: missing.length === 0,
    }
  }

  /**
   * LoRA 触发词映射：不带 `put` 就是读；带了就合并写（下载时顺手记）。
   * 键是小写文件名，页面上按文件名查。
   */
  const hubTriggers = async ({ put } = {}) => {
    if (Array.isArray(put) && put.length > 0) {
      const entries = put.slice(0, 60).map((item) => ({
        name: String(item?.name ?? '').slice(0, 200),
        words: (Array.isArray(item?.words) ? item.words : []).filter((word) => typeof word === 'string').slice(0, 24),
      }))
      const merged = mergeTriggers(entries)
      return { items: merged.items, changed: merged.changed }
    }
    return { items: readTriggers(), changed: 0 }
  }

/**
   * 回填：拿本地文件名去 Civitai 搜，文件名对得上就把那个版本的 trainedWords 记下来。
   * 老下载的 LoRA 没有触发词记录，靠这个补；查不到就如实报 missed。
   */
  const hubLookupTriggers = async ({ names } = {}) => {
    const state = stateOf()
    const asked = [...new Set((Array.isArray(names) ? names : []).map((name) => String(name ?? '').trim()).filter((name) => name.length > 0))].slice(0, 8)
    if (asked.length === 0) throw fail('hub-request-invalid', '没有要查的文件名')
    const found = []
    const missed = []
    for (const name of asked) {
      const stem = name.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim()
      try {
        const params = new URLSearchParams({ query: stem, limit: '5', primaryFileOnly: 'false' })
        const { json } = await fetchJson('/api/v1/models?' + params.toString(), {
          token: hubCredentials.current(),
          proxySetting: state.hubProxy,
        })
        let hit = null
        for (const raw of Array.isArray(json?.items) ? json.items : []) {
          const model = normalizeModel(raw)
          if (model === null) continue
          for (const version of model.versions) {
            const match = version.files.some((file) => file.name.toLowerCase() === name.toLowerCase())
            if (!match || version.trainedWords.length === 0) continue
            hit = { name, words: version.trainedWords, modelName: model.name }
            break
          }
          if (hit !== null) break
        }
        if (hit === null) missed.push(name)
        else found.push(hit)
      } catch {
        missed.push(name)
      }
    }
    if (found.length > 0) mergeTriggers(found.map((item) => ({ name: item.name, words: item.words })))
    return { found, missed, items: readTriggers() }
  }

  /** 封面同源反代（**内部接口**，Buffer 不能过 RPC）。 */
  const hubCover = async ({ url } = {}) => fetchCover(url, { proxySetting: stateOf().hubProxy })

  const serviceStop = async ({ dryRun = false } = {}) => {
    const listed = await dirs({ refresh: false, light: true })
    const live = await probeService(listed.comfyUrl)
    if (!live.ok) return { stopped: false, reason: '服务本来就没在跑', pids: [] }
    let port = '8188'
    try {
      port = new URL(listed.comfyUrl).port || port
    } catch {
      // URL 不规范就用默认端口
    }
    const raw = await execPowerShell([
      '$pids = Get-NetTCPConnection -LocalPort ' + String(Number(port)) + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique;',
      '$rows = foreach ($p in $pids) { $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p); if ($proc) { [pscustomobject]@{ pid = $proc.ProcessId; name = $proc.Name; cmd = $proc.CommandLine; exe = $proc.ExecutablePath } } };',
      '$rows | ConvertTo-Json -Compress',
    ].join(' '))
    let rows = []
    try {
      const parsed = raw.trim().length > 0 ? JSON.parse(raw) : []
      rows = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      rows = []
    }
    if (rows.length === 0) {
      return { stopped: false, reason: '端口在响应，但没查到监听进程（可能是别的程序占了 ' + port + '）', pids: [] }
    }
    const comfyRoot = String(listed.comfyRoot ?? '')
    const targets = rows.filter((row) => {
      const cmd = String(row?.cmd ?? '')
      const exe = String(row?.exe ?? '')
      const name = String(row?.name ?? '').toLowerCase()
      if (cmd.length === 0) return false
      if (comfyRoot.length > 0 && (cmd.toLowerCase().includes(comfyRoot.toLowerCase()) || exe.toLowerCase().startsWith(comfyRoot.toLowerCase()))) return true
      if (/comfy/i.test(cmd)) return true
      return name.startsWith('python') && /main\.py/i.test(cmd)
    })
    if (targets.length === 0) {
      return {
        stopped: false,
        reason: '8188 上跑的不是这台 ComfyUI（命令行对不上），没动它',
        pids: [],
        processes: rows.map((row) => ({ pid: row.pid, name: row.name, cmd: String(row.cmd ?? '').slice(0, 160) })),
      }
    }
    const pids = targets.map((row) => Number(row.pid)).filter(Number.isFinite)
    if (dryRun === true) return { stopped: false, dryRun: true, pids, processes: targets.map((row) => ({ pid: row.pid, name: row.name })) }
    for (const pid of pids) {
      await new Promise((resolve) => {
        const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        child.on('error', () => resolve())
        child.on('exit', () => resolve())
      })
    }
    let stillUp = true
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const again = await probeService(listed.comfyUrl)
      stillUp = again.ok
      if (!stillUp) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    dirsCache = null
    dirsLightCache = null
    rawCache.clear()
    return {
      stopped: !stillUp,
      pids,
      port: Number(port),
      note: stillUp ? '进程杀了但 ' + port + ' 还在响应，可能还有别的实例' : null,
    }
  }

  const serviceStart = async () => {
    const state = stateOf()
    const scripts = defaultLaunchScripts()
    const ps1 = state.launchScript ? state.launchScript.replace(/run-comfyui\.cmd$/i, 'start-comfyui.ps1') : scripts.ps1
    if (!fs.existsSync(ps1)) throw fail('script-missing', '找不到拉起脚本：' + ps1)
    const before = await dirs({ refresh: true })
    if (before.service === 'up') return { started: false, alreadyRunning: true, comfyUrl: before.comfyUrl }

    // 拉起全程留痕：powershell 自己的 stdout/stderr 也收进 launch.log，
    // 之前点了没反应、日志零行，就是因为 stdio 被丢进 'ignore'，什么都没留下。
    const launchLog = path.join(stateDir(), 'launch.log')
    const note = (line) => {
      try { fs.appendFileSync(launchLog, '[' + new Date().toISOString() + '] ' + line + '\n') } catch { /* 日志写不进去不影响流程 */ }
    }
    note('spawn ' + ps1)
    // 不用 detached（Windows 上 detached+重定向会让 powershell 秒退 0、什么都不做，实测复现），
    // 也不用把裸 fd 塞进 stdio（继承不可靠、子进程拿不到句柄）。用 pipe 自己收、自己写日志。
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let spawnError = null
    let tail = ''
    const collect = (chunk) => {
      const text = String(chunk)
      tail = (tail + text).slice(-4000)
      try { fs.appendFileSync(launchLog, text) } catch { /* ignore */ }
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (error) => {
      spawnError = error
      note('spawn error ' + (error.code ?? '') + ' ' + error.message)
    })
    const exited = new Promise((resolve) => child.on('exit', (code) => {
      note('powershell exit ' + String(code) + (tail.trim().length > 0 ? ' — 末尾：' + tail.trim().split('\n').slice(-3).join(' | ') : '（无输出）'))
      resolve(typeof code === 'number' ? code : -1)
    }))
    // 等 5 秒：ENOENT 是异步冒出来的；脚本立刻非零退出（比如 WMI 建进程被拒）也要当场看见。
    const earlyExit = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 5000))])
    if (spawnError !== null) {
      throw fail('launch-failed', '没能启动 powershell（' + (spawnError.code ?? '') + ' ' + spawnError.message + '）；日志：' + launchLog)
    }

    // powershell 秒退 0 ＝ 它探到 /system_stats 已经是 200（我 spawn 之前那一下还没起来，脚本自己等到了）。
    // 这种情况按「已经在跑」回，别让页面显示「已提交（无 pid）」然后干等。
    if (earlyExit === 0) {
      dirsCache = null
      dirsLightCache = null
      return {
        started: false,
        alreadyRunning: true,
        comfyUrl: before.comfyUrl,
        pid: child.pid ?? null,
        script: ps1,
        launchLog,
        log: 'C:\\Comfyui Driver\\ComfyUI\\comfyui-launch.log',
      }
    }

    let fallbackPid = null
    if (earlyExit !== null && earlyExit !== 0) {
      // 主脚本自己失败了：退回「cmd /c start」直接拉起 run-comfyui.cmd。
      const cmdFile = ps1.replace(/start-comfyui\.ps1$/i, 'run-comfyui.cmd')
      if (fs.existsSync(cmdFile)) {
        const fallback = spawn('cmd.exe', ['/c', 'start', '', '/min', cmdFile], { detached: true, stdio: 'ignore', windowsHide: true })
        fallback.on('error', () => { /* 兜底也失败就不再翻花样，交给页面轮询报超时 */ })
        fallback.unref()
        fallbackPid = fallback.pid ?? null
        try {
          fs.appendFileSync(launchLog, '[' + new Date().toISOString() + '] powershell exit ' + earlyExit + ', fallback cmd start -> ' + cmdFile + '\n')
        } catch { /* ignore */ }
      }
    }

    dirsCache = null
    dirsLightCache = null
    return {
      started: true,
      alreadyRunning: false,
      comfyUrl: before.comfyUrl,
      // 主脚本还在跑（还没退出）就报它的 pid；退了则报兜底的 pid，两个都没有就是 null，页面照实说。
      pid: earlyExit === null ? (child.pid ?? null) : fallbackPid,
      exitCode: earlyExit,
      fallback: earlyExit !== null && earlyExit !== 0,
      script: ps1,
      launchLog,
      log: 'C:\\Comfyui Driver\\ComfyUI\\comfyui-launch.log',
    }
  }

  const config = async ({ patch } = {}) => {
    if (patch && typeof patch === 'object') {
      const next = writeState(patch)
      dirsCache = null
      dirsLightCache = null
      return next
    }
    return stateOf()
  }

  /**
   * 取某一帧的原始字节（**内部接口**，只给 index.js 的 `/dsh-comfy/preview/<step>` 用）。
   * 不进 Typert 契约：Buffer 不是可跨 RPC 序列化的形状。
   */
  const previewFrame = async ({ step } = {}) => {
    const frame = previewHub.frame(Number(step))
    if (frame === null) throw fail('preview-frame-missing', '这一帧已过期：' + String(step))
    return { bytes: frame.bytes, mime: frame.mime, at: frame.at }
  }

  /** 插件卸载时关掉预览连接。 */
  const dispose = async () => {
    cancelPreviewClose()
    previewHub.dispose()
    // 队列停掉、内存 key 清掉；**凭据文件留着**——「重启免填」靠的就是它。
    hub.dispose()
    hubCredentials.forget()
    stopNsfwTagger()
    // 改写若还在跑，别把宿主的流留到插件卸载之后。
    disposeRewrites()
  }

  return {
    probe,
    dirs,
    models,
    complete,
    workspace,
    workspaceBind,
    submit,
    rewritePlan,
    rewriteApply,
    rewriteCancel,
    generate,
    upscale,
    job,
    serviceStart,
    serviceStop,
    config,
    gallery,
    nsfwStatus,
    nsfwScan,
    catalog,
    catalogBind,
    catalogRoot,
    workflows,
    preview,
    stop,
    saveImage,
    hubStatus,
    hubKey,
    hubSearch,
    hubResolve,
    hubDownload,
    hubJob,
    hubCancel,
    hubAdvice,
    hubChat,
    hubTranslate,
    hubTriggers,
    hubLookupTriggers,
    hubCover,
    previewFrame,
    dispose,
  }
}

/** 跑一条 powershell，拿 stdout；超时或失败都当空结果，调用方自己兜。 */
function execPowerShell(script, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(out)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已经退了 */ }
      finish()
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { out += chunk })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', () => { /* 错误信息不用，调用方看空结果 */ })
    child.on('error', finish)
    child.on('exit', finish)
  })
}

/** 统一 job 返回形状，页面与 HTTP 都读这一份。 */
function toJobView(promptId, result, listed) {
  const images = Array.isArray(result.images) ? result.images : []
  return {
    promptId,
    state: result.state ?? 'running',
    images,
    messages: Array.isArray(result.messages) ? result.messages : [],
    elapsedMs: result.elapsedMs ?? null,
    output: listed.outputReal,
    outputUrl: images.length > 0 ? images[0].url : null,
    filePath: images.length > 0
      ? path.join(listed.outputReal, images[0].subfolder || '', images[0].filename)
      : null,
    realPathChecked: images.length > 0 ? realPath(listed.outputReal) : null,
  }
}
