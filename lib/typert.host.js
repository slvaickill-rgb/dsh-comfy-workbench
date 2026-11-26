// lib/typert.host.js — build-time typert contract for dsh-comfy-workbench.
//
// The official dsh-typert-loader reads the `./typert` export named in package.json and
// registers these invocations at boot, so the client half can call them through Remote.
//
// This file must stay free of bare-package imports: the loader imports it directly with
// `import(pathToFileURL(path))`, and a link-installed plugin resolves no bare packages there.

const PACKAGE = 'dsh-comfy-workbench'

/** Every endpoint this package exposes to its own page. One name = one Remote method. */
export const ENDPOINTS = [
  'probe',
  'dirs',
  'models',
  'complete',
  'workspace',
  'workspaceBind',
  'submit',
  'generate',
  'job',
  'serviceStart',
  'serviceStop',
  'config',
  'gallery',
  'nsfwStatus',
  'nsfwScan',
  'catalog',
  'catalogBind',
  'workflows',
  'preview',
  'stop',
  'saveImage',
  'upscale',
  'rewritePlan',
  'rewriteApply',
  'rewriteCancel',
  'hubStatus',
  'hubKey',
  'hubSearch',
  'hubResolve',
  'hubDownload',
  'hubJob',
  'hubCancel',
  'hubAdvice',
  'hubChat',
]

const ARGS_SYMBOL = PACKAGE + '/typert#EndpointArgs'
const RESULT_SYMBOL = PACKAGE + '/typert#JsonResult'

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

/** Results only reject cyclic references; dropped undefined fields match the official src-json path. */
function assertMarshalable(value, seen) {
  const marker = seen || new Set()
  if (value === null || typeof value !== 'object') return value
  if (marker.has(value)) throw new TypeError('cyclic RPC result')
  marker.add(value)
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) assertMarshalable(value[index], marker)
      return value
    }
    for (const key of Reflect.ownKeys(value)) assertMarshalable(value[key], marker)
    return value
  } finally {
    marker.delete(value)
  }
}

/** Args codec: strict + non-empty typeSymbol + create() — the loader's hard requirements. */
export function argsCodec() {
  return {
    mode: 'strict',
    typeSymbol: ARGS_SYMBOL,
    create: () => ({
      parse(value) {
        if (!isPlainObject(value)) throw new TypeError(PACKAGE + ': endpoint args must be a plain object')
        return value
      },
    }),
  }
}

/** Result codec: encode is mandatory — a strict codec without it skips the gateway's own result handling. */
export function resultCodec() {
  return {
    mode: 'strict',
    typeSymbol: RESULT_SYMBOL,
    create: () => ({ parse: (value) => assertMarshalable(value) }),
    encode: (value) => assertMarshalable(value),
  }
}

/**
 * One endpoint's InvocationDescriptor.
 * `namespace` must equal the package name: the client-side service key is `remote.<namespace>`.
 * @param endpoint - the endpoint (method) name.
 * @returns the descriptor.
 */
export function buildInvocation(endpoint) {
  return {
    id: PACKAGE + '#' + PACKAGE + '/' + endpoint,
    service: PACKAGE,
    namespace: PACKAGE,
    method: endpoint,
    invocation: { kind: 'direct' },
    parameters: [{ name: 'args', wire: 'args', source: 'json', codec: argsCodec() }],
    result: resultCodec(),
    sourceLocation: { file: 'lib/typert.host.js', line: 1, column: 1 },
  }
}

/**
 * The export the official loader reads (mod.TYPERT). `schemas` stays empty: every endpoint
 * takes one plain JSON object, so the codecs above are the whole contract.
 */
export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: ENDPOINTS.map((name) => buildInvocation(name)),
  model: { services: [], events: [], objects: [] },
}

export default TYPERT
