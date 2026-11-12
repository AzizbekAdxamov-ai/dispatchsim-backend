// Changing your own password (POST /auth/password). DB-backed cases run in a
// rollback and skip when no database is reachable; the rest need none.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { ERROR_CODES } from '../src/lib/errors.js'
import { changePasswordSchema, registerSchema } from '../src/modules/auth/auth.schemas.js'
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '../src/constants/password.js'

const { hasDb } = await import('./helpers/db.js')

const OLD_PASSWORD = 'old-password-1'
const NEW_PASSWORD = 'new-password-2'
const TOO_SHORT = PASSWORD_MIN_LENGTH - 1
const TOO_LONG = PASSWORD_MAX_LENGTH + 1

async function withUser(fn) {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const usersRepo = await import('../src/modules/auth/users.repository.js')
  const password = await import('../src/lib/password.js')
  await inRollback(pool, async (client) => {
    const created = await usersRepo.create(
      {
        email: `pw-${randomUUID()}@fixture.example`,
        passwordHash: await password.hash(OLD_PASSWORD),
        name: 'Password Fixture',
        company: 'Fixture Co',
      },
      client,
    )
    await fn({ client, userId: created.id, usersRepo })
  })
}

// Kills: answering a wrong current password with 401 (the web client signs the user out on any authenticated 401).
test('a wrong current password is a 400, not a 401', () => {
  assert.equal(ERROR_CODES.CURRENT_PASSWORD_WRONG.status, 400)
  assert.equal(ERROR_CODES.PASSWORD_UNCHANGED.status, 400)
})

// Kills: a different length bound in the change schema than in register (7 accepted, or 73 accepted).
test('the new password is bounded 8..72, same as registration', () => {
  const body = (newPassword) => ({ currentPassword: 'x', newPassword })
  assert.equal(changePasswordSchema.safeParse(body('a'.repeat(TOO_SHORT))).success, false)
  assert.equal(changePasswordSchema.safeParse(body('a'.repeat(TOO_LONG))).success, false)
  assert.equal(changePasswordSchema.safeParse(body('a'.repeat(PASSWORD_MIN_LENGTH))).success, true)
  assert.equal(changePasswordSchema.safeParse(body('a'.repeat(PASSWORD_MAX_LENGTH))).success, true)
  const reg = (password) => ({ name: 'n', company: 'c', email: 'a@b.co', password })
  assert.equal(registerSchema.safeParse(reg('a'.repeat(TOO_SHORT))).success, false)
  assert.equal(registerSchema.safeParse(reg('a'.repeat(PASSWORD_MAX_LENGTH))).success, true)
})

// Kills: dropping .strict() so a client could smuggle extra keys into the body.
test('the change schema rejects unknown keys', () => {
  assert.equal(
    changePasswordSchema.safeParse({ currentPassword: 'x', newPassword: 'a'.repeat(PASSWORD_MIN_LENGTH), role: 'admin' }).success,
    false,
  )
})

// Kills: changePassword writing the new hash before (or without) checking the current password.
test('a wrong current password changes nothing', { skip: !hasDb }, async () => {
  const { changePassword } = await import('../src/modules/auth/auth.service.js')
  await withUser(async ({ client, userId, usersRepo }) => {
    const before = await usersRepo.findPasswordHashById(userId, client)
    await assert.rejects(
      changePassword(userId, { currentPassword: 'not-the-password', newPassword: NEW_PASSWORD }, client),
      (err) => err.code === 'CURRENT_PASSWORD_WRONG' && err.status === 400,
    )
    const after = await usersRepo.findPasswordHashById(userId, client)
    assert.equal(after.passwordHash, before.passwordHash)
  })
})

// Kills: allowing "change" to the same password, which would clear a temporary-password flag for nothing.
test('the new password must differ from the current one', { skip: !hasDb }, async () => {
  const { changePassword } = await import('../src/modules/auth/auth.service.js')
  await withUser(async ({ client, userId }) => {
    await assert.rejects(
      changePassword(userId, { currentPassword: OLD_PASSWORD, newPassword: OLD_PASSWORD }, client),
      (err) => err.code === 'PASSWORD_UNCHANGED',
    )
  })
})

// Kills: success leaving password_must_change true, or leaving the old hash in place.
test('a change stores the new hash and clears the must-change flag', { skip: !hasDb }, async () => {
  const { changePassword } = await import('../src/modules/auth/auth.service.js')
  const password = await import('../src/lib/password.js')
  await withUser(async ({ client, userId, usersRepo }) => {
    const hash = await password.hash(OLD_PASSWORD)
    await usersRepo.setPasswordHash({ id: userId, passwordHash: hash, mustChange: true }, client)
    assert.equal((await usersRepo.findById(userId, client)).mustChangePassword, true)

    const { user } = await changePassword(userId, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }, client)
    assert.equal(user.mustChangePassword, false)
    assert.equal('passwordHash' in user, false)

    const stored = await usersRepo.findPasswordHashById(userId, client)
    assert.equal(await password.verify(NEW_PASSWORD, stored.passwordHash), true)
    assert.equal(await password.verify(OLD_PASSWORD, stored.passwordHash), false)
  })
})
