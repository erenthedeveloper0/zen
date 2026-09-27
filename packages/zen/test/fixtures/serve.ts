/**
 * A real Zen process, for the lifecycle suite to signal and crash.
 *
 * Prints `ready <url>` once listening, `onClose` when the shutdown sequence
 * reaches it, and — if started with `crash` — throws from a timer once ready.
 */
import { zen, NoopLogger } from '@erenthedeveloper0/zen'

const mode = process.argv[2] ?? 'serve'
const app = zen({ env: {}, logger: new NoopLogger() })

app.get('/', () => 'ok')
app.hook('onClose', (reason) => { console.log(`onClose ${String(reason)}`) })

const handle = await app.listen({ port: 0 })
console.log(`ready ${handle.url}`)

if (mode === 'crash') {
  setTimeout(() => { throw new Error('boom') }, 20)
} else if (mode === 'reject') {
  setTimeout(() => { void Promise.reject(new Error('nobody caught this')) }, 20)
}
