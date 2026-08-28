// Rate limiters applied to sensitive auth routes (login, register) to slow
// down brute-force and credential-stuffing attempts.

import rateLimit from 'express-rate-limit'
import { AppError } from '../lib/errors.js'

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res, next) => next(new AppError('RATE_LIMITED')),
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
