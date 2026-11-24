// toPublicUser.academyAccess: cohort member, mentor or admin only. Pure, no DB.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toPublicUser } from '../src/modules/auth/auth.service.js'

test('academyAccess is true for a cohort member, a mentor and an admin', () => {
  assert.equal(toPublicUser({ isCohortMember: true }).academyAccess, true)
  assert.equal(toPublicUser({ isMentor: true }).academyAccess, true)
  assert.equal(toPublicUser({ isAdmin: true }).academyAccess, true)
})

test('academyAccess is false for a role-only user and for an empty row', () => {
  const roleOnly = toPublicUser({ roles: ['dispatcher'], isAdmin: false, isMentor: false, isCohortMember: false })
  assert.equal(roleOnly.academyAccess, false)
  assert.equal(toPublicUser({}).academyAccess, false)
})

test('academyAccess is always a boolean', () => {
  for (const row of [{}, { isCohortMember: 1 }, { isMentor: 'yes' }, { isAdmin: null }]) {
    assert.equal(typeof toPublicUser(row).academyAccess, 'boolean')
  }
})
