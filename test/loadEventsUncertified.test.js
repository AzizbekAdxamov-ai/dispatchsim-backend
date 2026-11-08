// Stage 5 of the pre-trip plan: the consequence. A truck sent out with
// defects nobody certified as fixed (396.13(b)(2)) always meets a
// breakdown -- the SAME shape serviceOverdue already had, no new
// probability anywhere. The tests are about outcomes: the rule's shape
// (pure), and the flag's life cycle on the row the tick actually reads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'

import { EVENT_KEYS, EVENT_TYPES } from '../src/constants/loadEvents.js'
import { seeded } from './helpers/rng.js'

const { hasDb } = await import('./helpers/db.js')

const { eventTypeFor } = await import('../src/modules/loadEvents/loadEvents.service.js')

test('either named state meets a breakdown, and both together are still one breakdown', () => {
  // Kills: a second probability layered onto the state (a die roll wearing
  // a regulation's clothes) -- the flag is a decision, not a chance. Also
  // kills an OR that dropped to an exclusive one.
  const rng = seeded(1)
  for (const flag of ['serviceOverdue', 'uncertifiedDefect']) {
    assert.equal(eventTypeFor({ [flag]: true }, rng), 'breakdown', flag)
  }
  assert.equal(eventTypeFor({ serviceOverdue: true, uncertifiedDefect: true }, rng), 'breakdown',
    'both flags are one breakdown, not two rolls')
})

test('a clean load keeps the weighted mix the board teaches', () => {
  // Kills: a rule inverted into breakdown-by-default, which would empty
  // the event catalogue for every honest truck.
  const rng = seeded(7)
  const seen = new Set()
  for (let i = 0; i < 5000; i += 1) seen.add(eventTypeFor({}, rng))
  assert.equal(seen.size, EVENT_KEYS.filter((k) => EVENT_TYPES[k].weight > 0).length, 'every drawable type still reachable for a clean load')
})

test('the flag rides the row the tick reads, and only the certify write clears it', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const repo = await import('../src/modules/loadEvents/loadEvents.repository.js')
  const dvirRepo = await import('../src/modules/fleet/dvir.repository.js')
  const { buildReportRow } = await import('../src/modules/fleet/dvir.service.js')

  await inRollback(pool, async (client) => {
    const n = Date.now() % 10000
    const truckId = `UE-${String(n).padStart(4, '0')}-TX`
    await client.query(
      `INSERT INTO trucks (id, make, model, year, status, odometer_mi,
                           tire_front_pct, tire_rear_pct, fuel_pct, fuel_gallons)
       VALUES ($1, 'Kenworth', 'T680', 2020, 'idle', 100000, 80, 80, 70, 150)`,
      [truckId],
    )

    // An uncertified small item, written EXACTLY as the delivery
    // transaction writes it: the pinned roll fails one small item and the
    // row carries the defect list with the correction flag false.
    const row = buildReportRow({
      rng: () => 0,
      truck: { id: truckId, odometerMi: 100000, tireFrontPct: 80, tireRearPct: 80 },
      driverId: null, loadId: null, locationLabel: null, hadBreakdown: false,
    })
    assert.ok(
      !row.hornOk || !row.wipersOk || !row.mirrorsOk || !row.emergencyEqOk,
      'seed setup: the pinned roll failed one small item',
    )
    const written = await dvirRepo.insertReport(client, row)

    // A load that could meet something, in transit on that truck.
    const loadId = String(Date.now() % 1000000).padStart(6, '0')
    await client.query(
      `INSERT INTO loads (id, broker, rate_usd, distance_mi, origin_city, origin_state,
         destination_city, destination_state, payment_terms, status, driver_id, truck_id,
         pickup_at, delivery_at, dispatched_at, eta_at,
         weight_lbs, equipment_type, equipment_length_ft, booked_at)
       VALUES ($1, 'UE Fixture Broker', 1200, 300, 'Dallas', 'TX', 'Tulsa', 'OK', 'net30',
         'ontime', NULL, $2,
         now() - interval '60 seconds', now() + interval '60 seconds',
         now() - interval '60 seconds', now() + interval '60 seconds',
         24000, 'dry-van', 53, now() - interval '120 seconds')`,
      [loadId, truckId],
    )

    const loads = await repo.inTransitLoads(client, 50)
    const mine = loads.find((l) => l.id === loadId)
    assert.ok(mine, 'the in-transit fixture rides the tick read')
    assert.equal(mine.uncertifiedDefect, true, 'the defect nobody certified is a named fact on the read')

    // The ONLY thing that clears the flag is the certify write (040/041) --
    // an OR that read "any defects ever" would stay true here, and every
    // fixed-and-signed truck in the fleet would break down forever.
    await dvirRepo.certify(client, { reportId: written.id, driverId: null })
    const after = (await repo.inTransitLoads(client, 50)).find((l) => l.id === loadId)
    assert.equal(after.uncertifiedDefect, false, 'certify is what cleared it')

    // A fresh CLEAN report arrives after the certify (the truck ran again,
    // the walk-around found nothing). 396.13(b)(2) reads the LAST report,
    // so the consequence reads the last report too -- a flag stuck on the
    // old defect would hold a legally clean truck guilty forever.
    // Kills: an EXISTS that scanned every report instead of the newest one.
    await dvirRepo.insertReport(client, buildReportRow({
      rng: () => 1, // every die survives: a clean report
      truck: { id: truckId, odometerMi: 100300, tireFrontPct: 80, tireRearPct: 80 },
      driverId: null, loadId: null, locationLabel: null, hadBreakdown: false,
    }))
    const newest = (await repo.inTransitLoads(client, 50)).find((l) => l.id === loadId)
    assert.equal(newest.uncertifiedDefect, false, 'the last report is the one the law reads')

    // The truck runs again and the walk-around fails another small item --
    // a NEW uncertified defect re-arms the flag. Kills a read anchored to
    // the OLDEST report: the oldest one is clean-and-certified by now, and
    // a truck breaking down from a defect it never wrote would be a rule
    // reading history backwards.
    await dvirRepo.insertReport(client, buildReportRow({
      rng: () => 0,
      truck: { id: truckId, odometerMi: 100600, tireFrontPct: 80, tireRearPct: 80 },
      driverId: null, loadId: null, locationLabel: null, hadBreakdown: false,
    }))
    const rearmed = (await repo.inTransitLoads(client, 50)).find((l) => l.id === loadId)
    assert.equal(rearmed.uncertifiedDefect, true, 'a new uncertified defect re-arms the consequence')
  })
})
