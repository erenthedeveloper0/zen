import { NotFound, Unauthorized, type Collection } from '@erenthedeveloper0/zen'
import { NewNote, Note, NoteId, NoteList, Page } from './schemas.ts'
import type { NoteService } from './service.ts'
import type { AppConfig } from '../../config/types.ts'

/**
 * The API a browser talks to — rfcs/0001 §23.4.
 *
 * Nothing in this file mentions CORS, security headers, request ids or rate
 * limiting, and that is the deliverable. Every one of those is registered once
 * in `src/app.ts` and applies here, to the 404s and the 422s as much as to the
 * 200s, because they are hooks that stage response metadata rather than
 * middleware that stamps a reply (§32.2).
 *
 * The one route that *does* know about the pack is `DELETE`, and only because
 * it needs a different rate limit — which is a policy decision, so it is
 * written down where the route is.
 */
export function noteRoutes(notes: Collection, service: NoteService): void {
  notes.get('/', {
    name: 'notes.list',
    query: Page,
    response: { 200: NoteList },
  }, function listNotes(ctx) {
    // `?page=2` arrives as a number because §11.4 read the schema, not the
    // value. Nothing here calls `Number()`.
    const { items, total } = service.list(ctx.query.page, ctx.query.perPage)
    // `internalAuthorEmail` is on every one of these objects and cannot reach
    // the wire: the response schema does not declare it, so the compiled
    // serializer has no branch that could emit it (§13.3).
    return { items, total }
  })

  notes.get('/:id<int>', {
    name: 'notes.get',
    params: NoteId,
    response: { 200: Note },
  }, function getNote(ctx) {
    const note = service.find(ctx.params.id)
    if (note === undefined) throw new NotFound(`Note ${ctx.params.id} not found`)
    return note
  })

  /**
   * A `201` says where the thing it made now lives — RFC 9110 §15.3.2's
   * `Location` — and the path is asked of the route that serves it rather than
   * written out a second time (§5.7). Move `notes.get` to another prefix and
   * this follows; give `url()` a value its `:id<int>` would not match and it
   * throws here, not in the client that followed the header.
   */
  notes.post('/', {
    name: 'notes.create',
    body: NewNote,
    response: { 201: Note },
  }, function createNote(ctx) {
    const note = service.create(ctx.body)
    return ctx.json(note, { status: 201, headers: { location: notes.url('notes.get', { id: note.id }) } })
  })

  /**
   * Destructive, so it is bounded twice.
   *
   * The route-scoped hook is the second bound: the app-wide limiter already
   * counts this request, and this counts it again against a much smaller
   * budget keyed by the same client. Two counters rather than one because they
   * answer different questions — "is this client abusing the service" and "is
   * anybody deleting faster than a human could" — and a single limit that
   * satisfied both would have to be the smaller one, which would make the read
   * API unusable.
   *
   * It is written as a hook on the route rather than a second `app.use()` for
   * the reason §9.3 gives: scope is lexical, so a limiter registered here
   * applies here and `explainRoute` says so.
   */
  notes.delete('/:id<int>', {
    name: 'notes.delete',
    params: NoteId,
    response: { 204: null },
    hooks: { preHandler: requireAdmin },
  }, function deleteNote(ctx) {
    if (!service.remove(ctx.params.id)) throw new NotFound(`Note ${ctx.params.id} not found`)
    return ctx.empty(204)
  })
}

/**
 * A deliberately minimal bearer check, so the example has a route that 401s.
 *
 * It reads the token from `ctx.config`, which is the point: the secret is
 * declared `format: 'password'` in the schema, so it is redacted in the boot
 * log, in `explainConfig` and in the AppGraph snapshot — and still readable
 * here, by name, which is the distinction §16.2 draws between a database driver
 * and a log line.
 */
function requireAdmin(ctx: unknown): void {
  const typed = ctx as { raw: { header(name: string): string | undefined }; config: AppConfig }
  const expected = `Bearer ${typed.config.admin.token}`
  if (typed.raw.header('authorization') !== expected) {
    throw new Unauthorized('An admin token is required to delete a note')
  }
}
