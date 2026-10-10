/**
 * Zen against `node:http`, Fastify, Hono and Express — rfcs/0001 §1.4, §18.2,
 * Annex C workloads 1–6.
 *
 *     npm ci --prefix benchmarks/competitors        # once: the frameworks compared against
 *     npx tsc -b                                    # Zen is read from the workspace's dist/
 *     node benchmarks/competitors/run.ts [options]
 *
 * Every other benchmark in this repository compares Zen with itself — a
 * feature against its absence — which is the right instrument for a zero-cost
 * claim and cannot test the thesis. §1.4 states the thesis's falsifiable
 * prediction: Zen's per-request work should be within noise of a hand-written
 * `http.createServer` handler doing the same job, and "if that is not true in
 * benchmarks, the thesis has failed and we should say so." This is where it is
 * said, either way.
 *
 * Method, and what it is not:
 *
 *   - **Real sockets, a separate load generator.** Each server is its own Node
 *     process, booted per workload so nothing one workload registers is on
 *     another's path. autocannon drives it from this process, with worker
 *     threads so the client is not the bottleneck.
 *   - **Correctness first.** Before anything is timed, each server answers the
 *     workload's request once and must produce the expected status and body —
 *     a server that answers something else is not doing the same job, and its
 *     number would be meaningless. During a run, any error, timeout or non-2xx
 *     response fails the cell rather than being averaged in.
 *   - **Five runs per cell** after a warm-up; the median request rate, its
 *     spread (max − min, as a fraction of the median), median p50/p99 latency,
 *     the server's RSS after the runs, and the time the process took to start
 *     accepting.
 *   - **One machine.** Annex C asks for a dedicated host and a load generator on
 *     another; this is one laptop or one CI runner, with client and server
 *     sharing cores. Ratios between servers measured in the same run are the
 *     claim; absolute numbers are one machine's.
 *   - **Not a CI gate.** Shared runners are too noisy for it (§18.6). CI runs
 *     `--smoke`: every server, every workload, the correctness check and a
 *     one-second run with no errors — proving the harness works, not timing it.
 *
 * Options: `--only zen,fastify` · `--workloads 1,4` · `--runs 5` · `--duration 10`
 * · `--warmup 3` · `--connections 128` · `--workers 4` · `--label before` ·
 * `--smoke`. Results are written to `benchmarks/results/local/competitors/`,
 * which is gitignored; a curated summary is what gets committed.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, totalmem, platform, release, arch } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deepStrictEqual } from 'node:assert'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

if (!existsSync(join(HERE, 'node_modules', 'autocannon'))) {
  console.error('\n  The frameworks this compares against are not installed:\n\n    npm ci --prefix benchmarks/competitors\n')
  process.exit(1)
}
if (!existsSync(join(ROOT, 'packages', 'zen', 'dist', 'index.js'))) {
  console.error('\n  Zen is read from the workspace build, and there is none:\n\n    npx tsc -b\n')
  process.exit(1)
}

const { default: autocannon } = await import('autocannon') as { default: (opts: Record<string, unknown>) => Promise<AutocannonResult> }
const shared = await import('./shared.ts')

interface AutocannonResult {
  requests: { average: number }
  latency: { p50: number; p99: number }
  errors: number
  timeouts: number
  non2xx: number
}

// ── options ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const flag = (name: string): boolean => argv.includes(`--${name}`)
const option = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (argv[i + 1] ?? fallback)
}

const SMOKE = flag('smoke')
const SERVERS = ['node-http', 'zen', 'fastify', 'hono', 'express'] as const
type ServerName = (typeof SERVERS)[number]
const only = option('only', SERVERS.join(',')).split(',').map((s) => s.trim()) as ServerName[]
for (const name of only) {
  if (!SERVERS.includes(name)) {
    console.error(`unknown server "${name}" — one of ${SERVERS.join(', ')}`)
    process.exit(2)
  }
}
const workloadIds = option('workloads', '1,2,3,4,5,6').split(',').map(Number)
const RUNS = SMOKE ? 1 : Number(option('runs', '5'))
const DURATION = SMOKE ? 1 : Number(option('duration', '10'))
const WARMUP = SMOKE ? 0 : Number(option('warmup', '3'))
const CONNECTIONS = SMOKE ? 8 : Number(option('connections', '128'))
const WORKERS = SMOKE ? 1 : Number(option('workers', '4'))
const LABEL = option('label', SMOKE ? 'smoke' : 'run')

// ── workloads: the request, and the answer every server must give ────────────

interface Workload {
  readonly id: number
  readonly title: string
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly headers: Record<string, string>
  readonly body?: string
  readonly expect: unknown
}

const rows = await shared.findUsers(10)
const WORKLOADS: readonly Workload[] = [
  { id: 1, title: 'static JSON, no schema', method: 'GET', path: '/w1', headers: {}, expect: { hello: 'world' } },
  { id: 2, title: 'JSON with a response schema', method: 'GET', path: '/w2', headers: {}, expect: shared.publicUser(shared.USER_ROW) },
  {
    id: 3, title: 'a route with 5 path params', method: 'GET', path: '/w3/1/two/3/four/5', headers: {},
    expect: { a: '1', b: 'two', c: '3', d: 'four', e: '5' },
  },
  {
    id: 4, title: 'POST + body validation (Zod), ~1 KB', method: 'POST', path: '/w4',
    headers: { 'content-type': 'application/json' }, body: shared.ORDER_BODY,
    expect: shared.priceOrder(JSON.parse(shared.ORDER_BODY)),
  },
  { id: 5, title: '10 middleware', method: 'GET', path: '/w5', headers: {}, expect: { ok: true } },
  {
    id: 6, title: 'realistic: JWT, rate limit, Zod, 5 ms DB, ~2 kB out', method: 'POST', path: '/w6',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${shared.JWT}` }, body: shared.SEARCH_BODY,
    expect: { users: rows.map(shared.publicUser), count: rows.length },
  },
]

// ── one server process ───────────────────────────────────────────────────────

interface Booted {
  readonly child: ChildProcess
  readonly port: number
  readonly bootMs: number
}

function boot(server: ServerName, workload: number): Promise<Booted> {
  const child = spawn(process.execPath, [join(HERE, 'servers', `${server}.ts`), String(workload)], {
    cwd: HERE,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production' },
  })
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${server} did not start within 20 s\n${err}`)) }, 20_000)
    child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      const line = out.split('\n').find((l) => l.startsWith('READY '))
      if (line === undefined) return
      clearTimeout(timer)
      const { port, bootMs } = JSON.parse(line.slice(6)) as { port: number; bootMs: number }
      resolve({ child, port, bootMs })
    })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`${server} exited (${code}) before it was ready\n${err}`)) })
  })
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.removeAllListeners('exit')
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 3_000)
  await exited
  clearTimeout(timer)
}

function rssKb(pid: number | undefined): number | null {
  if (pid === undefined || platform() === 'win32') return null
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim())
  } catch {
    return null
  }
}

async function verify(port: number, workload: Workload): Promise<string | null> {
  const res = await fetch(`http://127.0.0.1:${port}${workload.path}`, {
    method: workload.method,
    headers: workload.headers,
    ...(workload.body === undefined ? {} : { body: workload.body }),
  })
  const text = await res.text()
  if (res.status !== 200) return `answered ${res.status}: ${text.slice(0, 200)}`
  if (!(res.headers.get('content-type') ?? '').startsWith('application/json')) return `content-type ${res.headers.get('content-type')}`
  try {
    deepStrictEqual(JSON.parse(text), workload.expect)
  } catch {
    return `answered a different body: ${text.slice(0, 300)}`
  }
  return null
}

function load(port: number, workload: Workload, seconds: number): Promise<AutocannonResult> {
  return autocannon({
    url: `http://127.0.0.1:${port}${workload.path}`,
    method: workload.method,
    headers: workload.headers,
    ...(workload.body === undefined ? {} : { body: workload.body }),
    connections: CONNECTIONS,
    duration: seconds,
    pipelining: 1,
    ...(WORKERS > 1 ? { workers: WORKERS } : {}),
  })
}

// ── run ──────────────────────────────────────────────────────────────────────

interface Cell {
  readonly server: ServerName
  readonly workload: number
  readonly ok: boolean
  readonly problem: string | null
  readonly rps: number[]
  readonly p50: number[]
  readonly p99: number[]
  readonly bootMs: number | null
  readonly rssKb: number | null
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] as number : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}
const spread = (values: readonly number[]): number => {
  const m = median(values)
  return m === 0 ? 0 : (Math.max(...values) - Math.min(...values)) / m
}

const version = (pkg: string): string => {
  try {
    return (JSON.parse(readFileSync(join(HERE, 'node_modules', pkg, 'package.json'), 'utf8')) as { version: string }).version
  } catch {
    return 'not installed'
  }
}
const git = (args: string[]): string => {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim() } catch { return 'unknown' }
}

const environment = {
  label: LABEL,
  date: new Date().toISOString(),
  node: process.version,
  os: `${platform()} ${release()} ${arch()}`,
  cpu: cpus()[0]?.model ?? 'unknown',
  cores: cpus().length,
  memoryGb: Math.round(totalmem() / 2 ** 30),
  zen: (JSON.parse(readFileSync(join(ROOT, 'packages', 'zen', 'package.json'), 'utf8')) as { version: string }).version,
  commit: `${git(['rev-parse', '--short', 'HEAD'])}${git(['status', '--porcelain', '--untracked-files=no']) === '' ? '' : ' (with uncommitted changes)'}`,
  fastify: version('fastify'),
  hono: version('hono'),
  honoNodeServer: version('@hono/node-server'),
  express: version('express'),
  zod: version('zod'),
  autocannon: version('autocannon'),
  method: { runs: RUNS, durationS: DURATION, warmupS: WARMUP, connections: CONNECTIONS, workers: WORKERS, pipelining: 1 },
}

console.log(`\n  Zen against node:http, Fastify, Hono and Express — ${SMOKE ? 'smoke pass (correctness, no timing)' : 'Annex C workloads'}`)
console.log(`  ${environment.node} · ${environment.os} · ${environment.cpu} × ${environment.cores} · zen ${environment.zen} @ ${environment.commit}`)
if (!SMOKE) console.log(`  ${RUNS} runs × ${DURATION} s after a ${WARMUP} s warm-up · ${CONNECTIONS} connections · ${WORKERS} load-generator threads\n`)
else console.log('')

const cells: Cell[] = []
let failures = 0

for (const workload of WORKLOADS.filter((w) => workloadIds.includes(w.id))) {
  console.log(`  ${workload.id}. ${workload.title}`)
  for (const server of only) {
    let booted: Booted | null = null
    const cell: { -readonly [K in keyof Cell]: Cell[K] } = {
      server, workload: workload.id, ok: false, problem: null, rps: [], p50: [], p99: [], bootMs: null, rssKb: null,
    }
    try {
      booted = await boot(server, workload.id)
      cell.bootMs = booted.bootMs
      const wrong = await verify(booted.port, workload)
      if (wrong !== null) throw new Error(wrong)
      if (WARMUP > 0) await load(booted.port, workload, WARMUP)
      for (let run = 0; run < RUNS; run++) {
        const result = await load(booted.port, workload, DURATION)
        const bad = result.errors + result.timeouts + result.non2xx
        if (bad > 0) throw new Error(`run ${run + 1}: ${result.errors} errors, ${result.timeouts} timeouts, ${result.non2xx} non-2xx`)
        cell.rps.push(result.requests.average)
        cell.p50.push(result.latency.p50)
        cell.p99.push(result.latency.p99)
      }
      cell.rssKb = rssKb(booted.child.pid)
      cell.ok = true
    } catch (error) {
      cell.problem = (error as Error).message.split('\n')[0] ?? String(error)
      failures++
    } finally {
      if (booted !== null) await stop(booted.child)
    }
    cells.push(cell)
    const name = server.padEnd(10)
    if (!cell.ok) console.log(`     ✖ ${name} ${cell.problem}`)
    else if (SMOKE) console.log(`     ✔ ${name} answered correctly; ${Math.round(median(cell.rps))} req/s for a second with no errors`)
    else {
      console.log(
        `     ${name} ${Math.round(median(cell.rps)).toLocaleString('en-US').padStart(8)} req/s` +
        `  ±${(spread(cell.rps) * 100).toFixed(1).padStart(4)}%` +
        `   p50 ${median(cell.p50).toFixed(2).padStart(6)} ms   p99 ${median(cell.p99).toFixed(2).padStart(6)} ms` +
        `   rss ${cell.rssKb === null ? '   ?' : `${Math.round(cell.rssKb / 1024)} MB`.padStart(6)}   boot ${String(cell.bootMs).padStart(6)} ms`,
      )
    }
  }
  console.log('')
}

// ── summary: each server against the hand-written baseline, and against Zen ──

if (!SMOKE) {
  const rate = (server: ServerName, workload: number): number | null => {
    const cell = cells.find((c) => c.server === server && c.workload === workload)
    return cell?.ok === true ? median(cell.rps) : null
  }
  console.log('  Median request rate as a fraction of node:http (the hand-written baseline, §1.4)\n')
  console.log(`     ${'workload'.padEnd(40)}${only.filter((s) => s !== 'node-http').map((s) => s.padStart(10)).join('')}`)
  for (const workload of WORKLOADS.filter((w) => workloadIds.includes(w.id))) {
    const base = rate('node-http', workload.id)
    const cols = only.filter((s) => s !== 'node-http').map((s) => {
      const r = rate(s, workload.id)
      return (base === null || r === null ? '—' : `${(r / base).toFixed(2)}×`).padStart(10)
    })
    console.log(`     ${`${workload.id}. ${workload.title}`.slice(0, 39).padEnd(40)}${cols.join('')}`)
  }
  console.log('')
}

const outDir = join(ROOT, 'benchmarks', 'results', 'local', 'competitors')
mkdirSync(outDir, { recursive: true })
const file = join(outDir, `${LABEL}-${environment.date.replace(/[:.]/g, '-')}.json`)
writeFileSync(file, `${JSON.stringify({ environment, cells }, null, 2)}\n`)
console.log(`  results: ${file.slice(ROOT.length + 1)}`)

if (failures > 0) {
  console.log(`\n  ${failures} cell${failures === 1 ? '' : 's'} failed — a server that answered wrongly or with errors produced no number\n`)
  process.exitCode = 1
} else {
  console.log(SMOKE ? '\n  every server answered every workload correctly\n' : '')
}
