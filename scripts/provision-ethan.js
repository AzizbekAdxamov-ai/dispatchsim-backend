// One explicitly requested fleet addition. Preview is read-only by default;
// --apply creates the pair atomically, without a purchase or payroll entry.
import { pathToFileURL } from 'node:url'
import { nextDriverId, insertDriver } from '../src/modules/hr/hr.repository.js'

export const SETUP = Object.freeze({
  postingId: 'e5a97272-a983-4d42-a40d-0f131093f310',
  name: 'Ethan Brooks', email: 'ethan.brooks@example.com', phone: '312-555-0148',
  cdlNumber: 'IL-B620-4178-2951', licenseExpiresOn: '2029-08-31',
  city: 'Chicago', state: 'IL', lat: 41.8781, lon: -87.6298,
  truckId: 'IL-2048-EB', trailerType: 'dry-van', trailerLengthFt: 53,
  bio: 'Ethan is a native English speaker from the American Midwest, in his early forties, with a decade behind the wheel. He texts in plain, natural American English: calm, brief, and friendly, with an occasional dry joke. He likes baseball and fixing old radios. He is patient with clear instructions, asks a direct question when details are missing, and pushes back politely when someone rushes him. He never fills a gap with a confident guess.',
})

export async function provisionEthan(client, { apply = false } = {}) {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    // Serialise reruns before checking the unique identity: no duplicate pair
    // and no resetting somebody's hours/location after they have started work.
    if (apply) await client.query("SELECT pg_advisory_xact_lock(hashtext('provision-ethan-brooks'))")
    const existing = await client.query(
      `SELECT d.id, d.name, d.email, d.cdl_number AS "cdlNumber", t.id AS "truckId",
              t.trailer_type AS "trailerType",
              (to_jsonb(t)->>'trailer_length_ft')::int AS "trailerLengthFt"
         FROM drivers d LEFT JOIN trucks t ON t.driver_id = d.id
        WHERE d.email = $1 OR d.cdl_number = $2`,
      [SETUP.email, SETUP.cdlNumber],
    )
    if (existing.rows.length > 0) {
      const row = existing.rows[0]
      if (existing.rows.length !== 1 || row.email !== SETUP.email || row.name !== SETUP.name
        || row.cdlNumber !== SETUP.cdlNumber || row.truckId !== SETUP.truckId
        || row.trailerType !== SETUP.trailerType || row.trailerLengthFt !== SETUP.trailerLengthFt) {
        throw new Error('Existing identity differs from the requested driver/truck pair; nothing changed.')
      }
      await client.query('COMMIT')
      return { action: 'already-exists', driver: row }
    }
    const collision = await client.query('SELECT id FROM trucks WHERE id = $1', [SETUP.truckId])
    if (collision.rows.length) throw new Error('Requested truck plate already exists; nothing changed.')
    // Recheck the actual board at execution time. This does not book, extend,
    // or otherwise alter the posting, and refuses a stale/mismatched target.
    const posting = await client.query(
      `SELECT id, origin_city AS "originCity", origin_state AS "originState",
              destination_city AS "destinationCity", destination_state AS "destinationState",
              broker, commodity, equipment_type AS "equipmentType",
              equipment_length_ft AS "equipmentLengthFt", pickup_at AS "pickupAt",
              delivery_at AS "deliveryAt", expires_at AS "expiresAt",
              round(road_miles($2, $3, origin_lat, origin_lon))::int AS "deadheadMi"
         FROM load_postings
        WHERE id = $1 AND status = 'open' AND posted_at <= now()
          AND expires_at > now() AND pickup_at > now() + interval '12 hours'
          AND equipment_type = $4 AND equipment_length_ft <= $5`,
      [SETUP.postingId, SETUP.lat, SETUP.lon, SETUP.trailerType, SETUP.trailerLengthFt],
    )
    const load = posting.rows[0]
    if (!load || load.deadheadMi < 80 || load.deadheadMi > 110) {
      throw new Error('Target posting is unavailable or no longer fits the equipment/deadhead window; nothing changed.')
    }
    const counts = await client.query(
      `SELECT equipment_type AS "equipmentType", count(*)::int AS count
         FROM load_postings WHERE status = 'open' AND posted_at <= now() AND expires_at > now()
        GROUP BY equipment_type ORDER BY count(*) DESC, equipment_type`,
    )
    if (counts.rows[0]?.equipmentType !== SETUP.trailerType) {
      throw new Error('Dry van is no longer the most common active equipment; review the setup before applying.')
    }
    const preview = {
      driver: { ...SETUP, dutyStatus: 'on-duty', hosRemainingMin: 660, hoursTodayMin: 0, hoursWeekMin: 0, payModel: 'permile', payPerMileCents: 65 },
      truck: { id: SETUP.truckId, make: 'Freightliner', model: 'Cascadia', year: 2023, status: 'active', trailerType: SETUP.trailerType, trailerLengthFt: SETUP.trailerLengthFt, fuelGallons: 240, fuelCapacityGal: 240, tireFrontPct: 90, tireRearPct: 90 },
      load, equipmentCounts: counts.rows,
    }
    if (!apply) {
      await client.query('COMMIT')
      return { action: 'preview', ...preview }
    }
    const driverId = await nextDriverId(client)
    await insertDriver(client, {
      id: driverId, name: SETUP.name, email: SETUP.email, phone: SETUP.phone,
      cdlClass: 'A', cdlNumber: SETUP.cdlNumber, licenseExpiresOn: SETUP.licenseExpiresOn,
      homeBaseCity: SETUP.city, homeBaseState: SETUP.state, dutyStatus: 'on-duty',
      payModel: 'permile', payPercentBp: null, payPerMileCents: 65,
      currentCity: SETUP.city, currentState: SETUP.state, currentLat: SETUP.lat, currentLon: SETUP.lon,
    })
    await client.query(
      `UPDATE drivers SET bio = $2, current_location = $3 WHERE id = $1`,
      [driverId, SETUP.bio, `${SETUP.city}, ${SETUP.state}`],
    )
    await client.query(
      `INSERT INTO trucks (id, make, model, year, odometer_mi, status, driver_id,
         current_location, trailer_type, trailer_length_ft, fuel_pct, fuel_gallons,
         fuel_capacity_gal, tire_front_pct, tire_rear_pct, transmission, sleeper,
         suspension, axle_config, front_axle_lbs, rear_axle_lbs, gvwr_lbs, has_apu)
       VALUES ($1, 'Freightliner', 'Cascadia', 2023, 185000, 'active', $2,
         $3, $4, $5, 100, 240, 240, 90, 90, 'automated-12', 'sleeper-72',
         'air-ride', '6x4', 12000, 40000, 52000, true)`,
      [SETUP.truckId, driverId, `${SETUP.city}, ${SETUP.state}`, SETUP.trailerType, SETUP.trailerLengthFt],
    )
    // No duty event is fabricated. The existing HR flow also starts a new
    // driver with an empty log; its HOS snapshot yields a fresh full clock.
    await client.query('COMMIT')
    return { action: 'created', driverId, ...preview }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.some((arg) => !['--apply', '--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('Usage: node scripts/provision-ethan.js [--dry-run | --apply]')
  }
  const { pool } = await import('../src/db/pool.js')
  const client = await pool.connect()
  try {
    console.log(JSON.stringify(await provisionEthan(client, { apply: args.includes('--apply') }), null, 2))
  } finally {
    client.release()
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1 })
}
