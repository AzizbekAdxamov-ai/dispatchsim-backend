import { z } from 'zod'
import { FAMILY_KEYS } from './alerts.catalog.js'

// The key shape the database CHECK also enforces: family, then optionally
// the entity it is about. Validated here so a bad key is a 400 with a
// reason rather than a constraint violation with a stack trace.
const KEY = /^[a-z]+\.[a-z-]+(:[A-Za-z0-9_-]+)?$/

export const ackSchema = z.object({
  alertKey: z.string().trim().regex(KEY, 'alertKey must be family.name or family.name:entityId')
    .refine((k) => FAMILY_KEYS.includes(k.split(':')[0]), {
      message: 'unknown alert family',
    }),
  // The client sends back the fingerprint it was shown. It cannot invent
  // one that silences a future, different situation -- the next read
  // compares against whatever is true then.
  fingerprint: z.string().trim().min(1).max(200),
})

export const unackSchema = z.object({
  alertKey: z.string().trim().regex(KEY),
})
