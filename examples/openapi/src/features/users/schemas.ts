import { z } from '../../shared/zod.ts'
import { PageInfo } from '../../shared/schemas/pagination.ts'

/**
 * One declaration, four consumers — rfcs/0001 I4.
 *
 * Each schema below becomes: the request validator, the compiled response
 * serializer, the TypeScript type on `ctx.body`, and the OpenAPI component. It
 * is written once. Nothing regenerates it, nothing keeps it in sync, because
 * there is no second copy to be out of sync with.
 *
 * `.meta({ id, title })` sets both on purpose. Zod uses `id` when it hoists a
 * reused schema into `$defs`, and Zen reads `title` when the schema is used at
 * the top level of a response — so setting both is what makes a client's type
 * called `PublicUser` in every position instead of `PublicUser` in one and
 * `GetUsersByIdResponse` in another.
 */

export const Role = z.enum(['admin', 'member']).meta({ description: 'Authorisation level.' })

/**
 * The *public* projection. `UserRow` in `service.ts` carries five more columns;
 * this is the contract, and §13.3 is what makes the difference structural
 * rather than a code review comment.
 */
export const PublicUser = z.object({
  id: z.int(),
  email: z.email(),
  name: z.string(),
  role: Role,
  createdAt: z.iso.datetime().meta({ description: 'RFC 3339, always UTC.' }),
}).meta({ id: 'PublicUser', title: 'PublicUser', description: 'A user, as the API is willing to describe one.' })

export const UserList = z.object({
  users: z.array(PublicUser),
  page: PageInfo,
}).meta({ id: 'UserList', title: 'UserList' })

export const NewUser = z.object({
  email: z.email(),
  name: z.string().min(1).max(120),
  // Optional on input because it defaults; guaranteed on output. The generated
  // document says both, correctly, because the converter is told which side it
  // is describing.
  role: Role.default('member'),
}).meta({ id: 'NewUser', title: 'NewUser' })

export const PatchUser = z.object({
  name: z.string().min(1).max(120).optional(),
  role: Role.optional(),
}).meta({ id: 'PatchUser', title: 'PatchUser' })

export const ListUsersQuery = z.object({
  role: Role.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export type PublicUserOut = z.infer<typeof PublicUser>
export type NewUserIn = z.input<typeof NewUser>
export type PatchUserIn = z.input<typeof PatchUser>
