// Administrator password reset: the temporary password, how it is stored,
// and who may reset whom.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { generateTemporaryPassword } from '../src/lib/tempPassword.js'
import { TEMP_PASSWORD_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '../src/constants/password.js'

const { hasDb } = await import('./helpers/db.js')

// Same alphabet as invite codes: no I, 1, O, 0, L, U.
const TEMP_PASSWORD_ALPHABET = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]+$/
const SAMPLE_COUNT = 50

// Kills: a temporary password that is too short, outside the alphabet, or outside the login length bounds.
test('a temporary password has the set length and alphabet', () => {
  assert.ok(TEMP_PASSWORD_LENGTH >= PASSWORD_MIN_LENGTH && TEMP_PASSWORD_LENGTH <= PASSWORD_MAX_LENGTH)
  const value = generateTemporaryPassword()
  assert.equal(value.length, TEMP_PASSWORD_LENGTH)
  assert.match(value, TEMP_PASSWORD_ALPHABET)
})

// Kills: a constant or low-entropy generator (the same password for every reset).
test('temporary passwords are not repeated', () => {
  const seen = new Set()
  for (let i = 0; i < SAMPLE_COUNT; i += 1) seen.add(generateTemporaryPassword())
  assert.equal(seen.size, SAMPLE_COUNT)
})

// Kills: an admin resetting their own password (it would skip the current-password check).
test('an administrator cannot reset their own password', async () => {
  const { resetUserPassword } = await import('../src/modules/admin/admin.service.js')
  const id = randomUUID()
  await assert.rejects(
    resetUserPassword({ actorId: id, targetId: id }),
    (err) => err.code === 'CANNOT_RESET_OWN_PASSWORD' && err.status === 409,
  )
})

// Kills: storing the temporary password in plain text, or forgetting to set the must-change flag.
test('a reset stores a hash of the temporary password and flags the account', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const usersRepo = await import('../src/modules/auth/users.repository.js')
  const password = await import('../src/lib/password.js')
  const { resetUserPassword } = await import('../src/modules/admin/admin.service.js')
  await inRollback(pool, async (client) => {
    const target = await usersRepo.create(
      {
        email: `reset-${randomUUID()}@fixture.example`,
        passwordHash: await password.hash('some-old-password'),
        name: 'Reset Fixture',
        company: 'Fixture Co',
      },
      client,
    )
    assert.equal((await usersRepo.findById(target.id, client)).mustChangePassword, false)

    const { temporaryPassword } = await resetUserPassword({ actorId: randomUUID(), targetId: target.id }, client)

    const stored = await usersRepo.findPasswordHashById(target.id, client)
    assert.notEqual(stored.passwordHash, temporaryPassword)
    assert.equal(await password.verify(temporaryPassword, stored.passwordHash), true)
    assert.equal((await usersRepo.findById(target.id, client)).mustChangePassword, true)
  })
})
