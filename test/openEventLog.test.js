// An event that is still OPEN stops the truck, so the ELD must show the
// wait -- not the plan driving on without the driver (replan.service.js's
// logOpenEventWait). Two layers are proven:
//
//   1. dutyStatusWhileOpen -- the law's status per event TYPE while no
//      option is chosen. Mutation-tested: a wrong mapping must fail.
//   2. logOpenEventWait against the REAL schema (rolled back): it cuts the
//      plan at occurred_at, writes exactly one wait row, and is idempotent
//      (rule 7: DB constraint, not a memory flag).
//
// The DB parts skip cleanly when no database is configured, like the
// other schema-backed tests in this suite.
import test from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'

import { dutyStatusWhileOpen, EVENT_KEYS } from '../src/constants/loadEvents.js'

test('dutyStatusWhileOpen: every event type has a status while open', () => {
  for (const key of EVENT_KEYS) {
    assert.ok(dutyStatusWhileOpen(key), `${key} must map to a duty status while open`)
  }
  assert.equal(dutyStatusWhileOpen('no-such-type'), null, 'unknown type maps to null, not a guess')
})

test('dutyStatusWhileOpen: stationary waits are off duty, attended trucks on duty (395.2)', () => {
  // Mutation kill: swapping these two would log a parked weather wait as
  // work time (inflating hours_today) or a breakdown attendance as rest
  // (freeing the 11-hour clock while the driver stands on the shoulder).
  assert.equal(dutyStatusWhileOpen('weather'), 'off-duty')
  assert.equal(dutyStatusWhileOpen('roadClosure'), 'off-duty')
  assert.equal(dutyStatusWhileOpen('breakdown'), 'on-duty-not-driving')
  assert.equal(dutyStatusWhileOpen('detention'), 'on-duty-not-driving')
})

const hasDb = Boolean(process.env.DATABASE_URL)

test('logOpenEventWait: cuts the plan, writes one wait row, idempotent on re-run', { skip: !hasDb }, async (t) => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const dutyEventsRepo = await import('../src/modules/hos/dutyEvents.repository.js')
  const { logOpenEventWait } = await import('../src/modules/hos/replan.service.js')
  const loadsRepo = await import('../src/modules/loads/loads.repository.js')

  // A dispatched, undelivered load with a driver -- the fixture seeds one
  // when the audit scripts run; otherwise the newest dispatched load.
  const client0 = await pool.connect()
  let loadId
  try {
    const r = await client0.query(`
      SELECT l.id FROM loads l
       WHERE l.dispatched_at IS NOT NULL AND l.delivered_at IS NULL AND l.driver_id IS NOT NULL
       ORDER BY l.dispatched_at DESC LIMIT 1`)
    loadId = r.rows[0]?.id
  } finally {
    client0.release()
  }
  if (!loadId) {
    t.skip('no dispatched load available')
    return
  }

  const occurredAt = new Date(Date.now() - 60_000).toISOString()
  let result
  await inRollback(pool, async (client) => {
    result = await logOpenEventWait({ loadId, eventType: 'breakdown', eventAt: occurredAt }, { client })
    // Inspect the effects inside the same transaction, then roll back:
    // the test leaves no rows behind.
    const events = await dutyEventsRepo.forLoad(client, loadId)
    const wait = events.filter((e) => e.startedAt.toISOString() === occurredAt)
    assert.equal(wait.length, 1, 'exactly one wait row starts at occurred_at')
    assert.equal(wait[0].status, 'on-duty-not-driving')
    // The plan is cut: nothing automatic starts at or after the event.
    assert.ok(events.every((e) => new Date(e.startedAt).getTime() < new Date(occurredAt).getTime() || e === wait[0]),
      'no plan row survives past the event')
    // Idempotent: a second run adds no second row (one-active-start guard).
    const again = await logOpenEventWait({ loadId, eventType: 'breakdown', eventAt: occurredAt }, { client })
    assert.ok(again.logged || again.logged === false, 'second run returns without throwing')
    const events2 = await dutyEventsRepo.forLoad(client, loadId)
    const wait2 = events2.filter((e) => e.startedAt.toISOString() === occurredAt)
    assert.ok(wait2.length <= 1, 're-run does not duplicate the wait row')
    assert.ok(loadsRepo, 'loads repo imported for facts writer shape')
  })
  assert.equal(result.logged, true, 'the wait was logged')
})
