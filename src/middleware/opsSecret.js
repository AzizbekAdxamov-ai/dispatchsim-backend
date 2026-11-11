// Guards /ops/*: the shared secret from OPS_TICK_SECRET.
//
// Two header shapes are accepted: `x-ops-secret` for an external
// scheduler, and `Authorization: Bearer <secret>`, which is what Vercel
// sends when CRON_SECRET is set on the project. With no secret configured
// the route refuses (an open tick endpoint would let anyone drive the
// company's clock).
import config from '../config.js'
import { AppError } from '../lib/errors.js'
import { safeEqual } from '../lib/safeEqual.js'

export function requireOpsSecret(req, res, next) {
  const expected = config.opsTickSecret
  if (!expected) return next(new AppError('TICK_NOT_CONFIGURED'))
  const header = req.get('x-ops-secret') || ''
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
  // Both comparisons always run so which header matched is not observable.
  const headerOk = safeEqual(header, expected)
  const bearerOk = safeEqual(bearer, expected)
  if (!headerOk && !bearerOk) return next(new AppError('UNAUTHORIZED'))
  next()
}
