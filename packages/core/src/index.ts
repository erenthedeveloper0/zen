/**
 * `@visionpilot/zen-core` — registries, compilers, runtime, context, errors, response engine.
 *
 * Zero runtime dependencies. Not a slogan: a CI check (§19.8).
 */

// ── contracts (stratum 1) ───────────────────────────────────────────────────
export type * from './contracts/index.ts'
export {
  DEFAULT_CAPABILITIES, REQUEST_PHASES, APP_PHASES, PIPELINE_PHASES, POST_FAMILY,
  UNAVAILABLE_PHASES, isRequestPhase, SYNC_MARKER, isStandardSchema,
  TIMEOUT_STAGES, TIMEOUT_STATUS, CLIENT_CLOSED,
  HEALTH_MEDIA_TYPE, HEALTH_STATUS, HEALTH_DEFAULTS,
  COERCION_DEFAULTS, COERCION_OFF, BOOLEAN_WORDS, VALIDATION_SOURCES,
  CONFIG_LAYERS, LAYER_RANK, REDACTED, CONFIG_DEFAULTS, EMPTY_SNAPSHOT,
} from './contracts/index.ts'

// ── primitives (stratum 0) ──────────────────────────────────────────────────
export {
  normalizePath, joinPath, splitSegments, pathnameOf, queryStringOf, safeDecode, decodeComponent,
} from './primitives/path.ts'
export { parseDuration, formatDuration, type Duration } from './primitives/time.ts'
export { parseDotenv, dotenvChain, type DotenvResult, type EnvEntry } from './primitives/dotenv.ts'
export { generateRequestId } from './primitives/id.ts'

// ── errors ──────────────────────────────────────────────────────────────────
export { Codes, docsUrl, type ZenCode } from './errors/codes.ts'
export {
  ZenError, FrameworkError, BootError, isZenError, withoutStack, type ZenErrorInit, type Diagnostic,
} from './errors/zen-error.ts'
export {
  HttpError, BadRequest, Unauthorized, Forbidden, NotFound, MethodNotAllowed, NotAcceptable,
  RequestTimeout, Conflict, PayloadTooLarge, UnsupportedMediaType, TooManyRequests, Internal,
  ServiceUnavailable, GatewayTimeout, ValidationError, issue, type Issue,
} from './errors/http-errors.ts'

// ── compile (stratum 3) ─────────────────────────────────────────────────────
export { CodeGen, CodeGenError, type CodeUnit, type CodeGenOptions } from './compile/codegen.ts'
export { compileContext, type ContextClass, type Decoration } from './compile/context-compiler.ts'
export {
  compilePipeline, simplePipeline, classifySync, markSync, NO_HOOKS,
  type CompiledPipeline, type PipelineSpec, type PipelineStep, type SyncClass, type ValidatorStep,
} from './compile/pipeline-compiler.ts'
export {
  resolveHooks, routeHookRecords, pipelinePlan, functionsFor, diagnoseUnavailable, diagnoseUnknown,
  diagnoseMisplaced,
  type HookScope,
} from './compile/hook-plan.ts'
export {
  resolveTimeout, timeoutDiagnostic,
  type TimeoutSource, type TimeoutResolution,
} from './compile/deadline-plan.ts'
export {
  compileValidator, combineValidators, normaliseIssues, type ValidationSource,
} from './compile/validation.ts'

// ── coercion (§11.4) ────────────────────────────────────────────────────────
export {
  resolveCoercion, buildCoercePlan, planRoute, isInert, describeField,
  type ResolvedProfiles, type PlanOutcome,
} from './compile/coercion-plan.ts'
export {
  coerceNumber, coerceInteger, coerceBoolean, coerceBooleanIn, splitList,
  COERCE_RUNTIME, type CoerceRuntime,
} from './compile/coercion-runtime.ts'
export { walkCoercer, apply as applyCoercion, type Coercer } from './compile/coercion-walk.ts'
export { compileCoercer, generateCoercerSource } from './compile/coercion-compiler.ts'

// ── serialization (§13.3) ───────────────────────────────────────────────────
export {
  jsonSchema, registerSchemaConverter, schemaConverterFor, toJsonSchema, resolveRef,
  isDescribeOnly, __resetSchemaConverters,
} from './compile/json-schema.ts'
export { buildProgram, encodeLiteral } from './compile/serializer-ir.ts'
export type {
  SerNode, SerProp, SerBranch, SerTest, SerProgram, IrDiagnostic, IrResult,
} from './compile/serializer-ir.ts'
export { makeRuntime, escapeString, type SerRuntime } from './compile/serializer-runtime.ts'
export { walkSerializer, matches } from './compile/serializer-walk.ts'
export { compileSerializer, generateSerializerSource, type Serializer } from './compile/serializer-compiler.ts'
export {
  buildSerializerTable, buildSerializer, compileStatusSerializer,
  type SerializerTable, type SerializerMode, type SerializerBuildOptions, type SerializerBuildResult,
  type StatusSerializerResult,
} from './compile/serializer.ts'
export { SerializationError } from './errors/serialization-error.ts'

// ── content negotiation (§13.4) ─────────────────────────────────────────────
export {
  parseAccept, qualityFor, rangeCovers, normaliseMediaType, isMediaProblem,
  isVariantRecord, isJsonMedia, wireMediaType, MAX_ACCEPT_RANGES,
  type AcceptRange, type DeclaredMedia, type MediaProblem,
} from './compile/media-type.ts'
export {
  buildNegotiation, registerMediaEncoder, mediaEncoderFor, __resetMediaEncoders,
  type NegotiationBuildResult,
} from './compile/negotiation.ts'

// ── runtime (stratum 4) ─────────────────────────────────────────────────────
export { SmallHeaderBag } from './runtime/headers.ts'
export { parseQuery, stringifyQuery, isForbiddenKey, type QueryRecord } from './runtime/query.ts'
export { parseCookies, serializeCookie, type CookieRecord } from './runtime/cookies.ts'
export {
  MutableReply, isReply, jsonReply, textReply, htmlReply, bytesReply,
  emptyReply, redirectReply, fileReply, streamReply,
} from './runtime/reply.ts'
export {
  finalize, encodeBody, attachSerializer, attachNegotiated, payloadOf, replacePayload, NO_PAYLOAD,
} from './runtime/response-engine.ts'
export {
  createSseChannel, isSseChannel, frameOf, SSE_CHANNEL, DEFAULT_KEEP_ALIVE, DEFAULT_MAX_BUFFERED,
  type SseChannelWithReply,
} from './runtime/sse.ts'
export {
  makeNegotiator, makeNegotiationStep, selectOffer, offersOf, notAcceptable,
  NEGOTIATION_CACHE_LIMIT, type Offer, type NegotiationCarrier,
} from './runtime/negotiation.ts'
export { ErrorEngine, classify, type ErrorMapper, type ErrorContextInfo } from './runtime/error-engine.ts'
export { ConsoleLogger, NoopLogger } from './runtime/logger.ts'
export { prepareForWire, stripBodyIfNeeded } from './runtime/egress.ts'
export {
  PlainContext, ReplyStage, UNSET, buildHeaders, slotEmpty, CONTEXT_MEMBERS,
  forwardedClient, forwardedProtocol, requestUrl,
  type ContextEnv, type StageTarget,
} from './runtime/context.ts'
export {
  makeIntake, withParseHooks, mediaTypeOf, jsonParser, textParser, rawParser, formParser,
  DEFAULT_PARSERS, BODY_DEFAULTS, type BodyOptions, type BodyParser,
} from './runtime/body.ts'
export { Deadline, EXPIRED, budgetFor, abandoned, timeoutError } from './runtime/deadline.ts'
export { HealthRegistry, type HealthRegistryOptions } from './runtime/health.ts'

// ── public API ──────────────────────────────────────────────────────────────
export { slot, slotCount, declaredSlots, allocateCell, __resetSlots } from './api/slot.ts'
export {
  ZenApp, Collection, InjectedResponse, createApp, definePlugin, ALL_METHODS,
  type ZenOptions, type CollectionOptions, type SerializationOptions, type ConfigOf,
} from './api/zen.ts'
export { trackDisposal, type DisposalCarrier } from './primitives/disposal.ts'

// ── configuration (§16) ─────────────────────────────────────────────────────
export { defineConfig } from './api/define-config.ts'
export {
  resolveConfig, foldEnv, secretEnvKeys, describeConstraint,
  type ResolveConfigInput, type ResolvedConfigResult,
} from './registry/config-store.ts'
export { explainRoute, explainConfig, steps, type ExplainedStep } from './api/explain.ts'
export { healthPlugin, type HealthPluginOptions } from './api/health-plugin.ts'

// ── dependency injection (§15) ──────────────────────────────────────────────
export { ZenContainer, token } from './di/container.ts'
export type {
  Container, Token, Lifetime, ProviderSpec, ProviderRecord, DiDiagnostic, ScopeCarrier,
} from './contracts/container.ts'

// ── plugins (§10) ───────────────────────────────────────────────────────────
export { resolvePlugins, satisfies, type PendingPlugin } from './registry/plugin-registry.ts'
export type { Plugin, PluginResult, Registrar, OptionsOf, ProvidesOf } from './contracts/plugin.ts'
