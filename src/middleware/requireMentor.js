// Gate for /academy/mentor/*. Must run AFTER requireAuth. Like requireAdmin,
// access is re-read from the database on every request, never from the token,
// so revoking mentor access takes effect on the next request. Admins pass too.
// Sets req.access = { isAdmin, isMentor } for the handlers behind it.

import * as usersRepo from '../modules/auth/users.repository.js'
import { AppError } from '../lib/errors.js'

export async function requireMentor(req, res, next) {
  try {
    const flags = await usersRepo.findAccessFlagsById(req.auth.userId)
    if (!flags) return next(new AppError('USER_NOT_FOUND'))
    const isAdmin = flags.isAdmin === true
    const isMentor = flags.isMentor === true
    if (!(isMentor || isAdmin)) return next(new AppError('FORBIDDEN'))
    req.access = { isAdmin, isMentor }
    next()
  } catch (err) {
    next(err)
  }
}
