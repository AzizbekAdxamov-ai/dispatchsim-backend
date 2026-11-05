// Single point of error formatting for the whole API. No other file should
// send an error response directly — throw or next() an error and let this
// middleware decide the HTTP status and JSON body.
//
// The response body is always { error: { code, message } }, optionally with
// a `details` field when running outside production. The original error
// message, stack trace, and any raw SQL are NEVER sent to the client — they
// are only written to console.error for server-side debugging.

import { AppError, ERROR_CODES } from '../lib/errors.js'
import config from '../config.js'

function isZodError(err) {
  return err?.name === 'ZodError' || err?.constructor?.name === 'ZodError'
}

// Narrowed to the `users.email` unique constraint specifically. A raw
// `err.code === '23505'` check would also match the `invite_codes.code`
// unique constraint (added in migration 004) and misreport a code
// collision to the client as "This email is already registered" — which is
// both wrong and confusing. Any other 23505 (including invite code
// collisions, which invites.service.js already retries and turns into
// INVITE_CODE_TAKEN before this ever runs) falls through to INTERNAL_ERROR.
function isEmailUniqueViolation(err) {
  return err?.code === '23505' && err?.constraint === 'users_email_key'
}

// eslint-disable-next-line no-unused-vars
// Error codes whose `details` are contract, not debug. Keep this small:
// anything added here is visible to every client in production.
const CODES_WITH_PUBLIC_DETAILS = new Set([
  'DRIVER_REFUSED_WORK',
  'CREDIT_LINE_EXHAUSTED',
  'COMPANY_INSOLVENT',
  // "Daily message limit reached" is a fact with no arithmetic in it. The
  // student cannot tell whether the whole account ran out or whether four
  // classmates logged on and their share shrank -- and those call for
  // different things. The numbers ship.
  'CHAT_DAILY_LIMIT',
  // The broker's own sentence about the MC; without it the dispatcher sees
  // only the generic line and does not learn what to fix.
  'CARRIER_NOT_VERIFIED',
])

export function errorHandler(err, req, res, next) {
  console.error(err)

  let appError

  if (err instanceof AppError) {
    appError = err
  } else if (isZodError(err)) {
    const details = err.issues?.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }))
    appError = new AppError('VALIDATION_ERROR', details)
  } else if (isEmailUniqueViolation(err)) {
    appError = new AppError('EMAIL_TAKEN')
  } else {
    appError = new AppError('INTERNAL_ERROR')
  }

  const body = {
    error: {
      code: appError.code,
      message: ERROR_CODES[appError.code].message,
    },
  }

  // Details are debug output for most errors and are withheld in
  // production. For a few they are the answer itself: DRIVER_REFUSED_WORK
  // carries how much the driver is owed and how long they have waited, and
  // a dispatcher who only sees "not accepting work right now" has been
  // told a person's decision without its reason. Those ship everywhere.
  const detailsArePartOfTheAnswer = CODES_WITH_PUBLIC_DETAILS.has(appError.code)
  if (appError.code === 'RATE_LIMITED') {
    // Only the bounded public cooldown is safe, even outside production.
    const seconds = appError.details?.retryAfterSeconds
    if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 900) {
      body.error.details = { retryAfterSeconds: seconds }
    }
  } else if (appError.details && (detailsArePartOfTheAnswer || !config.isProd)) {
    body.error.details = appError.details
  }

  res.status(appError.status).json(body)
}
