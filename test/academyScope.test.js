// Mentor scope and monotonic progress against the real schema. Always rolled
// back (inRollback), never committed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db/pool.js'
import { inRollback } from './helpers/rollback.js'
import * as service from '../src/modules/academy/academy.service.js'

const { hasDb } = await import('./helpers/db.js')

async function mkUser(client, tag) {
  const email = `academy-${tag}-${Math.random().toString(36).slice(2)}@scope.test`
  const r = await client.query(
    `INSERT INTO users (email, password_hash, name, company) VALUES ($1, 'x', $2, 'C') RETURNING id`,
    [email, `User ${tag}`],
  )
  return { id: r.rows[0].id, email }
}

test('a mentor sees only their own cohorts and students', { skip: !hasDb }, async () => {
  await inRollback(pool, async (client) => {
    const mentorA = await mkUser(client, 'ma')
    const mentorB = await mkUser(client, 'mb')
    const student = await mkUser(client, 's1')
    const a = { userId: mentorA.id, isAdmin: false }
    const b = { userId: mentorB.id, isAdmin: false }

    const cohort = await service.createCohort(a, { name: 'A cohort', mode: 'offline' }, client)
    await service.addMember(a, cohort.id, student.email, client)

    const listA = await service.listCohorts(a, client)
    const listB = await service.listCohorts(b, client)
    assert.ok(listA.some((c) => c.id === cohort.id && c.studentCount === 1))
    assert.ok(!listB.some((c) => c.id === cohort.id))

    await assert.rejects(service.getCohortStudents(b, cohort.id, client), { code: 'COHORT_NOT_FOUND' })
    await assert.rejects(service.getStudent(b, student.id, client), { code: 'STUDENT_NOT_FOUND' })
    await assert.rejects(service.addNote(b, student.id, { body: 'hi' }, client), { code: 'STUDENT_NOT_FOUND' })

    const seen = await service.getStudent(a, student.id, client)
    assert.equal(seen.lessons.length, 12)
    const admin = { userId: mentorB.id, isAdmin: true }
    assert.equal((await service.getStudent(admin, student.id, client)).student.id, student.id)
  })
})

test('progress only grows: later saves never un-do earlier exits', { skip: !hasDb }, async () => {
  await inRollback(pool, async (client) => {
    const u = await mkUser(client, 'p1')
    await service.saveProgress(u.id, 1, { exitsDone: { story: true } }, client)
    const r = await service.saveProgress(u.id, 1, { exitsDone: { roles: true }, quiz: { qz: 5 } }, client)
    assert.deepEqual(r.exitsDone, { story: true, roles: true })
    assert.equal(r.exitsCount, 2)
    assert.equal(r.quiz.qz, 5)
    assert.equal(r.completedAt, null)
    const full = await service.saveProgress(
      u.id, 1, { exitsDone: Object.fromEntries(['life', 'case', 'talk', 'quiz', 'app'].map((k) => [k, true])), mode: 'teach' }, client)
    assert.equal(full.exitsCount, 7)
    assert.ok(full.completedAt)
    assert.equal(full.mode, 'teach')
    // mode omitted keeps the stored one
    assert.equal((await service.saveProgress(u.id, 1, { exitsDone: {} }, client)).mode, 'teach')
    const me = await service.getMe(u.id, client)
    assert.equal(me.lessons.length, 12)
    assert.equal(me.cohort, null)
  })
})

test('a lower quiz result never replaces a higher one', { skip: !hasDb }, async () => {
  await inRollback(pool, async (client) => {
    const u = await mkUser(client, 'q1')
    await service.saveProgress(u.id, 1, { exitsDone: {}, quiz: { qz: 7 } }, client)
    const lower = await service.saveProgress(u.id, 1, { exitsDone: {}, quiz: { qz: 5 } }, client)
    assert.equal(lower.quiz.qz, 7)
    const mixed = await service.saveProgress(u.id, 1, { exitsDone: {}, quiz: { qz: 8 } }, client)
    assert.equal(mixed.quiz.qz, 8)
  })
})

test('findAccessFlagsById reports cohort membership', { skip: !hasDb }, async () => {
  await inRollback(pool, async (client) => {
    const { findAccessFlagsById } = await import('../src/modules/auth/users.repository.js')
    const mentor = await mkUser(client, 'cm')
    const student = await mkUser(client, 'cs')
    const other = await mkUser(client, 'co')
    const a = { userId: mentor.id, isAdmin: false }
    const cohort = await service.createCohort(a, { name: 'C', mode: 'offline' }, client)
    await service.addMember(a, cohort.id, student.email, client)
    assert.equal((await findAccessFlagsById(student.id, client)).isCohortMember, true)
    assert.equal((await findAccessFlagsById(other.id, client)).isCohortMember, false)
  })
})
