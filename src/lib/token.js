// JWT signing/verification helpers.
//
// The token payload is NOT encrypted, only signed — anyone can decode and
// read it (it's base64, not ciphertext). It must therefore never carry
// anything sensitive: no email, no company name, no password hash.
//
// It carries only `sub` (the user id) — no role. Under the multi-role model
// a person's roles (plural, admin-granted) and active_role (which one
// they're currently working in) can both change at any time without the
// token being reissued, so baking either into the JWT would mean a stale
// token could keep claiming access that was since revoked, or keep
// claiming a workspace the student switched away from, until the token's
// own expiry. Every place that used to trust `payload.role` now re-reads
// the current state from the database instead (requireAdmin already did
// this for `is_admin`; the same reasoning now applies to roles). Practical
// upshot: switching active_role or having a role revoked take effect on
// the very next request, never requiring the user to log in again.
import jwt from 'jsonwebtoken'
import config from '../config.js'
import { AppError } from './errors.js'

export function sign({ id }) {
  return jwt.sign({ sub: id }, config.jwtSecret, { expiresIn: config.jwtExpiresIn })
}

export function verify(token) {
  try {
    return jwt.verify(token, config.jwtSecret)
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new AppError('TOKEN_EXPIRED')
    }
    throw new AppError('UNAUTHORIZED')
  }
}
