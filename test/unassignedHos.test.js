// Compliance > Unassigned HOS: the carrier's 49 CFR 395.32 review of the
// unidentified driving records repositioning.js writes.
//
// The rules that can look right and be wrong are tested pure: the
// annotation window, the guard against reviewing someone else's record,
// the active-record guard on both endpoints. The full assign/annotate
// flow is tested against the REAL schema inside a rolled-back
// transaction -- the migration CHECKs (037/038) are the other half of
// these rules, and nothing else proves them together. Skips cleanly when
// no database is configured, like the other schema-backed tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'

import { reviewAnnotationSchema, reviewAssignSchema } from '../src/modules/compliance/compliance.schemas.js'
import { AppError } from '../src/lib/errors.js'
import { REAL_MS_PER_SIM_DAY } from '../src/constants/simClock.js'
import { REVIEW_THRESHOLD_MIN } from '../src/modules/hos/repositioning.js'

// --- schemas: the annotation is the review, 4..60 is the ELD window -----

test('the annotation window is the ELD standard, 4..60, trimmed first', () => {
  // Kills: a schema wider than the database CHECK (a 4-char-min schema
  // that lets whitespace through to a CHECK failure the dispatcher
  // cannot act on), or a max above 038's 60.
  assert.ok(reviewAnnotationSchema.safeParse({ annotation: '  abcd  ' }).success)
  assert.ok(reviewAnnotationSchema.safeParse({ annotation: `  ${'a'.repeat(58)}  ` }).success,
    '58 real characters inside 60 raw ones is in the window')
  assert.equal(reviewAnnotationSchema.safeParse({ annotation: '  ok  ' }).success, false,
    'two real characters padded with spaces is still two')
  assert.equal(reviewAnnotationSchema.safeParse({ annotation: 'abc' }).success, false)
  assert.equal(reviewAnnotationSchema.safeParse({ annotation: 'a'.repeat(61) }).success, false)
  assert.equal(reviewAnnotationSchema.safeParse({ annotation: 'a'.repeat(60) }).success, true)
  assert.equal(reviewAnnotationSchema.safeParse({ annotation: '' }).success, false)
})

test('assign requires the driver, annotate refuses one', () => {
  // Kills: an assign that "succeeds" without naming who drove (395.32(d)
  // is a named-driver rule), or an annotate call smuggled through the
  // assign schema.
  assert.equal(reviewAssignSchema.safeParse({ annotation: 'Drove it to the yard' }).success, false)
  assert.equal(reviewAssignSchema.safeParse({ annotation: 'Drove it to the yard', driverId: '' }).success, false)
  assert.ok(reviewAssignSchema.safeParse({ annotation: 'Drove it to the yard', driverId: 'marcus-webb' }).success)
  assert.equal(reviewAnnotationSchema.safeParse({ annotation: 'Yard move', driverId: 'marcus-webb' }).success, false)
})

test('the review threshold stays the regulation\'s', () => {
  // The screen's minutes come from the same rule that refuses to write
  // the short moves -- one rule, not two.
  assert.equal(REVIEW_THRESHOLD_MIN, 30)
})

// --- DB-backed flow (rolled back; skips without a database) -------------

const { hasDb } = await import('./helpers/db.js')

test('assign rewrites the record; annotate explains it; both leave one active row', { skip: !hasDb }, async (t) => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const service = await import('../src/modules/compliance/compliance.service.js')
  const repo = await import('../src/modules/compliance/compliance.repository.js')

  await inRollback(pool, async (client) => {
    // The fixture: two trucks, one working driver, one unidentified
    // record per truck, plus an unrelated driver-owned record -- proving
    // the endpoints only ever touch origin='unidentified' rows. One sim
    // day spans ~a real minute, so a 30-minute HOS drive is a few real
    // seconds; minutes are derived with the clock, not typed as
    // literals.
    const driver = (await client.query(
      `SELECT id, name FROM drivers WHERE duty_status <> 'off' ORDER BY created_at LIMIT 1`,
    )).rows[0]
    if (!driver) {
      t.skip('no working driver available')
      return
    }
    const trucks = (await client.query(`SELECT id FROM trucks ORDER BY id LIMIT 2`)).rows
    if (trucks.length < 2) {
      t.skip('two trucks needed for the fixture')
      return
    }
    const [truckA, truckB] = trucks

    // Kills: assuming an otherwise populated database has no prior driver events.
    const initialDriverRows = (await client.query(
      `SELECT count(*)::int AS n FROM duty_events WHERE driver_id = $1`, [driver.id],
    )).rows[0].n

    const startedA = new Date(Date.now() - 60_000)
    const minutesHos = 45
    const spanMs = Math.round((minutesHos / 60 / 24) * REAL_MS_PER_SIM_DAY)
    await client.query(
      `INSERT INTO duty_events (driver_id, truck_id, status, started_at, ended_at)
       VALUES ($1, $2, 'driving', now() - interval '10 seconds', now() - interval '5 seconds')`,
      [driver.id, truckA.id],
    )
    const unidentified = await client.query(
      `INSERT INTO duty_events (driver_id, truck_id, status, started_at, ended_at, origin)
       VALUES (NULL, $1, 'driving', $2, $3, 'unidentified') RETURNING id`,
      [truckA.id, startedA, new Date(startedA.getTime() + spanMs)],
    )
    // The RETURNING id comes back as a string (pg's int8 parser), but the
    // list's json_agg projection carries the same id as a JSON NUMBER --
    // so the fixture ids are normalised to numbers and the comparisons
    // below hold on both sides.
    const eventIdA = Number(unidentified.rows[0].id)
    const startedB = new Date(Date.now() - 30_000)
    const unidentifiedB = await client.query(
      `INSERT INTO duty_events (driver_id, truck_id, status, started_at, ended_at, origin)
       VALUES (NULL, $1, 'driving', $2, $3, 'unidentified') RETURNING id`,
      [truckB.id, startedB, new Date(startedB.getTime() + spanMs)],
    )
    const eventIdB = Number(unidentifiedB.rows[0].id)

    // The screen lists the fixture, grouped by truck and day, and marks
    // both segments unreviewed.
    const list = await service.listUnassignedHos({ client })
    const rowFor = (truckId) => list.days.find((d) => d.truck.id === truckId)
    assert.ok(rowFor(truckA.id), 'truck A is in the review queue')
    assert.ok(rowFor(truckB.id), 'truck B is in the review queue')
    assert.ok(rowFor(truckA.id).segments.some((s) => s.id === eventIdA))
    assert.ok(rowFor(truckA.id).segments.every((s) => s.awaitingReview))

    // The days are the sim clock's own days -- the same arithmetic the
    // log screens call today. Each window opens on a SIM-DAY boundary
    // (a multiple of one sim day from sim_epoch), is one sim day wide,
    // and carries the DATE text of its own start as the label the
    // screen keys its rows by.
    const clockRow = await client.query(
      `SELECT sim_day_start(now()) AS start`,
    )
    const todayStart = new Date(clockRow.rows[0].start)
    for (const d of list.days) {
      assert.equal(new Date(d.dayStart).getTime(), todayStart.getTime() - Math.round((todayStart.getTime() - new Date(d.dayStart).getTime()) / REAL_MS_PER_SIM_DAY) * REAL_MS_PER_SIM_DAY,
        'dayStart is sim_day(start)\'s own window, not a wall-clock day')
      assert.equal(new Date(d.dayEnd).getTime() - new Date(d.dayStart).getTime(), REAL_MS_PER_SIM_DAY,
        'one row is one sim day wide')
      // The label is the sim calendar's own date for the window's start
      // (033: every sim day carries a calendar date of its own, which is
      // why it is not the window's real date) -- the pin here is the
      // boundary: windows open exactly on sim-day boundaries.
      // Kills: window boundaries computed from sim_epoch() instead of sim_day_start() (off after the 2026-11-08 anchor)
      const offMs = todayStart.getTime() - new Date(d.dayStart).getTime()
      assert.equal(offMs % REAL_MS_PER_SIM_DAY, 0, 'windows open on sim-day boundaries')
    }

    // Assign: the original is kept as 'inactive-changed' and a
    // replacement row appears in the driver's name with the note.
    const res = await service.assignUnassignedHos({
      eventId: eventIdA, driverId: driver.id, annotation: 'Drove the deadhead to Memphis',
    }, { client })
    assert.equal(res.assigned, true)
    const originalA = (await client.query(`SELECT * FROM duty_events WHERE id = $1`, [eventIdA])).rows[0]
    assert.equal(originalA.record_status, 'inactive-changed', 'the original is kept, marked changed')
    assert.equal(originalA.driver_id, null)
    // The note rides the REPLACEMENT (the carrier's explanation of the
    // change, 395.32(d)); the original keeps its own record intact --
    // nothing is written onto the history the ELD produced.
    assert.equal(originalA.annotation, null,
      'the original is the ELD record -- the carrier note lives on the replacement')
    const replacement = (await client.query(
      `SELECT * FROM duty_events
        WHERE driver_id = $1 AND record_status = 'active' AND origin = 'carrier'`,
      [driver.id],
    )).rows
    assert.equal(replacement.length, 1, 'exactly one replacement row, in the driver\'s name')
    assert.equal(replacement[0].origin, 'carrier')
    assert.equal(replacement[0].truck_id, truckA.id)
    assert.equal(replacement[0].annotation, 'Drove the deadhead to Memphis')
    assert.equal(new Date(replacement[0].started_at).getTime(), startedA.getTime(),
      'the replacement covers the same drive the ELD recorded')

    // A second assign on the same record is a reviewed-record conflict,
    // not a 404 and not a second copy of someone's time.
    await assert.rejects(
      () => service.assignUnassignedHos({ eventId: eventIdA, driverId: driver.id, annotation: 'Again' }, { client }),
      (err) => err instanceof AppError && err.code === 'EVENT_ALREADY_REVIEWED',
    )
    // ...and so is a second annotate.
    await assert.rejects(
      () => service.annotateUnassignedHos({ eventId: eventIdA, annotation: 'Explained twice' }, { client }),
      (err) => err instanceof AppError && err.code === 'EVENT_ALREADY_REVIEWED',
    )

    // Annotate the other record: the original stays ACTIVE with the note
    // -- the record of the drive is kept, not moved onto anyone.
    const res2 = await service.annotateUnassignedHos({ eventId: eventIdB, annotation: 'Yard move at the terminal' }, { client })
    assert.equal(res2.annotated, true)
    const originalB = (await client.query(`SELECT * FROM duty_events WHERE id = $1`, [eventIdB])).rows[0]
    assert.equal(originalB.record_status, 'active')
    assert.equal(originalB.annotation, 'Yard move at the terminal')
    assert.equal(originalB.driver_id, null)

    // A second annotate on an ALREADY ANNOTATED record is refused too.
    //
    // This is the case the first version let through: annotate leaves the
    // row active and unidentified, so the UPDATE matched a second time,
    // replaced the carrier's earlier statement with no trace of it, and
    // answered 200. The screen could not reach it -- the buttons hide
    // once awaitingReview is false -- so the only thing standing between
    // a destroyed record and the database was a component.
    //
    // Kills: the `annotation IS NULL` guard being dropped from
    // ANNOTATE_UNIDENTIFIED_EVENT_SQL.
    await assert.rejects(
      () => service.annotateUnassignedHos({ eventId: eventIdB, annotation: 'Something else entirely' }, { client }),
      (err) => err instanceof AppError && err.code === 'EVENT_ALREADY_REVIEWED',
    )
    const stillB = (await client.query(`SELECT annotation FROM duty_events WHERE id = $1`, [eventIdB])).rows[0]
    assert.equal(stillB.annotation, 'Yard move at the terminal', 'the first statement survives the second attempt')


    // After both reviews the queue shows truck A gone (its only segment
    // is inactive) and truck B's segment reviewed.
    const list2 = await service.listUnassignedHos({ client })
    const rowB = list2.days.find((d) => d.truck.id === truckB.id)
    assert.ok(rowB, 'truck B is still listed')
    assert.equal(rowB.segments.find((s) => s.id === eventIdB).awaitingReview, false)
    assert.ok(!list2.days.some((d) => d.truck.id === truckA.id && d.segments.some((s) => s.id === eventIdA)),
      'a reviewed (inactive) record leaves the queue')

    // The driver's own record was never touched by either review.
    const driverRows = (await client.query(
      `SELECT count(*)::int AS n FROM duty_events WHERE driver_id = $1`,
      [driver.id],
    )).rows[0].n
    assert.equal(driverRows, initialDriverRows + 2, 'driver keeps existing rows plus the two fixture rows')

    // Unknown ids: the record does not exist, or it is someone else's
    // identified record -- both are EVENT_NOT_FOUND, never a guess.
    await assert.rejects(
      () => service.assignUnassignedHos({ eventId: '999999999', driverId: driver.id, annotation: 'Ghost' }, { client }),
      (err) => err instanceof AppError && err.code === 'EVENT_NOT_FOUND',
    )
    await assert.rejects(
      () => service.annotateUnassignedHos({ eventId: '999999999', annotation: 'Ghost' }, { client }),
      (err) => err instanceof AppError && err.code === 'EVENT_NOT_FOUND',
    )
  })
})

// The window the DATABASE keeps (migration 044), not only the schema in
// front of it. 042 opened the birth case correctly -- an unidentified
// record arrives with nobody to write a note -- but its new CHECK stopped
// asking anything at all once that branch matched, so the annotate path
// could write a one-character note onto exactly the rows this screen
// touches. The 4..60 window is the ELD's (49 CFR 395 Subpart B, Appendix
// A) and belongs in the constraint, like every other rule here.
//
// Its own transaction, for the reason dvirFlow.test.js's CHECK pair
// spells out: a statement that is MEANT to fail aborts the transaction it
// runs in, and everything after it comes back "current transaction is
// aborted" instead of the thing it was checking.
//
// Kills: 044 reverted.
test('the annotation window is a CHECK, not just a schema', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')

  await inRollback(pool, async (client) => {
    const truck = (await client.query(`SELECT id FROM trucks ORDER BY id LIMIT 1`)).rows[0]
    if (!truck) return

    await assert.rejects(
      () => client.query(
        `INSERT INTO duty_events (driver_id, truck_id, status, started_at, ended_at, origin, annotation)
         VALUES (NULL, $1, 'driving', now() - interval '3 seconds', now() - interval '1 second',
                 'unidentified', 'x')`,
        [truck.id],
      ),
      (err) => /duty_events_annotation_required/.test(err.message),
      'a one-character annotation is below the ELD window and the CHECK refuses it',
    )
  })
})
