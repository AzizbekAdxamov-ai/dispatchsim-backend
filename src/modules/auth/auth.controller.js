// HTTP layer for auth: parses/validates the request, calls the service, and
// shapes the response. No SQL, no password/token logic here — that lives in
// auth.service.js and below.
//
// All handlers are async and simply throw/await-reject on failure.
// Express 5 forwards a rejected async handler's error to next() on its own
// (unlike Express 4), so a thrown ZodError from `schema.parse(...)` or an
// AppError from the service reaches errorHandler without any try/catch here.

import { registerSchema, loginSchema, activeRoleSchema } from './auth.schemas.js'
import * as authService from './auth.service.js'

export async function register(req, res) {
  const input = registerSchema.parse(req.body)
  const result = await authService.register(input)
  res.status(201).json(result)
}

export async function login(req, res) {
  const input = loginSchema.parse(req.body)
  const result = await authService.login(input)
  res.status(200).json(result)
}

export async function me(req, res) {
  const user = await authService.me(req.auth.userId)
  res.status(200).json(user)
}

export async function setActiveRole(req, res) {
  const { activeRole } = activeRoleSchema.parse(req.body)
  const user = await authService.setActiveRole(req.auth.userId, activeRole)
  res.status(200).json(user)
}
