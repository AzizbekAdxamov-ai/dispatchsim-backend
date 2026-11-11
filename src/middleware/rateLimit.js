// Rate limiters applied to sensitive auth routes (login, register) to slow
// down brute-force and credential-stuffing attempts.

import rateLimit from 'express-rate-limit'
import { AppError } from '../lib/errors.js'
import {
  ONE_MINUTE_MS, OPS_LIMIT_PER_MINUTE, GLOBAL_LIMIT_PER_MINUTE, PDF_LIMIT_PER_MINUTE,
} from '../constants/security.js'

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Reserve a slot while authentication runs, then keep only client failures.
  // Successful logins and server/transport failures must not lock people out.
  // With skipFailedRequests, "successful" means keep the slot: only 4xx count.
  skipFailedRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode >= 400 && res.statusCode < 500,
  handler: (req, res, next) => {
    const remaining = Math.ceil((Number(req.rateLimit.resetTime) - Date.now()) / 1000)
    const retryAfterSeconds = Number.isFinite(remaining) ? Math.max(1, Math.min(900, remaining)) : 900
    res.setHeader('Retry-After', retryAfterSeconds)
    next(new AppError('RATE_LIMITED', { retryAfterSeconds }))
  },
})

// Registration needs a higher ceiling than login. A whole classroom behind
// one school NAT can share a single public IP, and login's 10/15min limit
// would start blocking students partway through a group sign-up (the
// eleventh student in a 30-person class). 30/15min is still far too low to
// meaningfully brute-force an invite code's server-generated block
// (~39 bits of entropy — see lib/inviteCode.js), so this doesn't weaken
// that defense; it only accommodates a classroom's shared IP.
export const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res, next) => next(new AppError('RATE_LIMITED')),
})

// Posting booking: 20/minute per IP. Prevents rapid-fire booking attempts
// that could DOS the atomic UPDATE + load-creation pipeline.
export const bookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res, next) => next(new AppError('RATE_LIMITED')),
})

// Applicant hiring: 5/minute per IP. Hire creates a driver row + updates
// the applicant in a transaction — more expensive than booking.
export const hireLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res, next) => next(new AppError('RATE_LIMITED')),
})

// Broker chat. Each message is a model call, so this is tighter than the
// read limiters — it stops a stuck client loop from burning the free tier's
// 200 requests/day in under a minute.
export const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
})

// /ops/*: the scheduler calls these about once a day, so 30/minute per IP
// never touches it and still caps anyone guessing the secret.
export const opsLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: OPS_LIMIT_PER_MINUTE,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res, next) => next(new AppError('RATE_LIMITED')),
})

// Every route except /health (load-balancer probes) and /ops (own limiter).
// Mounted in app.js before the routers; the sensitive routes keep their
// stricter limiters on top of this one.
const GLOBAL_LIMIT_SKIPPED = ['/health', '/ops']
export const globalLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: GLOBAL_LIMIT_PER_MINUTE,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => GLOBAL_LIMIT_SKIPPED.some((p) => req.path === p || req.path.startsWith(`${p}/`)),
  handler: (req, res, next) => next(new AppError('RATE_LIMITED')),
})

// PDF routes build a document in memory per request. Mounted BEFORE auth on
// those routes so unauthenticated hammering is throttled too.
export const pdfLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: PDF_LIMIT_PER_MINUTE,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res, next) => next(new AppError('RATE_LIMITED')),
})
