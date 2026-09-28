/**
 * Stratum 1 — the entire cross-subsystem vocabulary.
 *
 * Every reference between subsystems goes through this module, which is what
 * makes I6 ("two implementations of everything") mechanically possible: a
 * `Router` implementation imports `contracts/router` and nothing else from the
 * framework. Apart from three small `const` tables, this layer compiles to
 * zero runtime bytes.
 */
export type * from './http.ts'
export type * from './coercion.ts'
export type * from './config.ts'
export type * from './json-schema.ts'
export type * from './adapter.ts'
export type * from './context.ts'
export type * from './graph.ts'
export type * from './html.ts'
export type * from './logger.ts'
export type * from './middleware.ts'
export type * from './negotiation.ts'
export type * from './reply.ts'
export type * from './route.ts'
export type * from './router.ts'
export type * from './slot.ts'
export type * from './standard-schema.ts'

export { DEFAULT_CAPABILITIES } from './capabilities.ts'
export type { Capabilities } from './capabilities.ts'
export {
  REQUEST_PHASES, APP_PHASES, PIPELINE_PHASES, POST_FAMILY, UNAVAILABLE_PHASES, isRequestPhase,
} from './hook.ts'
export type {
  Phase, RequestPhase, AppPhase, PipelinePhase, HookFn, HookPlan, HookRecord, RouteHooks,
} from './hook.ts'
export {
  COERCION_DEFAULTS, COERCION_OFF, BOOLEAN_WORDS, VALIDATION_SOURCES,
} from './coercion.ts'
export { CONFIG_LAYERS, LAYER_RANK, REDACTED, CONFIG_DEFAULTS, EMPTY_SNAPSHOT } from './config.ts'
export { TIMEOUT_STAGES, TIMEOUT_STATUS, CLIENT_CLOSED } from './deadline.ts'
export { HEALTH_MEDIA_TYPE, HEALTH_STATUS, HEALTH_DEFAULTS } from './health.ts'
export type {
  HealthStatus, ServiceState, ProbeKind, CheckOutcome, ProbeResult, HealthProbe,
  CheckOptions, CheckRecord, ComponentReport, HealthReport,
} from './health.ts'
export type {
  TimeoutSpec, TimeoutStage, TimeoutInfo, TimeoutOptions, TimeoutRecord,
} from './deadline.ts'
export { SYNC_MARKER } from './middleware.ts'
export { isStandardSchema } from './standard-schema.ts'
