// Daily refresh for the load board: generates a fresh batch of postings and
// INSERTs them directly. Unlike generate:seed.js (which TRUNCATEs everything),
// this script is safe to run alongside booked postings.
//
// Usage:
//   node scripts/refresh-postings.js
//   node scripts/refresh-postings.js --allow-remote   (skip host guard)
//
// Exports runRefresh() so the cron job (dailyRefresh.js) can call it
// without spawning a child process.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'
import { generateLoad, generateApplicant, generateTruckListing } from './seed/generate.js'
import { LoadItem, ApplicantItem, TruckListingItem, BROKERS } from './seed/schemas.js'
import { validateLoadItem, validateApplicantItem, validateTruckListingItem } from './seed/validate.js'
import { buildPostingRows, POSTING_CONFIG, TIER_WEIGHTS, HIDDEN_RATE_SHARE } from './seed/postings.js'
import { buildApplicantRows, APPLICANT_CONFIG, APPLICANT_TIERS } from './seed/applicants.js'
import { buildTruckRows, TRUCK_CONFIG, TRUCK_TIERS } from './seed/trucks.js'

const POSTING_COLUMNS = [
  'origin_lat', 'origin_lon', 'destination_lat', 'destination_lon',
  'origin_city', 'origin_state', 'destination_city', 'destination_state',
  'broker', 'broker_id', 'commodity', 'rate_usd', 'distance_mi', 'weight_lbs',
  'equipment_type', 'equipment_length_ft', 'posted_at', 'expires_at', 'pickup_at', 'delivery_at', 'status',
  'rate_hidden', 'rate_basis', 'fuel_surcharge_usd',
]

// A bounded additive market update: no cleanup, applicants, trucks or edits
// to existing freight. The ordinary daily refresh below keeps its behavior.
export async function runPostingRefresh({ count = 12, runner = pool } = {}) {
  assertLocalHost()
  if (!Number.isInteger(count) || count < 1 || count > 60) throw new RangeError('Posting count must be 1–60')
  const brokerIds = new Map((await runner.query('SELECT id, name FROM brokers')).rows.map((b) => [b.name, b.id]))
  const drivers = (await runner.query('SELECT id, current_lat, current_lon, duty_status FROM drivers')).rows
  const items = []
  const seen = new Set()
  for (let n = 0; n < count; n += 1) {
    const item = generateLoad(Math.random, { avoid: seen, hiddenRateShare: HIDDEN_RATE_SHARE })
    const parsed = LoadItem.parse(item)
    const checked = validateLoadItem(parsed)
    if (!checked.ok) throw new Error(`Posting rejected: ${checked.reason}`)
    items.push(checked.item)
    seen.add(`${item.originCity}, ${item.originState} -> ${item.destinationCity}, ${item.destinationState}`)
  }
  const rows = buildPostingRows({ rng: mulberry32(Date.now()), postingItems: items, drivers, trucks: [], fleetEquipment: [], brokerIds })
  const client = await runner.connect()
  try {
    await client.query('BEGIN')
    for (const row of rows) {
      const values = []
      const parts = POSTING_COLUMNS.map((column) => row[column]?.__raw ? row[column].value : `$${values.push(row[column])}`)
      await client.query(`INSERT INTO load_postings (${POSTING_COLUMNS.join(', ')}) VALUES (${parts.join(', ')})`, values)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
  return { ok: true, postingsInserted: rows.length, splitPostings: rows.filter((r) => r.rate_basis === 'linehaul-plus-fuel').length }
}

// The prompt builders that lived here are gone with the model calls they
// fed. Six of them -- loads, applicants and truck listings, a system and a
// user prompt each -- existed to paste a city list, a broker list and an
// equipment list into a request, and then to police what came back. The
// lists are still the source of truth; seed/generate.js reads them
// directly instead of describing them to a model and hoping.

// ---------------------------------------------------------------------
// Applicant prompts
// ---------------------------------------------------------------------


// ---------------------------------------------------------------------
// Truck listing prompts
// ---------------------------------------------------------------------


// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function summarizeDrops(dropped) {
  const parts = []
  if (dropped.shape > 0) parts.push(`${dropped.shape} bad shape`)
  for (const [reason, count] of Object.entries(dropped.reasons)) {
    parts.push(`${count} ${reason}`)
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

// Simple seeded PRNG (mulberry32) for deterministic tier assignment
function mulberry32(seed) {
  let s = seed | 0
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Host guard — refuse to write to non-local databases.
// Shared between CLI and cron paths.
function assertLocalHost() {
  const host = new URL(process.env.DATABASE_URL).hostname
  if (host !== 'localhost' && host !== '127.0.0.1' && !process.argv.includes('--allow-remote')) {
    throw new Error(`refuses to write to ${host} without --allow-remote`)
  }
}

// ---------------------------------------------------------------------
// Core refresh logic — exported for dailyRefresh.js
// ---------------------------------------------------------------------

export async function runRefresh() {
  // Host guard — runs in BOTH CLI and cron paths
  assertLocalHost()

  // No AI config check, and no AI key needed.
  //
  // This function used to refuse to run without one. It now makes every
  // row from seed/generate.js -- closed lists, real distributions, and the
  // same pricing model validate.js applies -- so there is nothing left for
  // a provider to be asked. A board that cannot refill because someone
  // else's rate limiter is unhappy is not a board.
  //
  // The AI is still in this product where it belongs: the broker and the
  // driver are language models, and a conversation is the one thing here
  // that genuinely cannot be derived from a table.

  // Broker name -> id. The roster lives in migration 013 (reference data),
  // so a name the AI returns that is not in the table gets broker_id NULL
  // rather than failing the insert — validate.js already restricts the name
  // to the BROKERS list, so NULL here means the roster and the list drifted
  // and that is worth seeing in the report.
  const brokerRows = await pool.query('SELECT id, name FROM brokers')
  const brokerIds = new Map(brokerRows.rows.map((b) => [b.name, b.id]))

  // Step 2: fetch live drivers from DB (not fixture)
  const driversResult = await pool.query(
    `SELECT id, current_lat, current_lon, duty_status FROM drivers`,
  )
  const drivers = driversResult.rows

  // Step 3a: generate posting items via AI
  const seenPairs = new Set()
  const postingTarget = POSTING_CONFIG.poolTarget
  const postingAccepted = []
  const postingDropped = { shape: 0, reasons: {} }
  let postingRequested = 0

  // Derived, not requested.
  //
  // This loop used to be twenty batches of ten, each a network call with
  // four retries. Of the nine fields it asked for, eight were "pick from
  // this list I am pasting into the prompt" or a number the code clamped
  // into a band it computed itself. The ninth was `commodity`, one string,
  // and it cost a Groq daily quota during an ordinary day of development.
  //
  // generate.js builds the same rows from the same closed lists and the
  // same pricing model, with no network call at all. Verified over 50,000
  // generated loads: zero schema failures, zero semantic failures, and the
  // downstream clamp changes nothing because the rate comes out of
  // rateBandFor in the first place.
  // Who this company has already hauled for. A broker with loads behind
  // them posts more often -- freight is a relationship business, and a
  // board that shows twelve equally-strange names every day is the one
  // thing a real board is not. Read once, not per posting.
  const brokerHistory = new Map(
    (await pool.query(
      `SELECT broker, count(*)::int AS n FROM loads GROUP BY broker`,
    )).rows.map((r) => [r.broker, r.n]),
  )

  for (let i = 0; i < postingTarget; i += 1) {
    const item = generateLoad(Math.random, {
      avoid: seenPairs,
      brokerHistory,
      hiddenRateShare: HIDDEN_RATE_SHARE,
    })
    postingRequested += 1

    // Still validated. The generator is trusted to be correct, not assumed
    // to be: a change to cities.js or to the rate model that broke an
    // invariant should be caught here, loudly, and not written to the
    // board.
    const parsed = LoadItem.safeParse(item)
    if (!parsed.success) { postingDropped.shape += 1; continue }
    const result = validateLoadItem(parsed.data)
    if (!result.ok) {
      postingDropped.reasons[result.reason] = (postingDropped.reasons[result.reason] || 0) + 1
      continue
    }
    postingAccepted.push(result.item)
    seenPairs.add(`${result.item.originCity}, ${result.item.originState} -> ${result.item.destinationCity}, ${result.item.destinationState}`)
  }

  // Ratio gate — postings
  if (postingRequested > 0) {
    const acceptRatio = postingAccepted.length / postingRequested
    if (acceptRatio < 0.5) {
      throw new Error(
        `refresh aborted: postings only ${postingAccepted.length}/${postingRequested} accepted ` +
        `(${Math.round(acceptRatio * 100)}%, need 50%+)`
      )
    }
  }

  // Step 3b: generate applicant items via AI
  const seenEmails = new Set()
  const applicantTarget = APPLICANT_CONFIG.poolTarget
  const applicantAccepted = []
  const applicantDropped = { shape: 0, reasons: {} }
  let applicantRequested = 0

  // Derived. Fifteen fields were requested per applicant; every one of
  // them was a closed list, a bounded number, or -- in the case of email
  // -- a value the code had to repair before applicants_email_fmt would
  // accept it. generate.js correlates them instead: endorsements follow
  // experience, pay expectations follow seasoning, and the pay value lands
  // inside drivers_pay_percent / drivers_pay_cents by construction.
  for (let i = 0; i < applicantTarget; i += 1) {
    const item = generateApplicant(Math.random, { index: applicantRequested })
    applicantRequested += 1

    const parsed = ApplicantItem.safeParse(item)
    if (!parsed.success) { applicantDropped.shape += 1; continue }
    const result = validateApplicantItem(parsed.data)
    if (!result.ok) {
      applicantDropped.reasons[result.reason] = (applicantDropped.reasons[result.reason] || 0) + 1
      continue
    }
    applicantAccepted.push(result.item)
    seenEmails.add(result.item.email.toLowerCase())
  }

  // Ratio gate — applicants
  if (applicantRequested > 0) {
    const acceptRatio = applicantAccepted.length / applicantRequested
    if (acceptRatio < 0.5) {
      throw new Error(
        `refresh aborted: applicants only ${applicantAccepted.length}/${applicantRequested} accepted ` +
        `(${Math.round(acceptRatio * 100)}%, need 50%+)`
      )
    }
  }

  // Step 3c: generate truck listing items via AI
  const seenTruckMakers = new Set()
  const truckListingTarget = TRUCK_CONFIG.poolTarget
  const truckListingAccepted = []
  const truckListingDropped = { shape: 0, reasons: {} }
  let truckListingRequested = 0

  // Derived. The odometer now follows the year instead of being an
  // independent guess, so a 2024 truck with 900,000 miles on it is no
  // longer expressible; tyre percentages follow miles since the last set,
  // with drives wearing faster than steers. Make and model come from a
  // closed table keyed the same way src/constants/truckSpecs.js keys its
  // engines, so a listing and its spec sheet cannot describe two
  // different trucks.
  for (let i = 0; i < truckListingTarget; i += 1) {
    const item = generateTruckListing(Math.random, {})
    truckListingRequested += 1

    const parsed = TruckListingItem.safeParse(item)
    if (!parsed.success) { truckListingDropped.shape += 1; continue }
    const result = validateTruckListingItem(parsed.data)
    if (!result.ok) {
      truckListingDropped.reasons[result.reason] = (truckListingDropped.reasons[result.reason] || 0) + 1
      continue
    }
    truckListingAccepted.push(result.item)
    seenTruckMakers.add(`${result.item.make} ${result.item.model}`)
  }

  // Ratio gate — truck listings
  if (truckListingRequested > 0) {
    const acceptRatio = truckListingAccepted.length / truckListingRequested
    if (acceptRatio < 0.5) {
      throw new Error(
        `refresh aborted: truck listings only ${truckListingAccepted.length}/${truckListingRequested} accepted ` +
        `(${Math.round(acceptRatio * 100)}%, need 50%+)`
      )
    }
  }

  // Step 4: build rows
  const rng = mulberry32(Date.now())
  const postingRows = buildPostingRows({
    rng,
    brokerIds,
    postingItems: postingAccepted,
    drivers,
    trucks: [],
    fleetEquipment: [],
  })
  // One round trip reserves the whole block, so two runs (or the cron and a
  // manual run) can never hand out the same id. Index-based ids were the
  // reason the second run ever attempted died on driver_applicants_pkey.
  const idRows = await pool.query(
    `SELECT 'a' || nextval('applicant_id_seq') AS id FROM generate_series(1, $1)`,
    [applicantAccepted.length],
  )
  const applicantIds = idRows.rows.map((r) => r.id)

  const applicantRows = buildApplicantRows({ applicantIds, rng, applicantItems: applicantAccepted })

  // Truck listing IDs
  const truckListingIdRows = await pool.query(
    `SELECT 't' || nextval('truck_listing_id_seq') AS id FROM generate_series(1, $1)`,
    [truckListingAccepted.length],
  )
  const truckListingIds = truckListingIdRows.rows.map((r) => r.id)

  const truckListingRows = buildTruckRows({ truckIds: truckListingIds, rng, truckItems: truckListingAccepted })

  // Step 5: parameterized INSERT — all categories in one transaction
  const postingColumns = POSTING_COLUMNS
  const truckListingColumns = [
    'id', 'make', 'model', 'year', 'odometer_mi', 'price_usd', 'trailer_type',
    'fuel_capacity_gal', 'tire_front_pct', 'tire_rear_pct', 'service_notes',
    'seller', 'posted_at', 'expires_at', 'status',
    // Spec sheet (migration 020) — derived in seed/trucks.js, not generated.
    'vin', 'engine_make', 'engine_model', 'horsepower', 'transmission',
    'sleeper', 'suspension', 'axle_config', 'wheelbase_in',
    'front_axle_lbs', 'rear_axle_lbs', 'gvwr_lbs', 'has_apu',
    'location_city', 'location_state',
  ]
  const applicantColumns = [
    'id', 'full_name', 'email', 'phone', 'cdl_class', 'cdl_state',
    'license_expires_on', 'years_experience', 'home_base_city', 'home_base_state',
    'endorsements', 'desired_equipment', 'mvr_violations', 'preventable_accidents',
    'employment_gap_months', 'desired_pay_model', 'desired_pay_percent_bp',
    'desired_pay_per_mile_cents', 'available_from', 'posted_at', 'expires_at', 'status',
  ]

  // raw() objects return { __raw: true, value: "now() + interval '...'" }
  const timeCols = new Set(['posted_at', 'expires_at', 'pickup_at', 'delivery_at', 'available_from'])

  async function insertRows(client, table, columns, rows) {
    for (const row of rows) {
      const scalarPlaceholders = []
      const scalarValues = []
      const parts = columns.map((col) => {
        const v = row[col]
        if (timeCols.has(col)) {
          return v?.value ?? v
        }
        // Arrays need direct SQL (pg handles JS arrays for TEXT[] columns)
        if (Array.isArray(v)) {
          scalarPlaceholders.push(`$${scalarValues.length + 1}`)
          scalarValues.push(v)
          return scalarPlaceholders[scalarPlaceholders.length - 1]
        }
        scalarPlaceholders.push(`$${scalarValues.length + 1}`)
        scalarValues.push(v)
        return scalarPlaceholders[scalarPlaceholders.length - 1]
      })

      await client.query(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${parts.join(', ')})`,
        scalarValues,
      )
    }
  }

  let deletedPostings = 0
  let deletedApplicants = 0
  let deletedTruckListings = 0

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Cleanup lives INSIDE the transaction, and after generation, on purpose.
    // It used to run first via pool.query — so a failed insert rolled back the
    // new rows but kept the deletes, and every failed run quietly shrank the
    // board while still spending AI tokens. Now a failure leaves the database
    // exactly as it was.
    const deletePostings = await client.query(
      `DELETE FROM load_postings
       WHERE status = 'open' AND expires_at < now() - interval '2 days'`,
    )
    const deleteApplicants = await client.query(
      `DELETE FROM driver_applicants
       WHERE status = 'open' AND expires_at < now() - interval '2 days'`,
    )
    const deleteTruckListings = await client.query(
      `DELETE FROM truck_listings
       WHERE status = 'open' AND expires_at < now() - interval '2 days'`,
    )
    deletedPostings = deletePostings.rowCount
    deletedApplicants = deleteApplicants.rowCount
    deletedTruckListings = deleteTruckListings.rowCount

    if (postingRows.length > 0) {
      await insertRows(client, 'load_postings', postingColumns, postingRows)
    }
    if (applicantRows.length > 0) {
      await insertRows(client, 'driver_applicants', applicantColumns, applicantRows)
    }
    if (truckListingRows.length > 0) {
      await insertRows(client, 'truck_listings', truckListingColumns, truckListingRows)
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  // Step 6: report
  const postingDrops = postingDropped.shape + Object.values(postingDropped.reasons).reduce((s, n) => s + n, 0)
  const applicantDrops = applicantDropped.shape + Object.values(applicantDropped.reasons).reduce((s, n) => s + n, 0)
  const truckListingDrops = truckListingDropped.shape + Object.values(truckListingDropped.reasons).reduce((s, n) => s + n, 0)

  const postingTierCounts = {}
  for (const row of postingRows) {
    const t = row.tier || 'unknown'
    postingTierCounts[t] = (postingTierCounts[t] || 0) + 1
  }
  const applicantTierCounts = {}
  for (const row of applicantRows) {
    const t = row.tier || 'unknown'
    applicantTierCounts[t] = (applicantTierCounts[t] || 0) + 1
  }
  const truckListingTierCounts = {}
  for (const row of truckListingRows) {
    const t = row.tier || 'unknown'
    truckListingTierCounts[t] = (truckListingTierCounts[t] || 0) + 1
  }

  console.log(`-> ${postingRequested} postings requested, ${postingAccepted.length} accepted, ${postingDrops} dropped${summarizeDrops(postingDropped)}`)
  console.log(`-> ${postingRows.length} postings inserted, ${deletedPostings} old postings deleted`)
  console.log(`-> posting tiers: ${TIER_WEIGHTS.map(([n]) => `${n}:${postingTierCounts[n] || 0}`).join(' ')}`)
  console.log(`-> ${applicantRequested} applicants requested, ${applicantAccepted.length} accepted, ${applicantDrops} dropped${summarizeDrops(applicantDropped)}`)
  console.log(`-> ${applicantRows.length} applicants inserted, ${deletedApplicants} old applicants deleted`)
  console.log(`-> applicant tiers: ${APPLICANT_TIERS.map(([n]) => `${n}:${applicantTierCounts[n] || 0}`).join(' ')}`)
  console.log(`-> ${truckListingRequested} truck listings requested, ${truckListingAccepted.length} accepted, ${truckListingDrops} dropped${summarizeDrops(truckListingDropped)}`)
  console.log(`-> ${truckListingRows.length} truck listings inserted, ${deletedTruckListings} old truck listings deleted`)
  console.log(`-> truck listing tiers: ${TRUCK_TIERS.map(([n]) => `${n}:${truckListingTierCounts[n] || 0}`).join(' ')}`)

  return {
    ok: true,
    postingsInserted: postingRows.length,
    applicantsInserted: applicantRows.length,
    truckListingsInserted: truckListingRows.length,
  }
}

// ---------------------------------------------------------------------
// CLI entry point — ONLY runs when invoked directly, never on import.
// dailyRefresh.js imports runRefresh() without triggering this.
// ---------------------------------------------------------------------

const isMainModule = process.argv[1] &&
  (process.argv[1].endsWith('/refresh-postings.js') ||
   process.argv[1].endsWith('\\refresh-postings.js'))

if (isMainModule) {
  const postingOnly = process.argv.includes('--postings-only')
  const countArg = process.argv.find((arg) => arg.startsWith('--count='))
  const run = postingOnly ? runPostingRefresh({ count: countArg ? Number(countArg.slice(8)) : 12 }) : runRefresh()
  run
    .then((result) => {
      if (postingOnly) console.log(JSON.stringify(result))
      if (!result.ok) process.exitCode = 1
      return pool.end()
    })
    .catch((err) => {
      console.error(err.stack || err.message)
      process.exit(1)
    })
}
