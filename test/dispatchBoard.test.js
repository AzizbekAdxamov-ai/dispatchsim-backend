// The dispatch board's one real question: does 'Assigned' mean what the
// ELD says it means. The column split is derived from duty_events (a load
// is Assigned until its log's first driving minute starts), so the tests
// pin exactly that -- a load with only rest planned sits in Assigned, the
// same load once driving starts sits in In Transit, and no load lands in
// both. Rules underneath (statuses, one-active-per-driver) are each
// proven elsewhere; this is the composition.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'

const { hasDb } = await import('./helpers/db.js')

test('the board columns are disjoint and cover every load exactly once', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const service = await import('../src/modules/loads/loads.service.js')

  await inRollback(pool, async (client) => {
    const board = await service.getBoard({ limit: 50 })
    const all = [...board.available, ...board.assigned, ...board.inTransit, ...board.delivered]
    const ids = all.map((c) => c.id)
    assert.equal(new Set(ids).size, ids.length, 'no load appears in two columns')

    // Cover: the four columns together are every load the list knows.
    const listed = await client.query(`SELECT count(*)::int AS n FROM loads`)
    assert.equal(ids.length, listed.rows[0].n,
      'the board and the loads table agree on how many loads exist')

    // The card shape is the list's shape: lane, rate, driver jsonb.
    for (const c of all) {
      assert.ok(c.id && c.originCity && c.destinationCity != null)
      assert.ok(c.rateUsd >= 0)
      if (c.status !== 'neutral' && c.driverId == null) {
        assert.equal(c.driver, null, `active load ${c.id} without a driver row reads as null`)
      }
    }

    // Statuses land where the machine says.
    for (const c of board.available) assert.equal(c.status, 'neutral')
    for (const c of board.delivered) assert.equal(c.status, 'done')
    for (const c of [...board.assigned, ...board.inTransit]) {
      assert.ok(['ontime', 'warn', 'crit'].includes(c.status))
      assert.ok(c.dispatchedAt != null && c.driver != null)
    }
  })
})

test('Assigned and In Transit split on the log\'s first driving minute', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const service = await import('../src/modules/loads/loads.service.js')

  await inRollback(pool, async (client) => {
    // A dispatched load whose log has NO driving minute yet must sit in
    // Assigned. Build it inside the transaction: take an active load,
    // remove its driving rows (keeping others), and re-read the board.
    const load = (await client.query(
      `SELECT l.id, l.driver_id AS "driverId" FROM loads l
        WHERE l.status IN ('ontime','warn','crit') AND l.driver_id IS NOT NULL
        ORDER BY l.dispatched_at DESC LIMIT 1`,
    )).rows[0]
    if (!load) return

    // Count driving rows first: if this load has none, it is already an
    // Assigned fixture by itself.
    const driving = (await client.query(
      `SELECT count(*)::int AS n FROM duty_events
        WHERE load_id = $1 AND status = 'driving' AND record_status = 'active' AND started_at <= now()`,
      [load.id],
    )).rows[0].n

    let board = await service.getBoard({ limit: 100 })
    const columnOf = (id) => {
      if (board.assigned.some((c) => c.id === id)) return 'assigned'
      if (board.inTransit.some((c) => c.id === id)) return 'inTransit'
      return 'other'
    }

    if (driving === 0) {
      assert.equal(columnOf(load.id), 'assigned',
        'a dispatched load with no driving minute on its log is Assigned')
    } else {
      assert.equal(columnOf(load.id), 'inTransit',
        'a dispatched load with a driving minute on its log is In Transit')

      // Now the other side: start the next driving block in the FUTURE and
      // delete the current one -- the log then has driving planned but not
      // rolling, which is still Assigned (the truck has not moved yet).
      const kept = await client.query(
        `DELETE FROM duty_events
          WHERE load_id = $1 AND status = 'driving' AND record_status = 'active' AND started_at <= now()
          RETURNING started_at, ended_at`,
        [load.id],
      )
      // Re-add the same drive in the future so the load stays legal.
      const last = kept.rows[kept.rows.length - 1]
      if (last) {
        await client.query(
          `INSERT INTO duty_events (driver_id, load_id, truck_id, status, started_at, ended_at, origin)
           VALUES ($1, $2, (SELECT truck_id FROM loads WHERE id = $2), 'driving', $3, $4, 'automatic')
           ON CONFLICT (driver_id, started_at) WHERE record_status = 'active' DO NOTHING`,
          [load.driverId, load.id, new Date(Date.now() + 60_000), last.ended_at],
        )
      }
      board = await service.getBoard({ limit: 100 })
      assert.equal(columnOf(load.id), 'assigned',
        'driving planned but not started is still Assigned -- the truck has not moved')
    }
  })
})
