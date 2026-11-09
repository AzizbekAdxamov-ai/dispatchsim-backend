// Release 2026-11-10, band 11: appointments sit on :00 or :30 (a real
// shipper books a slot, not 14:37). Seed postings only; no existing row changes.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildPostingRows, appointmentSql, APPOINTMENT_STEP_MIN } from '../scripts/seed/postings.js'
import { generateLoad } from '../scripts/seed/generate.js'
import { validateLoadItem } from '../scripts/seed/validate.js'
import { mulberry32 } from '../scripts/seed/build.js'
import { inRollback } from './helpers/rollback.js'

const { hasDb } = await import('./helpers/db.js')
const SECONDS_PER_MIN = 60

const items = () => {
  const rng = mulberry32(23)
  return Array.from({ length: 40 }, () => validateLoadItem(generateLoad(rng)).item)
}
const rows = () => buildPostingRows({ rng: mulberry32(24), postingItems: items(), drivers: [], trucks: [], fleetEquipment: [] })

// Kills: writing pickup_at / delivery_at as plain now() + interval (live: pickup 14:37)
test('pickup and delivery are rounded up to the appointment step in SQL', () => {
  assert.equal(APPOINTMENT_STEP_MIN, 30)
  const step = APPOINTMENT_STEP_MIN * SECONDS_PER_MIN
  for (const row of rows()) {
    for (const column of ['pickup_at', 'delivery_at']) {
      assert.match(row[column].value, /ceil\(/, column)
      assert.ok(row[column].value.includes(String(step)), column)
    }
  }
})

// Kills: changing how many random numbers the rows draw (would reshuffle the whole seed)
test('appointmentSql rounds the offset it is given', () => {
  assert.ok(appointmentSql(125).value.includes("interval '125 minutes'"))
})

// Kills: a ceil that lands off the half hour, or a delivery that falls before pickup after rounding
test('built in the database, every appointment is :00 or :30 and delivery follows pickup', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  await inRollback(pool, async (client) => {
    for (const row of rows()) {
      const { rows: [r] } = await client.query(
        `SELECT extract(minute from p)::int AS pm, extract(second from p)::int AS ps,
                extract(minute from d)::int AS dm, d > p AS after
         FROM (SELECT ${row.pickup_at.value} AS p, ${row.delivery_at.value} AS d) t`,
      )
      assert.ok([0, 30].includes(r.pm) && [0, 30].includes(r.dm), `${r.pm}/${r.dm}`)
      assert.equal(r.ps, 0)
      assert.equal(r.after, true)
    }
  })
})
