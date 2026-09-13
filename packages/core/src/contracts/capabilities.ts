/**
 * Runtime capability descriptor — rfcs/0001 §14.1.
 *
 * This is not documentation. The compilation layer reads it: `eval: false`
 * switches every compiled subsystem to its interpreted twin, `cpuTimeLimited`
 * changes default limits, and plugins declare `requires` against it so that
 * "this needs a filesystem" fails at boot rather than at 3am.
 */
export interface Capabilities {
  /** May we use `new Function`? (workerd: false) */
  readonly eval: boolean
  readonly webStreams: boolean
  readonly nodeStreams: boolean
  readonly fs: boolean
  readonly compression: 'native' | 'library' | 'none'
  readonly http2: boolean
  readonly websocket: 'native' | 'library' | 'none'
  readonly timers: 'full' | 'limited'
  readonly asyncLocalStorage: boolean
  readonly cpuTimeLimited: boolean
}

export const DEFAULT_CAPABILITIES: Capabilities = {
  eval: true,
  webStreams: true,
  nodeStreams: true,
  fs: true,
  compression: 'library',
  http2: false,
  websocket: 'library',
  timers: 'full',
  asyncLocalStorage: true,
  cpuTimeLimited: false,
}
