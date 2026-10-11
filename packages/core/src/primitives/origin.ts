/**
 * Where a registration was written — rfcs/0001 §5.1, §12.7.
 *
 * §5.1 calls `origin` "the single highest-leverage DX decision in the
 * registry", and until `0.2.0-alpha` every record held `undefined`: a duplicate
 * route named its path and nothing else, and a developer with forty route files
 * went looking. This is the capture every registration surface calls.
 *
 * Boot-only. Nothing here runs on the request path, and nothing captured here
 * enters a generated unit, so every byte-identity gate holds with origins on.
 *
 * Stratum 0: the shape is declared here rather than in `contracts/`, because a
 * primitive may not import upward — the same arrangement as `EnvEntry` in
 * `dotenv.ts`. `contracts/route.ts` re-exports it.
 */
export interface SourceOrigin {
  /**
   * The file, relative to the application's root when it lies under it
   * (`src/features/users/routes.ts`), absolute otherwise. Always `/`-separated
   * when relative, so an origin printed on Windows and on Linux reads the same.
   */
  readonly file: string
  readonly line: number
  readonly column: number
}

/**
 * Which frames belong to the framework, and so are never an origin.
 *
 * This repository's packages (`packages/<name>/{src,dist}`) and the published
 * ones wherever they are installed (`node_modules/@erenthedeveloper0/zen*`).
 * A test file under `packages/core/test/` is *not* framework: there, the test
 * is the application.
 */
const FRAMEWORK_DIRS = ['core', 'router', 'adapter-node', 'openapi', 'middleware', 'zen']

/** The one file whose frames bound a plugin's `setup` — see {@link captureOrigin}. */
function isBootFile(file: string): boolean {
  const f = file.replace(/\\/g, '/')
  return f.endsWith('/core/src/api/zen.ts') || f.endsWith('/core/dist/api/zen.js') ||
    f.endsWith('/zen-core/dist/api/zen.js')
}

export function isFrameworkFile(file: string): boolean {
  const f = file.replace(/\\/g, '/')
  if (f.startsWith('node:') || f.startsWith('internal/')) return true
  if (f.includes('/node_modules/@erenthedeveloper0/zen')) return true
  for (const dir of FRAMEWORK_DIRS) {
    if (f.includes(`/packages/${dir}/src/`) || f.includes(`/packages/${dir}/dist/`)) return true
  }
  return false
}

/** A V8 call site — only what is read here. */
interface CallSite {
  getFileName(): string | null | undefined
  getLineNumber(): number | null
  getColumnNumber(): number | null
}

interface V8ErrorConstructor {
  stackTraceLimit?: number | undefined
  prepareStackTrace?: ((error: Error, stack: CallSite[]) => unknown) | undefined
  captureStackTrace?: ((target: object, constructorOpt?: Function) => void) | undefined
}

interface Frame {
  readonly file: string
  readonly line: number
  readonly column: number
}

/**
 * How far down the stack to look: six frames first, and thirty-two when those
 * six were all the framework's. Every registration surface reaches the
 * application within four — `#here`, the surface's own one or two frames, and
 * the caller; a plugin's `Registrar` the same, with the plugin's `setup` the
 * fourth — so six holds them all with two to spare. The cost of a capture is
 * the stack walk, and grows with its depth: measured in `benchmarks/boot`, a
 * registration costs ~5 µs with six frames and ~6.6 µs with eight, against
 * ~0.3 µs with no capture at all.
 */
const SHALLOW = 6
const DEEP = 32

/**
 * `call` — the first frame outside the framework: where `app.get(…)` was
 * written.
 *
 * `setup` — a registration made through a plugin's `Registrar`. The first frame
 * outside the framework *inside that plugin's `setup`*, or `undefined` when
 * there is none: a first-party plugin is framework code all the way down, and
 * the first frame outside the framework would then be whoever called
 * `ready()`, which is not where anything was registered. The caller falls back
 * to the plugin's own `app.use()` site.
 */
export type CaptureMode = 'call' | 'setup'

/**
 * Where the caller of a registration surface was written. Never throws: a
 * runtime with no stack API, a stack that cannot be read, or a frame with no
 * file all come back as `undefined`, and a registration without an origin is
 * still a registration.
 */
export function captureOrigin(mode: CaptureMode = 'call'): SourceOrigin | undefined {
  try {
    const frames = framesOf(captureOrigin, SHALLOW)
    if (frames === null) return undefined
    const found = pick(frames, mode)
    if (found !== undefined || frames.length < SHALLOW) return found
    const deeper = framesOf(captureOrigin, DEEP)
    return deeper === null ? undefined : pick(deeper, mode)
  } catch {
    return undefined
  }
}

/**
 * A frame as `pick` reads it: what its file is, and — for a V8 call site — the
 * site itself, asked for its line and column only if it is the one chosen.
 * A capture reads eight frames and returns one, so the other seven are never
 * converted or placed.
 */
interface Candidate {
  readonly facts: FileFacts
  readonly site: CallSite | null
  readonly line: number
  readonly column: number
}

/** What a frame's file is — its path, and whether it is the framework's — worked out once per file. */
interface FileFacts {
  readonly path: string
  readonly framework: boolean
  readonly boot: boolean
}

/**
 * Keyed by the name the runtime reports. An application registers from a few
 * dozen files and the framework's own are a few more, so this stays small;
 * the bound is for a process that generates modules, where it is cleared
 * rather than grown.
 */
const FACTS = new Map<string, FileFacts>()

function factsOf(name: string): FileFacts {
  let facts = FACTS.get(name)
  if (facts === undefined) {
    const path = filePath(name)
    facts = { path, framework: isFrameworkFile(path), boot: isBootFile(path) }
    if (FACTS.size >= 1024) FACTS.clear()
    FACTS.set(name, facts)
  }
  return facts
}

function place(frame: Candidate): SourceOrigin | undefined {
  if (frame.site === null) return { file: frame.facts.path, line: frame.line, column: frame.column }
  const line = frame.site.getLineNumber()
  const column = frame.site.getColumnNumber()
  return line === null || column === null ? undefined : { file: frame.facts.path, line, column }
}

function pick(frames: readonly Candidate[], mode: CaptureMode): SourceOrigin | undefined {
  if (mode === 'call') {
    for (const frame of frames) {
      if (frame.facts.framework) continue
      const placed = place(frame)
      if (placed !== undefined) return placed
    }
    return undefined
  }
  // Skip the registrar's own frames, then search until the boot frames begin.
  let i = 0
  while (i < frames.length && (frames[i] as Candidate).facts.boot) i++
  for (; i < frames.length; i++) {
    const frame = frames[i] as Candidate
    if (frame.facts.boot) return undefined
    if (frame.facts.framework) continue
    const placed = place(frame)
    if (placed !== undefined) return placed
  }
  return undefined
}

/**
 * The stack above `below`, as frames — V8's structured API where there is one
 * (Node, Deno, workerd, Bun), the text of `new Error().stack` elsewhere.
 */
function framesOf(below: Function, depth: number): Candidate[] | null {
  const E = Error as unknown as V8ErrorConstructor
  if (typeof E.captureStackTrace === 'function') {
    const prepare = E.prepareStackTrace
    const limit = E.stackTraceLimit
    let sites: unknown
    try {
      E.prepareStackTrace = (_error, stack) => stack
      E.stackTraceLimit = depth
      const holder: { stack?: unknown } = {}
      E.captureStackTrace(holder, below)
      // The `stack` accessor runs `prepareStackTrace` lazily — read it while
      // ours is still the one installed.
      sites = holder.stack
    } finally {
      E.prepareStackTrace = prepare
      E.stackTraceLimit = limit
    }
    if (Array.isArray(sites)) return candidatesFromSites(sites as CallSite[])
    if (typeof sites === 'string') return candidatesFromText(sites, 1, depth)
    return null
  }
  // Two frames to drop: this function and `captureOrigin`.
  return candidatesFromText(new Error().stack, 3, depth)
}

function candidatesFromSites(sites: readonly CallSite[]): Candidate[] {
  const out: Candidate[] = []
  for (const site of sites) {
    const name = site.getFileName()
    if (typeof name !== 'string' || name === '') continue
    out.push({ facts: factsOf(name), site, line: 0, column: 0 })
  }
  return out
}

function candidatesFromText(stack: string | undefined, skip: number, depth: number): Candidate[] {
  return framesFromText(stack, skip, depth).map((frame) => ({ facts: factsOf(frame.file), site: null, line: frame.line, column: frame.column }))
}

/**
 * `at fn (file:12:5)`, `at file:12:5`, `fn@file:12:5` — the three spellings a
 * stack line comes in. Read from the end with `lastIndexOf` rather than a
 * regex: a frame's text is the application's file path, and §19.3's rule is
 * that nothing in core backtracks over input it did not write.
 */
function framesFromText(stack: string | undefined, skip: number, depth = DEEP): Frame[] {
  if (typeof stack !== 'string') return []
  const out: Frame[] = []
  const lines = stack.split('\n')
  for (let i = skip; i < lines.length && out.length < depth; i++) {
    let text = (lines[i] as string).trim()
    // A frame, not a line of a multi-line message: V8 writes `at …`, and
    // JavaScriptCore and SpiderMonkey `name@file:line:column`.
    if (text.startsWith('at ')) text = text.slice(3)
    else if (!text.includes('@')) continue
    if (text.endsWith(')')) {
      const open = text.lastIndexOf('(')
      if (open === -1) continue
      text = text.slice(open + 1, -1)
    }
    const at = text.lastIndexOf('@')
    if (at !== -1) text = text.slice(at + 1)
    const colon2 = text.lastIndexOf(':')
    const colon1 = colon2 <= 0 ? -1 : text.lastIndexOf(':', colon2 - 1)
    if (colon1 <= 0) continue
    const line = Number(text.slice(colon1 + 1, colon2))
    const column = Number(text.slice(colon2 + 1))
    if (!Number.isInteger(line) || !Number.isInteger(column)) continue
    out.push({ file: filePath(text.slice(0, colon1)), line, column })
  }
  return out
}

/**
 * Where an error was thrown: the first frame of its stack that is not the
 * runtime's own. For a plugin's `setup` that threw, the line in the plugin —
 * §10.6's "the plugin's file", next to the `use()` site that registered it.
 */
export function errorOrigin(error: unknown): SourceOrigin | undefined {
  if (!(error instanceof Error)) return undefined
  try {
    for (const frame of framesFromText(error.stack, 1)) {
      if (!frame.file.startsWith('node:') && !frame.file.startsWith('internal/')) return frame
    }
  } catch {
    // An unreadable stack is no origin, not a second failure.
  }
  return undefined
}

/**
 * Where an error was raised *in the application* — the first frame of its
 * stack outside the framework and the runtime. A validation error is thrown
 * inside the framework, on the application's behalf; this skips to the code
 * that caused it, which is the line a development error page should show (§12.6).
 */
export function applicationFrame(error: unknown): SourceOrigin | undefined {
  if (!(error instanceof Error)) return undefined
  try {
    for (const frame of framesFromText(error.stack, 1)) {
      if (!isFrameworkFile(frame.file)) return frame
    }
  } catch {
    // As `errorOrigin`: an unreadable stack is no frame.
  }
  return undefined
}

/**
 * An ES module's frames name a `file:` URL; everything that prints an origin
 * wants a path. Converted by hand because core has no `node:url` (§3.3 B2):
 * percent-decoding, and on Windows the drive form `file:///C:/x` → `C:\x`.
 */
export function filePath(name: string): string {
  if (!name.startsWith('file://')) return name
  let path = name.slice('file://'.length)
  try {
    path = decodeURIComponent(path)
  } catch {
    // A malformed escape is kept as written rather than losing the frame.
  }
  if (path.length >= 3 && path[0] === '/' && path[2] === ':' && isLetter(path[1] as string)) {
    return path.slice(1).replace(/\//g, '\\')
  }
  return path
}

function isLetter(c: string): boolean {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
}

/**
 * `origin`, with its file relative to `root` when it lies under it — how every
 * origin is stored once an application knows its root, so diagnostics, the
 * graph and `explainRoute` print `src/app.ts:12:3` rather than a home directory.
 */
export function relativeOrigin(origin: SourceOrigin | undefined, root: string | undefined): SourceOrigin | undefined {
  if (origin === undefined || root === undefined || root === '') return origin
  const file = relativeTo(origin.file, root)
  return file === origin.file ? origin : { file, line: origin.line, column: origin.column }
}

function relativeTo(file: string, root: string): string {
  const trimmed = root.endsWith('/') || root.endsWith('\\') ? root.slice(0, -1) : root
  if (file.length <= trimmed.length + 1) return file
  const head = file.slice(0, trimmed.length)
  const sep = file[trimmed.length]
  if (sep !== '/' && sep !== '\\') return file
  // A Windows drive letter is case-insensitive; nothing else is compared loosely.
  const same = head === trimmed ||
    (head.length >= 2 && head[1] === ':' && head.toLowerCase() === trimmed.toLowerCase())
  if (!same) return file
  return file.slice(trimmed.length + 1).replace(/\\/g, '/')
}

/** `src/app.ts:12:3`. */
export function formatOrigin(origin: SourceOrigin): string {
  return `${origin.file}:${origin.line}:${origin.column}`
}
