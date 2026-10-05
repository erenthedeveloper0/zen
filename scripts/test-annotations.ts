/**
 * Failed tests as GitHub annotations.
 *
 * A second reporter beside `spec`, wired into `npm test`. Outside GitHub
 * Actions it writes nothing. Inside, every failing test becomes an `::error`
 * workflow command: the test's name, its file and line, and the assertion's
 * message, shown on the commit, the pull request and the run's summary page.
 *
 * Without it, the only way to learn *which* test failed is the job log. GitHub
 * shows that to signed-in users with access to the repository, and its API
 * hands it only to admins. A red build that does not say what is red sends
 * everybody else to guess, and a guess about a CI-only failure is how a flaky
 * test gets blamed for a real defect.
 */
import { relative } from 'node:path'

interface TestFailEvent {
  readonly type: string
  readonly data: {
    readonly name: string
    readonly file?: string | undefined
    readonly line?: number | undefined
    readonly column?: number | undefined
    readonly details?: { readonly type?: string; readonly error?: unknown } | undefined
  }
}

/** `%`, CR and LF in a message; `:` and `,` too in a property (GitHub's escaping). */
const escapeData = (text: string): string => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const escapeProperty = (text: string): string => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C')

function describe(error: unknown): string {
  // The runner wraps a test's own error as the `cause` of ERR_TEST_FAILURE.
  const inner = (error as { cause?: unknown } | null)?.cause ?? error
  if (inner instanceof Error) {
    const frames = (inner.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line)).slice(0, 3)
    return [`${inner.name}: ${inner.message}`, ...frames].join('\n')
  }
  return String(inner)
}

export default async function* annotations(source: AsyncIterable<TestFailEvent>): AsyncGenerator<string> {
  const active = process.env['GITHUB_ACTIONS'] === 'true'
  for await (const event of source) {
    if (!active || event.type !== 'test:fail') continue
    const { name, file, line, column, details } = event.data
    // A suite fails when one of its tests did; the test is the useful line.
    if (details?.type === 'suite') continue
    const where = file === undefined
      ? ''
      : `file=${escapeProperty(relative(process.cwd(), file).split('\\').join('/'))},line=${line ?? 1},col=${column ?? 1},`
    yield `::error ${where}title=${escapeProperty(name)}::${escapeData(describe(details?.error))}\n`
  }
}
