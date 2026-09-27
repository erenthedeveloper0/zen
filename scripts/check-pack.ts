/**
 * What actually ships — npm-registry.md §2 and §8, as a check instead of a
 * checklist.
 *
 * `node scripts/check-pack.ts [--typescript 5.0]`
 *
 * The workspace resolves every package through symlinks and never packs, so
 * nothing else in the repository sees a tarball. Every packaging defect this
 * project has had — build caches with absolute paths in them, source maps
 * pointing at sources that were not shipped, no README, no LICENSE — was true
 * for months and invisible to every test, because no test installs anything.
 *
 * Two halves:
 *
 *   1. **The file list.** `npm pack --dry-run` for each package, and a failure
 *      for anything that should not ship or should and does not.
 *   2. **An install from the tarballs, outside the workspace.** A scratch
 *      project installs all six `.tgz` files, then starts a server from them
 *      and makes a request. That catches the failure a monorepo hides
 *      completely: an `exports` map or an internal pin that resolves through a
 *      workspace symlink and not from a real `node_modules`.
 *
 * `--typescript <version>` additionally type-checks a consumer against the
 * published declarations with that TypeScript — the floor the manifests declare
 * as a peer (`>=5.0`) is a claim, and this is how it is checked. It needs the
 * network to install TypeScript.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ORDER = ['core', 'router', 'adapter-node', 'openapi', 'middleware', 'zen'] as const
const root = resolve(import.meta.dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const tsFlag = process.argv.indexOf('--typescript')
const tsVersion = tsFlag === -1 ? null : process.argv[tsFlag + 1] ?? null

const problems: string[] = []
const fail = (message: string): void => { problems.push(message) }
const run = (args: string[], cwd = root): string =>
  execFileSync(npm, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })

type PackResult = Array<{ name: string; version: string; size: number; unpackedSize: number; files: Array<{ path: string; size: number }> }>

const rootLicense = readFileSync(join(root, 'LICENSE'), 'utf8')

console.log('\n  What ships — npm pack --dry-run\n')

for (const dir of ORDER) {
  const packageDir = join(root, 'packages', dir)
  const [result] = JSON.parse(run(['pack', '--dry-run', '--json', '--workspace', `packages/${dir}`])) as PackResult
  if (result === undefined) { fail(`${dir}: npm pack produced nothing`); continue }
  const files = new Set(result.files.map((f) => f.path))

  console.log(`  ${result.name}@${result.version}`.padEnd(48) +
    `${(result.size / 1024).toFixed(1).padStart(7)} kB packed  ${(result.unpackedSize / 1024).toFixed(1).padStart(7)} kB unpacked  ${String(files.size).padStart(4)} files`)

  for (const required of ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts']) {
    if (!files.has(required)) fail(`${result.name}: ${required} is missing from the tarball`)
  }
  for (const path of files) {
    if (path.endsWith('.tsbuildinfo')) fail(`${result.name}: ships a build cache (${path}) — it holds absolute paths from the build machine`)
    if (/(^|\/)test\//.test(path) || path.endsWith('.test.ts')) fail(`${result.name}: ships a test file (${path})`)
    if (path.endsWith('.map')) {
      // A map is only useful if the file it points at shipped with it.
      const map = JSON.parse(readFileSync(join(packageDir, path), 'utf8')) as { sources?: string[] }
      const base = path.slice(0, path.lastIndexOf('/') + 1)
      for (const source of map.sources ?? []) {
        const target = normalise(base + source)
        if (!files.has(target)) fail(`${result.name}: ${path} points at ${target}, which is not in the tarball`)
      }
    }
  }
  if (existsSync(join(packageDir, 'LICENSE')) && readFileSync(join(packageDir, 'LICENSE'), 'utf8') !== rootLicense) {
    fail(`${result.name}: LICENSE differs from the repository's LICENSE`)
  }
}

// ── the install ─────────────────────────────────────────────────────────────

console.log('\n  Installing the tarballs outside the workspace\n')

const scratch = mkdtempSync(join(tmpdir(), 'zen-pack-'))
try {
  const tarballs = join(scratch, 'tarballs')
  mkdirSync(tarballs)
  const specs: Record<string, string> = {}
  for (const dir of ORDER) {
    const [packed] = JSON.parse(run(['pack', '--json', '--workspace', `packages/${dir}`, '--pack-destination', tarballs])) as PackResult
    if (packed !== undefined) {
      specs[packed.name] = `file:${join(tarballs, (packed as unknown as { filename: string }).filename)}`
    }
  }

  const project = join(scratch, 'app')
  mkdirSync(project)
  // `overrides` too: the tarballs pin each other by exact version, and without
  // it npm would look for those versions on the registry instead of here.
  writeFileSync(join(project, 'package.json'), JSON.stringify({
    name: 'zen-pack-check', private: true, type: 'module',
    dependencies: specs, overrides: specs,
  }, null, 2))
  run(['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], project)

  writeFileSync(join(project, 'check.mjs'), `
    import { zen, NoopLogger } from '@visionpilot/zen'
    import { openapiPlugin } from '@visionpilot/zen-openapi'
    import * as core from '@visionpilot/zen-core'
    import * as contracts from '@visionpilot/zen-core/contracts'
    import pkg from '@visionpilot/zen/package.json' with { type: 'json' }

    const app = zen({ env: {}, logger: new NoopLogger(), lifecycle: false })
    app.use(openapiPlugin, { title: 'pack check', version: pkg.version })
    app.get('/hello/:name', (ctx) => ({ hello: ctx.params.name }))
    const handle = await app.listen({ port: 0 })
    const res = await fetch(handle.url + '/hello/world')
    const body = await res.json()
    const doc = await (await fetch(handle.url + '/openapi.json')).json()
    await app.close()
    if (body.hello !== 'world') throw new Error('unexpected body ' + JSON.stringify(body))
    if (!doc.paths['/hello/{name}']) throw new Error('the document is missing the route')
    console.log('    ✔ served a request and an OpenAPI document from the installed tarballs')
    console.log('      core exports: ' + Object.keys(core).length + ', contracts entry resolved: ' + (typeof contracts === 'object'))
  `)
  process.stdout.write(execFileSync(process.execPath, ['check.mjs'], { cwd: project, encoding: 'utf8' }))

  if (tsVersion !== null) {
    console.log(`\n  Type-checking a consumer with TypeScript ${tsVersion}\n`)
    // `@types/node@ts<version>` is DefinitelyTyped's newest release that still
    // supports that TypeScript; the plain latest does not go back to 5.0, and
    // its errors would be reported as ours.
    run(['install', '--no-audit', '--no-fund', '--loglevel=error', `typescript@${tsVersion}`, `@types/node@ts${tsVersion}`], project)
    writeFileSync(join(project, 'consumer.ts'), `
      import { zen, defineConfig } from '@visionpilot/zen'
      import { cors } from '@visionpilot/zen-middleware'
      import { openapiPlugin } from '@visionpilot/zen-openapi'
      export const config = defineConfig({ server: { port: 3000 } })
      const app = zen({ lifecycle: false })
      app.use(cors({ origin: ['https://example.com'] }))
      app.use(openapiPlugin, { title: 't', version: '1' })
      app.get('/users/:id<int>', (ctx) => ({ id: ctx.params.id + 1 }))
    `)
    writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', noEmit: true, skipLibCheck: false },
      files: ['consumer.ts'],
    }))
    try {
      execFileSync(process.execPath, [join(project, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', project], { encoding: 'utf8' })
      console.log(`    ✔ the published declarations type-check under TypeScript ${tsVersion}`)
    } catch (error) {
      fail(`TypeScript ${tsVersion} rejects the published declarations:\n${(error as { stdout?: string }).stdout ?? String(error)}`)
    }
  }
} catch (error) {
  fail(`installing from the tarballs failed: ${(error as Error).message}\n${(error as { stdout?: string; stderr?: string }).stderr ?? ''}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (problems.length > 0) {
  console.error(`\n  ${problems.length} packaging problem${problems.length === 1 ? '' : 's'}:\n`)
  for (const problem of problems) console.error(`    ✖ ${problem}`)
  console.error('')
  process.exit(1)
}
console.log('\n  ✔ every package is clean, and installs and runs from its tarball\n')

function normalise(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
  }
  return out.join('/')
}
