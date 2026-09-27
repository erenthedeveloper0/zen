/**
 * Print the source the Serializer Compiler emits for a response schema.
 *
 * `node scripts/show-serializer.ts`
 *
 * The companion to `show-generated.ts`. §13.3's claim is that the compiled
 * serializer *cannot* emit an undeclared field, and the argument for that claim
 * is the source itself: there is no key enumeration in it to leak through.
 */
import { buildProgram, generateSerializerSource, walkSerializer, compileSerializer, CodeGen, DEFAULT_CAPABILITIES } from '@erenthedeveloper0/zen-core'
import type { JsonSchema } from '@erenthedeveloper0/zen-core'

const User: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    email: { type: 'string' },
    roles: { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'string', format: 'date-time' },
    nickname: { type: 'string' },
  },
  required: ['id', 'email', 'roles', 'createdAt'],
}

const { program, diagnostics } = buildProgram(User, false)
if (program === null) {
  console.error(diagnostics)
  process.exit(1)
}

console.log('─── generated ───────────────────────────────────────────────────\n')
console.log(generateSerializerSource(program))

const codegen = new CodeGen({ caps: DEFAULT_CAPABILITIES })
const compiled = compileSerializer(program, 'demo', codegen)
const walked = walkSerializer(program)

const value = {
  id: 7,
  email: 'ada@example.com',
  roles: ['admin', 'ops'],
  createdAt: new Date('2024-03-01T12:00:00.000Z'),
  passwordHash: '$2b$12$notleaked',
  stripeCustomerId: 'cus_leak',
}

console.log('\n─── output ──────────────────────────────────────────────────────\n')
console.log('compiled       :', compiled(value))
console.log('walked         :', walked(value))
console.log('JSON.stringify :', JSON.stringify(value))
console.log('\nagree:', compiled(value) === walked(value))
