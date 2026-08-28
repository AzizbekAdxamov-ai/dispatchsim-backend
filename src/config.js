// Central configuration for the backend. Loads environment variables once,
// validates the ones the app cannot safely run without, and exposes a single
// frozen object so the rest of the codebase never touches process.env directly.

import 'dotenv/config'
import { ROLE_KEYS } from './constants/roles.js'

const errors = []

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl || databaseUrl.trim() === '') {
  errors.push('DATABASE_URL is missing')
}

const jwtSecret = process.env.JWT_SECRET
if (!jwtSecret || jwtSecret.length < 32) {
  // Never log the actual value here — only its absence/length problem.
  errors.push('JWT_SECRET is missing or too short (must be at least 32 characters)')
}

const rawPort = process.env.PORT
const port = Number(rawPort)
if (!rawPort || !Number.isInteger(port) || port <= 0) {
  errors.push('PORT is missing or not a valid positive integer')
}

// DEFAULT_ROLE is optional and, unlike the values above, is not required to
// run the app at all. Left unset (or blank), newly registered accounts get
// no roles granted at all (an empty roles set, activeRole: null) —
// unassigned, waiting for an administrator to grant a work area via
// PATCH /admin/users/:id, or for the student to register through an
// invite link instead. Set it only if this deployment wants signups that
// did NOT use an invite code to be granted one specific role
// automatically; an invite code's own roles always take priority over this
// when both apply (see modules/auth/auth.service.js's register()).
const rawDefaultRole = process.env.DEFAULT_ROLE
const defaultRole = rawDefaultRole && rawDefaultRole.trim() !== '' ? rawDefaultRole.trim() : null
if (defaultRole !== null && !ROLE_KEYS.includes(defaultRole)) {
  errors.push(`DEFAULT_ROLE must be one of: ${ROLE_KEYS.join(', ')} (or left blank)`)
}

if (errors.length > 0) {
  console.error('Invalid configuration:')
  for (const message of errors) {
    console.error(`  - ${message}`)
  }
  console.error('Check your .env file against .env.example and try again.')
  process.exit(1)
}

const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '24h'
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173'
const nodeEnv = process.env.NODE_ENV || 'development'
const isProd = nodeEnv === 'production'

export default {
  databaseUrl,
  jwtSecret,
  jwtExpiresIn,
  port,
  corsOrigin,
  isProd,
  defaultRole,
}
