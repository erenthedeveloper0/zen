import { html, isLocalUrl, NotFound, type Collection } from '@erenthedeveloper0/zen'
import { z } from '../../shared/zod.ts'
import { NoteId } from '../notes/schemas.ts'
import type { NoteService } from '../notes/service.ts'

/**
 * The pages a browser loads, rather than the API it calls — rfcs/0001 §19.5.
 *
 * Two of the oldest bugs in server-rendered HTML, and neither needs the
 * application to remember anything:
 *
 * - **Stored XSS.** A note's title and body are whatever somebody POSTed to
 *   `/api/notes`. They are interpolated into the page below with no escaping
 *   call in sight, because `html` escapes every hole for where it sits — and a
 *   `<script>` in a title arrives as text.
 * - **The open redirect.** `/login?next=…` is the classic: after sign-in, send
 *   the user back where they were going. `ctx.redirect()` will not leave this
 *   origin unless `app.ts` names the destination, so a hostile `next` cannot
 *   become a phishing link carrying this application's domain. Here it is also
 *   checked first with `isLocalUrl`, so a bad one falls back to a page rather
 *   than failing — the framework's refusal is the safety net, not the UX.
 *
 * The back link is the third, quieter case: a URL from the query string in an
 * `href`. A `javascript:` URL there is neutralised to
 * `about:invalid#zen-unsafe-url`, because escaping `javascript:alert(1)`
 * changes nothing about it.
 */
const PageQuery = z.object({ from: z.string().optional() })
const LoginQuery = z.object({ next: z.string().optional() })

export function pageRoutes(pages: Collection, service: NoteService): void {
  pages.get('/notes/:id<int>', {
    name: 'pages.note',
    params: NoteId,
    query: PageQuery,
  }, function notePage(ctx) {
    const note = service.find(ctx.params.id)
    if (note === undefined) throw new NotFound(`Note ${ctx.params.id} not found`)
    return html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${note.title} — Notes</title></head>
<body>
  <article>
    <h1>${note.title}</h1>
    <p>${note.body}</p>
    <p><small>${new Date(note.createdAt).toUTCString()}</small></p>
  </article>
  <a href="${ctx.query.from ?? '/notes/1'}">Back</a>
</body>
</html>`
  })

  /** Where a sign-in ends. The sign-in itself is not modelled — the redirect is the point. */
  pages.get('/login', {
    name: 'pages.login',
    query: LoginQuery,
  }, function afterLogin(ctx) {
    const next = ctx.query.next
    return ctx.redirect(next !== undefined && isLocalUrl(next) ? next : '/notes/1', 303)
  })

  /**
   * Off to the identity provider — the one kind of redirect that *should*
   * leave, and the reason `redirect.allowExternal` exists. `app.ts` names the
   * origin; without that line this is a `ZEN_REDIRECT_EXTERNAL`.
   */
  pages.get('/login/sso', { name: 'pages.sso' }, function toIdentityProvider(ctx) {
    return ctx.redirect('https://id.notes.example/authorize?client_id=notes&response_type=code')
  })
}
