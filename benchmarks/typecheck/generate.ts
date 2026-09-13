import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Fixture generator for the M2 type-performance gate — rfcs/0001 §25, §28.2.
 *
 * The risk being measured: plugin type accumulation through the `.use()` builder
 * chain is exactly the pattern that has made other type-heavy frameworks slow to
 * type-check in large codebases. Editor responsiveness degrades before `tsc`
 * wall time does, and by the time users complain the API is frozen.
 *
 * So we generate a realistically-shaped app — routes split across files, each
 * exercising path-param inference, body/query schemas, and response contracts —
 * and measure. §28.2 promises this is tracked per commit; this is that harness.
 */
export interface FixtureSpec {
  readonly routes: number
  readonly plugins: number
  readonly files: number
  readonly seal: boolean
}

export function generateFixture(root: string, spec: FixtureSpec): string {
  const dir = join(root, `r${spec.routes}-p${spec.plugins}-${spec.seal ? 'sealed' : 'open'}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  writeFileSync(join(dir, 'schema.ts'), SCHEMA_HELPER)
  writeFileSync(join(dir, 'plugins.ts'), generatePlugins(spec.plugins))

  const perFile = Math.ceil(spec.routes / spec.files)
  const fileNames: string[] = []

  for (let f = 0; f < spec.files; f++) {
    const from = f * perFile
    const count = Math.min(perFile, spec.routes - from)
    if (count <= 0) break
    const name = `routes-${f}`
    fileNames.push(name)
    writeFileSync(join(dir, `${name}.ts`), generateRouteFile(f, from, count))
  }

  writeFileSync(join(dir, 'app.ts'), generateApp(spec, fileNames))
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    extends: '../../../../tsconfig.base.json',
    compilerOptions: {
      noEmit: true,
      composite: false,
      incremental: false,
      declaration: false,
      declarationMap: false,
      sourceMap: false,
      types: ['node'],
    },
    include: ['./*.ts'],
  }, null, 2))

  return dir
}

const SCHEMA_HELPER = `import type { StandardSchemaV1 } from '@zenjs/core'

export function typed<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'bench',
      validate: (value: unknown) => ({ value: value as T }),
    },
  }
}
`

function generatePlugins(count: number): string {
  const parts: string[] = [`import { definePlugin } from '@zenjs/core'\n`]
  for (let i = 0; i < count; i++) {
    parts.push(`
export interface Service${i} {
  readonly id${i}: number
  readonly name${i}: string
  method${i}(input: string): Promise<{ result${i}: string }>
}

export const Plugin${i} = definePlugin<{ option${i}?: string }, { service${i}: Service${i} }>({
  name: 'plugin-${i}',
  version: '1.0.0',
  setup() {
    return { provides: {} as { service${i}: Service${i} } }
  },
})
`)
  }
  return parts.join('')
}

function generateRouteFile(fileIndex: number, from: number, count: number): string {
  const parts: string[] = [
    `import type { App } from './app.ts'`,
    `import { typed } from './schema.ts'\n`,
    `export function register${fileIndex}(app: App): void {`,
  ]

  for (let i = 0; i < count; i++) {
    const n = from + i
    const kind = n % 4

    if (kind === 0) {
      parts.push(`  app.get('/r${n}/:id<int>', (ctx) => ({ id: ctx.params.id, service: ctx.service0.id0 }))`)
    } else if (kind === 1) {
      parts.push(
        `  app.post('/r${n}/:org/items', {`,
        `    body: typed<{ name${n}: string; qty${n}: number }>(),`,
        `    response: { 201: typed<{ id${n}: number }>() },`,
        `  }, (ctx) => ({ id${n}: ctx.body.qty${n} + ctx.params.org.length }))`,
      )
    } else if (kind === 2) {
      parts.push(
        `  app.get('/r${n}/search', {`,
        `    query: typed<{ page${n}: number; term${n}: string }>(),`,
        `  }, (ctx) => ({ page: ctx.query.page${n}, term: ctx.query.term${n} }))`,
      )
    } else {
      parts.push(
        `  app.patch('/r${n}/:slug/:rev<int>', {`,
        `    body: typed<{ patch${n}: Record<string, unknown> }>(),`,
        `  }, (ctx) => ({ slug: ctx.params.slug, rev: ctx.params.rev, patch: ctx.body.patch${n} }))`,
      )
    }
  }

  parts.push('}\n')
  return parts.join('\n')
}

function generateApp(spec: FixtureSpec, files: readonly string[]): string {
  const pluginImports = Array.from({ length: spec.plugins }, (_, i) => `Plugin${i}`).join(', ')
  const uses = Array.from({ length: spec.plugins }, (_, i) => `  .use(Plugin${i})`).join('\n')

  return `import { createApp } from '@zenjs/core'
import { ZenRouter, parsePath } from '@zenjs/router'
import { ${pluginImports} } from './plugins.ts'
${files.map((f, i) => `import { register${i} } from './${f}.ts'`).join('\n')}

const base = createApp({
  router: new ZenRouter(),
  pathParser: { parse: (p: string) => ({ path: parsePath(p).path, segments: parsePath(p).segments }) },
})

export const app = base
${uses}
${spec.seal ? '  .seal()' : ''}

export type App = typeof app

${files.map((_, i) => `register${i}(app)`).join('\n')}
`
}
