// The fixture for dispatchCheck's tests: a load + driver built IN THE
// ROLLBACK, never picked from the seed. A seed that happens to leave no
// neutral load, no un-DQ'd driver, or no trucked driver turned three of
// these tests into silent passes -- the pre-trip work found them reading
// zero rows and returning early, and their assertions never ran.
//
// Every INSERT satisfies the schema the seed does:
//   loads    -- 006/007 (numeric id, NULL dispatch pair, weight/equipment
//               NOT NULL, rate within the band, pickup < delivery);
//   drivers  -- 005  (id follows the demo fleet's d<n> shape AND its
//               drivers_id_format CHECK: ^d[0-9]{1,4}$, so the fixture id
//               stays inside d1000..d9999, above the seed's d1..d13);
//   trucks   -- 006  (the id IS the plate, ^[A-Z]{2}-[0-9]{4}-[A-Z]{2}$,
//               'active' because it carries a driver);
//   driver_qualification -- 039, values the service reads back 'valid'
//               (medical and license far out, MVR pulled 60 SIM days ago
//               -- the reader ages documents on the sim calendar, 2 real
//               minutes per day, so a fixture written in real days would
//               read 144,000 sim days old and come back 'expired').
// withTruck (default true) assigns a fleet truck by writing
// trucks.driver_id -- the same writer the truck market uses, undone by
// the rollback.
export async function makeCheckFixture(client, { withTruck = true } = {}) {
  const n = Date.now() % 1000000
  const loadId = String(n).padStart(6, '0')
  const driverId = `d${1000 + (n % 9000)}`
  // The plate's middle block is exactly four digits -- pad AND trim.
  const truckId = `FX-${String(n % 10000).padStart(4, '0')}-TX`
  const email = `${driverId}@fixture.test`
  const cdlNumber = `FX${n}`

  await client.query(
    `INSERT INTO loads (id, broker, rate_usd, distance_mi, origin_city, origin_state,
       destination_city, destination_state, payment_terms, status, pickup_at, delivery_at,
       weight_lbs, equipment_type, equipment_length_ft, booked_at)
     VALUES ($1, 'Check Fixture Broker', 2200, 480, 'Dallas', 'TX', 'Memphis', 'TN', 'net30', 'neutral',
       now() + interval '120 seconds', now() + interval '240 seconds',
       30000, 'dry-van', 53, now())`,
    [loadId],
  )

  await client.query(
    `INSERT INTO drivers (id, name, email, phone, cdl_class, cdl_number, license_expires_on,
       home_base_city, home_base_state, duty_status, hos_remaining_min, pay_model, pay_percent_bp)
     VALUES ($1, 'Check Fixture Driver', $2, '555-0100', 'A', $3,
       CURRENT_DATE + 200, 'Dallas', 'TX', 'resting', 660, 'percent', 2700)`,
    [driverId, email, cdlNumber],
  )

  if (withTruck) {
    // Gauges the PTI model reads clean: tires far above the defect
    // threshold. Service dues live in maintenance_records (008), not on
    // the truck, so a fixture with no rows there reads no interval at
    // all -- the same nothing a freshly bought truck reads.
    await client.query(
      `INSERT INTO trucks (id, make, model, year, status, odometer_mi,
                           tire_front_pct, tire_rear_pct, fuel_pct, fuel_gallons,
                           fuel_capacity_gal, driver_id)
       VALUES ($1, 'Freightliner', 'Cascadia', 2021, 'active', 240000,
               85, 82, 80, 160, 200, $2)`,
      [truckId, driverId],
    )
  }

  await client.query(
    `INSERT INTO driver_qualification (driver_id, cdl_status, medical_expires_on, medical_status,
                                       mvr_checked_on, mvr_violations, mvr_status, da_status)
     VALUES ($1, 'valid', CURRENT_DATE + 200, 'valid',
             now() - interval '2 hours', 0, 'valid', 'valid')`,
    [driverId],
  )

  return { loadId, driverId, truckId: withTruck ? truckId : null }
}
