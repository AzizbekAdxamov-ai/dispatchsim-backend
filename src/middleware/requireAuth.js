// Express middleware that requires a valid JWT in the Authorization header.
// On success, attaches { userId } to req.auth for downstream handlers.
//
// The token no longer carries a role (see lib/token.js), so req.auth is
// just the subject id — every handler that needs role/roles/isAdmin reads
// it fresh from the database instead of trusting anything decoded here.

import { verify } from '../lib/token.js'
import { AppError } from '../lib/errors.js'

export function requireAuth(req, res, next) {
  const header = req.headers.authorization

  if (!header || !header.startsWith('Bearer ')) {
    return next(new AppError('UNAUTHORIZED'))
  }

  const token = header.slice('Bearer '.length).trim()
  if (!token) {
    return next(new AppError('UNAUTHORIZED'))
  }

  try {
    const payload = verify(token)
    req.auth = { userId: payload.sub }
    next()
  } catch (err) {
    next(err)
  }
}
