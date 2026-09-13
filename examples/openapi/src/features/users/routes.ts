import { NotFound, type ZenApp } from 'zen'
import { ListUsersQuery, NewUser, PatchUser, PublicUser, UserList } from './schemas.ts'
import { UserRepoToken } from './service.ts'

/**
 * A feature owns its routes — rfcs/0001 §23.4.
 *
 * Feature-first, not layer-first: adding a field to a user touches
 * `features/users/`, not `controllers/`, `services/`, `models/` and `dtos/`.
 * The composition root in `src/app.ts` decides *where* this is mounted; this
 * file decides what it is.
 */
export function registerUsers(app: ZenApp): void {
  app.collection('/users', {
    name: 'users',
    tags: ['users'],
    meta: { description: 'The user directory.' },
  }, (users) => {
    users.get('/', {
      name: 'users.list',
      meta: { summary: 'List users' },
      query: ListUsersQuery,
      response: { 200: UserList },
    }, (ctx) => {
      const limit = Number(ctx.query.limit ?? 20) || 20
      const role = ctx.query.role
      const { rows, total } = ctx.resolve(UserRepoToken).list({
        limit,
        ...(role !== undefined ? { role: role as 'admin' | 'member' } : {}),
      })
      // Whole database rows, `passwordHash` and all. Five fields per user reach
      // the wire, and the document says exactly those five.
      return { users: rows, page: { total, cursor: null } } as never
    })

    users.get('/:id<int>', {
      name: 'users.show',
      meta: { summary: 'Fetch one user' },
      response: { 200: PublicUser },
    }, (ctx) => {
      const row = ctx.resolve(UserRepoToken).find(ctx.params.id)
      if (row === undefined) throw new NotFound(`User ${ctx.params.id} not found`)
      return row as never
    })

    users.post('/', {
      name: 'users.create',
      meta: { summary: 'Register a user' },
      body: NewUser,
      response: { 201: PublicUser },
    }, (ctx) => {
      const created = ctx.resolve(UserRepoToken).create(ctx.body as never)
      ctx.res.status(201).header('location', `/users/${created.id}`)
      return created as never
    })

    users.patch('/:id<int>', {
      name: 'users.update',
      meta: { summary: 'Update a user' },
      body: PatchUser,
      response: { 200: PublicUser },
    }, (ctx) => ctx.resolve(UserRepoToken).patch(ctx.params.id, ctx.body) as never)

    users.delete('/:id<int>', {
      name: 'users.destroy',
      meta: { summary: 'Delete a user' },
      // `204: null` is "this status carries no body" — the document says
      // `No Content` with no schema, rather than inventing an empty object.
      response: { 204: null },
    }, (ctx) => {
      ctx.resolve(UserRepoToken).remove(ctx.params.id)
      return ctx.empty(204)
    })
  })
}
