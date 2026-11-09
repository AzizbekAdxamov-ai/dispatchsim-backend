import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'

// These cases run the real service and PostgreSQL transactions, exclusively
// against connection-private tables/sequences. No company fixture is committed.
process.env.FINANCE = 'off'
const { pool } = await import('../src/db/pool.js')
const { hireApplicant } = await import('../src/modules/hr/hr.service.js')
const { runBackfill, parseArgs } = await import('../scripts/backfill-hired-driver-profiles.js')
const { buildDriverPersona } = await import('../src/modules/hr/driverPersona.js')
const { getApplicantById, insertDriver } = await import('../src/modules/hr/hr.repository.js')
const { hasDb } = await import('./helpers/db.js')

const FIRST_APPLICANT = 'a910001'
const SECOND_APPLICANT = 'a910002'
const FIRST_DRIVER = 'd9100'
const SECOND_DRIVER = 'd9101'
const PROVISION_DRIVER = 'd9199'
const DRIVER_SEQUENCE_START = 9100
const FIXTURE_PAY_CENTS = 63
const FIXTURE_EXPERIENCE = 7
const FIXTURE_MVR_VIOLATIONS = 2
const USER_ID = null
const TABLES = ['drivers', 'driver_applicants', 'driver_qualification', 'cash_ledger']

async function isolatedDatabase(t, fn) {
  const hostname = new URL(process.env.DATABASE_URL).hostname
  assert.ok(['localhost', '127.0.0.1'].includes(hostname), 'HR fixture writes are local-only')
  const client = await pool.connect()
  try {
    for (const table of TABLES) await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`)
    await client.query(`CREATE TEMP SEQUENCE hired_driver_id_seq START ${DRIVER_SEQUENCE_START}`)
    await client.query('CREATE TEMP SEQUENCE hr_fixture_ledger_seq')
    await client.query("ALTER TABLE cash_ledger ALTER COLUMN id SET DEFAULT nextval('pg_temp.hr_fixture_ledger_seq')")
    // Explicit pg_temp first also prevents the public hired-driver sequence
    // from being consumed by a successful service transaction.
    await client.query('SET search_path TO pg_temp, public')
    const wrapped = { query: client.query.bind(client), release() {} }
    t.mock.method(pool, 'connect', async () => wrapped)
    t.mock.method(pool, 'query', client.query.bind(client))
    await fn(client)
  } finally {
    t.mock.restoreAll()
    // Destroy this physical connection: its private tables vanish together.
    client.release(true)
  }
}

async function applicant(client, id = FIRST_APPLICANT) {
  await client.query(
    `INSERT INTO driver_applicants
       (id, full_name, email, phone, cdl_class, cdl_state, license_expires_on,
        years_experience, home_base_city, home_base_state, desired_equipment,
        mvr_violations, desired_pay_model, desired_pay_per_mile_cents,
        available_from, posted_at, expires_at)
     VALUES ($1, 'Morgan Rivera', $2, '555-0100', 'A', 'TX', CURRENT_DATE + INTERVAL '1 year',
        $3, 'Dallas', 'TX', 'reefer', $4, 'permile', $5,
        now(), now() - INTERVAL '1 day', now() + INTERVAL '1 day')`,
    [id, `${id}@example.com`, FIXTURE_EXPERIENCE, FIXTURE_MVR_VIOLATIONS, FIXTURE_PAY_CENTS],
  )
}

test('hire persists persona, location, DQ and charge in the same transaction', { skip: !hasDb }, async (t) => {
  // Kills: dropping bio/current_location, omitting DQ, or resetting MVR violations.
  await isolatedDatabase(t, async (client) => {
    await applicant(client)
    const source = await getApplicantById(FIRST_APPLICANT)
    const result = await hireApplicant({ applicantId: FIRST_APPLICANT, userId: USER_ID })
    assert.equal(result.driver.id, FIRST_DRIVER)
    const { rows: [driver] } = await client.query('SELECT bio, current_location, preferences FROM drivers WHERE id = $1', [FIRST_DRIVER])
    assert.equal(driver.bio, buildDriverPersona(source).bio)
    assert.equal(driver.current_location, 'Dallas, TX')
    assert.deepEqual(driver.preferences, {})
    const { rows: [dq] } = await client.query('SELECT *, mvr_checked_on = CURRENT_DATE AS fresh FROM driver_qualification WHERE driver_id = $1', [FIRST_DRIVER])
    assert.ok(dq, 'DQ row exists')
    assert.equal(dq.da_status, 'valid')
    assert.equal(dq.mvr_violations, FIXTURE_MVR_VIOLATIONS)
    assert.equal(dq.fresh, true)
    assert.equal(dq.medical_expires_on, null)
    assert.equal((await client.query('SELECT count(*)::int AS count FROM cash_ledger')).rows[0].count, 1)
  })
})

test('late applicant failure rolls back driver, DQ and onboarding charge', { skip: !hasDb }, async (t) => {
  // Kills: committing the transaction on an application error after all inserts.
  await isolatedDatabase(t, async (client) => {
    await applicant(client)
    await client.query(`CREATE FUNCTION pg_temp.skip_hire_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`)
    await client.query('CREATE TRIGGER skip_hire_update BEFORE UPDATE ON driver_applicants FOR EACH ROW EXECUTE FUNCTION pg_temp.skip_hire_update()')
    await assert.rejects(hireApplicant({ applicantId: FIRST_APPLICANT, userId: USER_ID }), { code: 'INTERNAL_ERROR' })
    for (const table of ['drivers', 'driver_qualification', 'cash_ledger']) {
      assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0, table)
    }
    assert.equal((await getApplicantById(FIRST_APPLICANT)).status, 'open')
  })
})

test('DQ insertion failure leaves no hired driver or onboarding debit', { skip: !hasDb }, async (t) => {
  // Kills: swallowing a DQ insert failure or moving it outside the hire transaction.
  await isolatedDatabase(t, async (client) => {
    await applicant(client)
    await client.query("ALTER TABLE driver_qualification ADD CONSTRAINT forced_dq_failure CHECK (da_status <> 'valid')")
    await assert.rejects(hireApplicant({ applicantId: FIRST_APPLICANT, userId: USER_ID }), { code: '23514' })
    for (const table of ['drivers', 'driver_qualification', 'cash_ledger']) {
      assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0, table)
    }
  })
})

test('backfill defaults to readonly, preserves profiles/DQ and is idempotent', { skip: !hasDb }, async (t) => {
  // Kills: dry-run writes, overwriting DQ/location/preferences, or repeat rewrites.
  await isolatedDatabase(t, async (client) => {
    await applicant(client)
    await applicant(client, SECOND_APPLICANT)
    await hireApplicant({ applicantId: FIRST_APPLICANT, userId: USER_ID })
    await hireApplicant({ applicantId: SECOND_APPLICANT, userId: USER_ID })
    await client.query("UPDATE drivers SET bio = ' ', current_city = 'Austin', current_location = NULL WHERE id = $1", [FIRST_DRIVER])
    await client.query("UPDATE drivers SET bio = NULL, current_location = 'At customer yard', preferences = $2 WHERE id = $1", [SECOND_DRIVER, { avoidStates: ['NJ'] }])
    await client.query("UPDATE driver_qualification SET da_status = 'expired' WHERE driver_id = $1", [SECOND_DRIVER])
    // Remove just the private fixture DQ row to represent a historical HR hire.
    await client.query('DELETE FROM driver_qualification WHERE driver_id = $1', [FIRST_DRIVER])
    const preview = await runBackfill({ client })
    assert.equal(preview.count, 2)
    assert.equal((await client.query('SELECT bio FROM drivers WHERE id = $1', [FIRST_DRIVER])).rows[0].bio, ' ')
    const applied = await runBackfill({ client, confirm: true })
    assert.equal(applied.count, 2)
    const { rows } = await client.query('SELECT id, bio, current_location, preferences FROM drivers ORDER BY id')
    const first = rows.find((r) => r.id === FIRST_DRIVER)
    const second = rows.find((r) => r.id === SECOND_DRIVER)
    assert.ok(first.bio.trim())
    assert.equal(first.current_location, 'Austin, TX', 'uses driver location, not home base')
    assert.equal(second.current_location, 'At customer yard')
    assert.deepEqual(second.preferences, { avoidStates: ['NJ'] })
    const dq = (await client.query('SELECT driver_id, da_status FROM driver_qualification ORDER BY driver_id')).rows
    assert.equal(dq.find((r) => r.driver_id === FIRST_DRIVER).da_status, 'valid')
    assert.equal(dq.find((r) => r.driver_id === SECOND_DRIVER).da_status, 'expired')
    assert.equal((await runBackfill({ client, confirm: true })).count, 0)
  })
})

test('backfill excludes drivers without a hired applicant link and populated bios', { skip: !hasDb }, async (t) => {
  // Kills: removing the HR link/status or blank-bio filter.
  await isolatedDatabase(t, async (client) => {
    await applicant(client)
    await applicant(client, SECOND_APPLICANT)
    await hireApplicant({ applicantId: FIRST_APPLICANT, userId: USER_ID })
    await hireApplicant({ applicantId: SECOND_APPLICANT, userId: USER_ID })
    await client.query('DELETE FROM driver_applicants WHERE id = $1', [FIRST_APPLICANT])
    await client.query('UPDATE drivers SET bio = NULL WHERE id = $1', [FIRST_DRIVER])
    assert.equal((await runBackfill({ client, confirm: true })).count, 0)
    assert.equal((await client.query('SELECT bio FROM drivers WHERE id = $1', [FIRST_DRIVER])).rows[0].bio, null)
  })
})

test('driver insert without a persona still stores an empty preference set', { skip: !hasDb }, async (t) => {
  // Kills: JSON.stringify(undefined) reaching the NOT NULL preferences column,
  // which would break scripts/provision-ethan.js at --apply.
  await isolatedDatabase(t, async (client) => {
    await insertDriver(client, {
      id: PROVISION_DRIVER, name: 'Provision Fixture', email: 'provision.fixture@example.com',
      phone: '555-0199', cdlClass: 'A', cdlNumber: 'FIX-9199', licenseExpiresOn: '2029-08-31',
      homeBaseCity: 'Chicago', homeBaseState: 'IL', dutyStatus: 'on-duty',
      payModel: 'permile', payPercentBp: null, payPerMileCents: FIXTURE_PAY_CENTS,
      currentCity: 'Chicago', currentState: 'IL', currentLat: 41.8781, currentLon: -87.6298,
    })
    const { rows: [driver] } = await client.query('SELECT preferences FROM drivers WHERE id = $1', [PROVISION_DRIVER])
    assert.deepEqual(driver.preferences, {})
  })
})

test('backfill flags cannot accidentally opt into writing', () => {
  // Kills: default confirm=true or accepting contradictory/unknown switches.
  assert.equal(parseArgs([]).confirm, false)
  assert.equal(parseArgs(['--confirm']).confirm, true)
  assert.throws(() => parseArgs(['--confirm', '--dry-run']))
  assert.throws(() => parseArgs(['--force']))
})
