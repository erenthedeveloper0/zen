/**
 * The domain — deliberately trivial, because this example is about what
 * surrounds a handler rather than about what a handler does.
 */
export interface Note {
  readonly id: number
  readonly title: string
  readonly body: string
  readonly createdAt: string
  /** Never declared on a response schema, so §13.3 cannot emit it. */
  readonly internalAuthorEmail: string
}

export class NoteService {
  #notes: Note[] = [
    { id: 1, title: 'Buy milk', body: 'Semi-skimmed.', createdAt: '2026-08-01T09:00:00.000Z', internalAuthorEmail: 'ada@example.com' },
    { id: 2, title: 'Ship the pack', body: 'cors, security headers, request id, rate limit.', createdAt: '2026-08-14T11:30:00.000Z', internalAuthorEmail: 'ada@example.com' },
    { id: 3, title: 'Write the example', body: 'The one you are reading.', createdAt: '2026-08-21T16:45:00.000Z', internalAuthorEmail: 'grace@example.com' },
  ]
  #nextId = 4

  /**
   * `Note[]`, not `readonly Note[]`, and the compiler is the reason.
   *
   * `NoteList` declares `items: z.array(Note)`, whose inferred output is a
   * mutable array, so a `readonly` return here does not satisfy the handler's
   * result type and `npm run typecheck` says so. That is I8 doing its job: the
   * route's declaration is the contract, and a service that cannot meet it
   * fails at build time rather than at `JSON.stringify`. `slice` already
   * returns a fresh array, so the honest signature is this one.
   */
  list(page: number, perPage: number): { items: Note[]; total: number } {
    const start = (page - 1) * perPage
    return { items: this.#notes.slice(start, start + perPage), total: this.#notes.length }
  }

  find(id: number): Note | undefined {
    return this.#notes.find((note) => note.id === id)
  }

  create(input: { title: string; body: string }): Note {
    const note: Note = {
      id: this.#nextId++,
      title: input.title,
      body: input.body,
      createdAt: new Date().toISOString(),
      internalAuthorEmail: 'anonymous@example.com',
    }
    this.#notes.push(note)
    return note
  }

  remove(id: number): boolean {
    const before = this.#notes.length
    this.#notes = this.#notes.filter((note) => note.id !== id)
    return this.#notes.length < before
  }
}
