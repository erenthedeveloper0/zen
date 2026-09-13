import { token } from 'zen'

/** A service, so tests can freeze time and the document stays byte-stable. */
export interface Clock {
  now(): Date
}

export const ClockToken = token<Clock>('app.clock')

export const systemClock = (): Clock => ({ now: () => new Date() })

/** Fixed, so two boots of the same code produce the same seeded rows. */
export const fixedClock = (iso: string): (() => Clock) => () => ({ now: () => new Date(iso) })
