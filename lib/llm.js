/**
 * lib/llm.js — 把宿主 `ctx.llm` 收成两个动作：列模型、跑一次补全。
 *
 * 插件自己不存任何 API key：路由、凭据、重试都是宿主的 `ctx.llm` 的事，
 * 这里只负责选 provider/model、拼 messages、把流式块拼回一段文本。
 */

export const SYSTEM_PROMPT_REWRITE = [
  '你是 ComfyUI 的提示词工程师。',
  '把用户给的中文或中英混杂描述，改写成一段可直接粘进 ComfyUI 正向提示词框的英文描述：',
  '用逗号分隔的短语，先主体与动作，再服饰/表情，再构图与镜头，最后画质与风格；',
  '保留用户原本的意图和具体细节，不要新增不存在的设定；不要输出解释、标题、引号或代码块。',
  '如果用户描述里有否定内容（不要某物），把它单独写成一行以 `Negative:` 开头。',
].join('')

/**
 * 列可用 provider 与其模型。
 * 宿主没有 `llm` 服务时返回 `available: false`，页面照常渲染，只是下拉为空。
 * @param ctx - 宿主 Context。
 */
export async function listModels(ctx) {
  const llm = ctx.get?.('llm')
  if (!llm || typeof llm.listProviders !== 'function') {
    return { available: false, reason: '宿主没有 llm 服务', providers: [], default: null }
  }
  const providers = []
  for (const provider of llm.listProviders()) {
    let models = []
    let error = null
    try {
      const listed = await llm.listModels(provider.id)
      models = (Array.isArray(listed) ? listed : []).map((model) => ({
        id: model.id,
        name: model.name || model.id,
        description: model.description ?? null,
      }))
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
    }
    providers.push({ id: provider.id, name: provider.name || provider.id, models, error })
  }
  const deepseek = providers.find((provider) => provider.id === 'deepseek' && provider.models.length > 0)
  const first = deepseek ?? providers.find((provider) => provider.models.length > 0) ?? null
  const preferred = first?.models.find((model) => model.id === 'deepseek-flash') ?? first?.models[0] ?? null
  return {
    available: providers.length > 0,
    reason: providers.length > 0 ? null : '没有注册任何 provider',
    providers,
    default: first && preferred ? { provider: first.id, model: preferred.id } : null,
  }
}

/**
 * 跑一次补全，把流拼成整段文本。
 * @param ctx - 宿主 Context。
 * @param args - `{ provider, model, messages?, text?, system?, maxTokens?, temperature?, timeoutMs?, signal?, onChunk? }`
 *   `signal` 是 AbortSignal，`timeoutMs` 到点自己中止，两者都会关掉迭代器再抛错。
 * @returns `{ text, usage, provider, model, reasoning }`
 */
export async function complete(ctx, args = {}) {
  const llm = ctx.get?.('llm')
  if (!llm || typeof llm.stream !== 'function') {
    const error = new Error('宿主没有 llm 服务，无法调用大模型')
    error.code = 'llm-unavailable'
    throw error
  }
  const raw = Array.isArray(args.messages) && args.messages.length > 0
    ? args.messages
    : [{ role: 'user', content: String(args.text ?? '') }]
  const messages = raw.map(normalizeMessage)
  const chosen = args.provider && args.model
    ? { provider: args.provider, model: args.model }
    : await pickDefault(ctx)
  if (!chosen) {
    const error = new Error('没有可用模型：先在 DSH 里配置一个 provider')
    error.code = 'llm-no-model'
    throw error
  }

  const options = {
    provider: chosen.provider,
    model: chosen.model,
    messages,
    purpose: 'comfy-workbench',
  }
  if (typeof args.system === 'string' && args.system.length > 0) options.system = args.system
  if (Number.isFinite(args.maxTokens)) options.maxTokens = Math.trunc(args.maxTokens)
  if (Number.isFinite(args.temperature)) options.temperature = Number(args.temperature)

  const iterator = toIterator(llm.stream(options))
  if (iterator === null) {
    const error = new Error('宿主的 llm.stream 没有返回可迭代对象')
    error.code = 'llm-unavailable'
    throw error
  }
  let text = ''
  let reasoning = ''
  let usage = null
  let failure = null
  let stopReason = null
  const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? Math.trunc(args.timeoutMs) : 0
  const signal = args.signal ?? null
  // 超时 / 取消都不靠 for-await 自己断（它断不了正在 await 的 next()）：
  // 一个「唤醒」promise 和 next() 赛跑，谁先来算谁；finally 里再 iterator.return()。
  let wake = null
  const stopped = new Promise((resolve) => { wake = resolve })
  let signaled = false
  const trigger = (reason) => {
    if (signaled) return
    signaled = true
    if (wake !== null) {
      const fn = wake
      wake = null
      fn(reason)
    }
  }
  const onAbort = () => trigger('cancelled')
  if (signal !== null) {
    if (signal.aborted === true) trigger('cancelled')
    else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = timeoutMs > 0 ? setTimeout(() => trigger('timeout'), timeoutMs) : null
  timer?.unref?.()
  try {
    while (true) {
      const step = await Promise.race([
        iterator.next().then((value) => ({ kind: 'chunk', value }), (error) => ({ kind: 'error', error })),
        stopped.then((reason) => ({ kind: 'stop', reason })),
      ])
      if (step.kind === 'stop') {
        stopReason = step.reason
        break
      }
      if (step.kind === 'error') throw step.error
      if (step.value?.done === true) break
      const chunk = step.value?.value
      if (typeof args.onChunk === 'function') {
        try {
          args.onChunk(chunk)
        } catch {
          /* 回调自己的错不该拖垮补全 */
        }
      }
      if (chunk?.type === 'text-delta') text += chunk.text
      else if (chunk?.type === 'reasoning-delta') reasoning += chunk.text
      else if (chunk?.type === 'usage') usage = chunk.usage
      else if (chunk?.type === 'block-end' && text.length === 0 && chunk.block?.type === 'text') text += chunk.block.text
      else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') failure = chunk.reason.failure
      else if (chunk?.type === 'finish' && chunk.reason?.kind === 'aborted') failure = chunk.reason.failure
    }
  } finally {
    if (timer !== null) clearTimeout(timer)
    if (signal !== null && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
    // 中止时也必须显式关掉异步迭代器，否则宿主的流式连接会一直挂着。
    // 但不能无限等：宿主若正卡在一次网络读上，return() 要等那次读结束才落地，
    // 所以最多等 300ms，剩下的交给宿主自己的清理——超时承诺的是「调用方拿到结果」，不是「流立刻消失」。
    try {
      const closing = iterator.return?.()
      if (closing !== undefined && closing !== null && typeof closing.then === 'function') {
        await Promise.race([
          closing.catch(() => null),
          new Promise((resolve) => setTimeout(resolve, 300)),
        ])
      }
    } catch {
      /* 已经结束了 */
    }
  }
  if (stopReason === 'timeout') {
    const error = new Error('大模型调用超时（' + timeoutMs + 'ms）')
    error.code = 'llm-timeout'
    throw error
  }
  if (stopReason === 'cancelled') {
    const error = new Error('大模型调用已取消')
    error.code = 'llm-cancelled'
    throw error
  }
  if (failure) {
    const error = new Error('大模型调用失败：' + (failure.message || failure.code || '未知原因'))
    error.code = failure.code || 'llm-failed'
    throw error
  }
  return { text: text.trim(), reasoning: reasoning.trim(), usage, provider: chosen.provider, model: chosen.model }
}

/**
 * 宿主 `llm.stream` 的消息 `content` 要的是内容块数组，不是一段字符串。
 * 传裸字符串时适配器内部会跑 `content.some(...)`，直接抛 `content.some is not a function`
 * （2026-11-23 本机实测：deepseek-official 报的是更难认的 TRANSPORT 失败，google 报的才是这句）。
 * 所以统一包成 `[{ type: 'text', text }]`；已经是数组的原样放行，数组里的字符串块也补成块。
 */
function normalizeMessage(message) {
  if (message === null || typeof message !== 'object') return message
  if (typeof message.content === 'string') {
    return { ...message, content: [{ type: 'text', text: message.content }] }
  }
  if (Array.isArray(message.content)) {
    return {
      ...message,
      content: message.content.map((part) => (typeof part === 'string' ? { type: 'text', text: part } : part)),
    }
  }
  return message
}

/** 容错拿异步迭代器：宿主给 AsyncIterable 或 AsyncIterator 都认。 */
function toIterator(stream) {
  if (stream === null || stream === undefined) return null
  if (typeof stream[Symbol.asyncIterator] === 'function') return stream[Symbol.asyncIterator]()
  if (typeof stream.next === 'function') return stream
  return null
}

/** 选一组默认 provider/model，规则与页面下拉一致。 */
async function pickDefault(ctx) {
  const listed = await listModels(ctx)
  return listed.default ?? null
}

/**
 * 提示词改写：输入一段人话，拿回一段英文提示词。
 * @param ctx - 宿主 Context。
 * @param args - `{ text, provider?, model?, maxTokens? }`
 */
export async function rewritePrompt(ctx, args = {}) {
  const text = String(args.text ?? '').trim()
  if (text.length === 0) {
    const error = new Error('输入框是空的，没有可改写的内容')
    error.code = 'empty-input'
    throw error
  }
  const result = await complete(ctx, {
    provider: args.provider,
    model: args.model,
    system: SYSTEM_PROMPT_REWRITE,
    messages: [{ role: 'user', content: text }],
    maxTokens: Number.isFinite(args.maxTokens) ? args.maxTokens : 1024,
    temperature: Number.isFinite(args.temperature) ? args.temperature : 0.7,
  })
  return { ...result, source: text }
}
