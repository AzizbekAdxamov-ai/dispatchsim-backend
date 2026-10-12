// What is on the map, and why it is still there. Read-only unless told.
//
//   npm run map:leftovers                         lists, changes nothing
//   npm run map:leftovers -- --cancel 104882,104883
//
// --cancel undoes the dispatch of the loads named, through the same
// dispatch.service.cancelDispatch the "Cancel dispatch" button on a load
// calls: the load goes back to booked-and-unassigned, its driver is
// released, its open road events are closed, the duty plan not yet lived
// is trimmed. Nothing is deleted. Delivered loads cannot be cancelled
// (money has moved) and are refused by the service itself.
//
// Rows a test committed (fixtures) are LISTED, not removed: removing them
// means deleting from several tables, and that is decided on the list,
// not before it.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'
import { classifyLoad, hoursSince, cancelIds, isFixture, FIXTURE_BROKERS } from './mapLeftoversRules.js'

const ON_MAP_LOADS = `
  SELECT l.id, l.broker, l.status,
         l.origin_city || ', ' || l.origin_state AS origin,
         l.destination_city || ', ' || l.destination_state AS destination,
         l.dispatched_at AS "dispatchedAt", l.eta_at AS "etaAt",
         l.truck_id AS "truckId", d.name AS "driverName", d.email AS "driverEmail",
         (SELECT min(e.occurred_at) FROM load_events e
           WHERE e.load_id = l.id AND e.resolved_at IS NULL) AS "openEventAt",
         (SELECT e.event_type FROM load_events e
           WHERE e.load_id = l.id AND e.resolved_at IS NULL
           ORDER BY e.occurred_at LIMIT 1) AS "openEventType"
    FROM loads l
    LEFT JOIN drivers d ON d.id = l.driver_id
   WHERE l.delivered_at IS NULL
     AND l.dispatched_at IS NOT NULL
     AND l.eta_at IS NOT NULL
     AND l.status IN ('ontime', 'warn', 'crit')
   ORDER BY l.dispatched_at`

// The same "idle" as IDLE_TRUCKS_SQL; only trucks whose driver has a
// position are drawn, so only those are listed as on the map.
const ON_MAP_IDLE_TRUCKS = `
  SELECT t.id AS "truckId", d.name AS "driverName", d.email AS "driverEmail",
         d.current_city AS city, d.current_state AS state
    FROM trucks t
    JOIN drivers d ON d.id = t.driver_id
   WHERE d.current_lat IS NOT NULL AND d.current_lon IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM loads l WHERE l.truck_id = t.id AND l.status <> 'done')
     AND NOT EXISTS (SELECT 1 FROM loads l WHERE l.driver_id = t.driver_id AND l.status <> 'done')
   ORDER BY t.id`

// Fixture rows anywhere, drawn or not.
const FIXTURE_COUNTS = `
  SELECT (SELECT count(*) FROM loads   WHERE broker = ANY($1::text[]))::int AS loads,
         (SELECT count(*) FROM drivers WHERE email LIKE '%@fixture.test')::int AS drivers,
         (SELECT count(*) FROM trucks  WHERE id ~ '^(FX-[0-9]{4}-TX|ZZ-0001-TX)$')::int AS trucks`

const LABEL = {
  fixture: 'TEST FIXTURE (a test wrote it -- not real)',
  stuck: 'STUCK (road event never answered -- will never deliver)',
  overdue: 'OVERDUE (ETA passed -- delivers once the backend runs)',
  running: 'running (belongs on the map)',
}

try {
  const ids = cancelIds(process.argv)
  if (ids.length > 0) {
    const { cancelDispatch } = await import('../src/modules/loads/dispatch.service.js')
    for (const id of ids) {
      try {
        const r = await cancelDispatch({ loadId: id })
        console.log(`cancelled ${id}: back to booked, ${r.eventsClosed} road event(s) closed, ${r.dutyEventsRemoved} planned duty row(s) removed`)
      } catch (err) {
        console.log(`NOT cancelled ${id}: ${err.code ?? ''} ${err.message}`)
      }
    }
    console.log('')
  }

  const now = new Date()
  const loads = (await pool.query(ON_MAP_LOADS)).rows
  const groups = { fixture: [], stuck: [], overdue: [], running: [] }
  for (const l of loads) groups[classifyLoad(l, now)].push(l)

  console.log(`Loads on the map: ${loads.length}`)
  for (const kind of ['fixture', 'stuck', 'overdue', 'running']) {
    if (groups[kind].length === 0) continue
    console.log(`\n  ${LABEL[kind]}: ${groups[kind].length}`)
    for (const l of groups[kind]) {
      const why = kind === 'stuck'
        ? ` · ${l.openEventType} open ${hoursSince(l.openEventAt, now)} h`
        : kind === 'overdue' ? ` · ETA ${hoursSince(l.etaAt, now)} h ago` : ''
      console.log(`    ${l.id}  ${l.origin} -> ${l.destination}  ${l.driverName ?? 'no driver'} / ${l.truckId ?? 'no truck'}`
        + `  dispatched ${hoursSince(l.dispatchedAt, now)} h ago  ${l.broker}${why}`)
    }
  }

  const idle = (await pool.query(ON_MAP_IDLE_TRUCKS)).rows
  const idleFixtures = idle.filter((t) => isFixture(t))
  console.log(`\nParked trucks on the map: ${idle.length}${idleFixtures.length ? ` (${idleFixtures.length} of them test fixtures)` : ''}`)
  for (const t of idle) {
    console.log(`    ${t.truckId}  ${t.driverName}  ${t.city ?? '?'}, ${t.state ?? '?'}${isFixture(t) ? '  TEST FIXTURE' : ''}`)
  }

  const f = (await pool.query(FIXTURE_COUNTS, [FIXTURE_BROKERS])).rows[0]
  console.log(`\nTest fixture rows anywhere in the database: loads ${f.loads}, drivers ${f.drivers}, trucks ${f.trucks}`)

  // Stuck only: an overdue load is a real delivery waiting for the backend
  // to run, and cancelling it would throw away a run that happened.
  const cancellable = groups.stuck.map((l) => l.id)
  if (cancellable.length > 0) {
    console.log('\nTo take loads off the map without deleting them (the Cancel dispatch button, in bulk):')
    console.log(`  npm run map:leftovers -- --cancel ${cancellable.join(',')}`)
    console.log('  Pick the ids you mean -- a load a student is working on is not a leftover.')
  }
  if (groups.overdue.length > 0) {
    console.log('\nOverdue loads deliver on their own within 30 s of `npm start` -- start the backend, then run this again.')
  }
  if (f.loads + f.drivers + f.trucks > 0) {
    console.log('\nFixture rows are listed, not removed. Send this output to Nova.')
  }
} finally {
  await pool.end()
}
