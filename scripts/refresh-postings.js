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
import { readAiConfig, sleep, MISSING_KEY_MESSAGE } from './seed/config.js'
import { chatJson } from './seed/aiClient.js'
import { CITIES } from './seed/cities.js'
import { LoadItem, ApplicantItem, TruckListingItem, TRAILER_TYPES, ENDORSEMENTS, BROKERS } from './seed/schemas.js'
import { BANNED, validateLoadItem, validateApplicantItem, validateTruckListingItem } from './seed/validate.js'
import { buildPostingRows, POSTING_CONFIG, TIER_WEIGHTS } from './seed/postings.js'
import { buildApplicantRows, APPLICANT_CONFIG, APPLICANT_TIERS } from './seed/applicants.js'
import { buildTruckRows, TRUCK_CONFIG, TRUCK_TIERS } from './seed/trucks.js'
import { EQUIPMENT_KEYS } from '../src/constants/equipment.js'

// ---------------------------------------------------------------------
// Prompts (same as generate-seed.js — reused here to avoid drift)
// ---------------------------------------------------------------------

const BANNED_WORDS_FOR_PROMPT = BANNED.source
  .replace(/^\\b\(/, '')
  .replace(/\)\\b$/, '')
  .split('|')
  .join(', ')

const CITY_LIST = CITIES.map((c) => `${c.city}, ${c.state}`).join(' | ')

function loadSystemPrompt() {
  return (
    'You generate realistic freight load listings for a dispatch-board example ' +
    'dataset. Respond with strict JSON only, shaped exactly as ' +
    '{"items":[{"originCity":string,"originState":2-letter string,' +
    '"destinationCity":string,"destinationState":2-letter string,"broker":string,' +
    '"commodity":string,"equipmentType":string,"weightLbs":number,"ratePerMile":number}]}. ' +
    `Origin and destination must both be chosen verbatim from this list (city, state): ${CITY_LIST}. ` +
    `broker must be one of: ${BROKERS.join(', ')}. ` +
    `equipmentType must be one of: ${EQUIPMENT_KEYS.join(', ')}. ` +
    'weightLbs between 1000 and 45000. ratePerMile between 1.2 and 4.0. ' +
    `Never use any of these words in any field: ${BANNED_WORDS_FOR_PROMPT}.`
  )
}

function loadUserPrompt(want, seenPairs) {
  const recentPairs = [...seenPairs].slice(-25)
  return (
    `Generate ${want} distinct freight loads as JSON. Vary origin/destination pairs, ` +
    'brokers, commodities and equipment types across the batch. ' +
    (recentPairs.length > 0 ? `Avoid repeating these origin->destination pairs already used: ${recentPairs.join('; ')}. ` : '')
  )
}

// ---------------------------------------------------------------------
// Applicant prompts
// ---------------------------------------------------------------------

function applicantSystemPrompt() {
  return (
    'You generate realistic truck driver job applicants for a dispatch-board ' +
    'example dataset. Respond with strict JSON only, shaped exactly as ' +
    '{"items":[{"fullName":string,"email":string,"phone":string,' +
    '"cdlClass":"A" or "B","cdlState":2-letter string,' +
    '"yearsExperience":number,"homeBaseCity":string,"homeBaseState":2-letter string,' +
    '"endorsements":array of hazmat|tanker|doubles,"desiredEquipment":string,' +
    '"mvrViolations":number,"preventableAccidents":number,' +
    '"employmentGapMonths":number,"desiredPayModel":"percent" or "permile",' +
    '"desiredPayValue":number}]}. ' +
    `homeBaseCity/homeBaseState must be chosen verbatim from: ${CITY_LIST}. ` +
    `desiredEquipment must be one of: ${EQUIPMENT_KEYS.join(', ')}. ` +
    `endorsements from: ${ENDORSEMENTS.join(', ')} (can be empty array). ` +
    'phone should look like a US phone number. email must be a plausible address. ' +
    'yearsExperience 0-45. mvrViolations 0-20. preventableAccidents 0-10. employmentGapMonths 0-240. ' +
    'desiredPayModel percent → desiredPayValue 1000-5000 (basis points). ' +
    'desiredPayModel permile → desiredPayValue 30-120 (cents per mile). ' +
    `Never use any of these words in any field: ${BANNED_WORDS_FOR_PROMPT}.`
  )
}

function applicantUserPrompt(want, seenEmails) {
  return (
    `Generate ${want} distinct driver applicants as JSON. Spread across different cities, ` +
    'CDL classes, experience levels, and pay models. ' +
    (seenEmails.length > 0 ? `Avoid repeating emails: ${seenEmails.join(', ')}.` : '')
  )
}

// ---------------------------------------------------------------------
// Truck listing prompts
// ---------------------------------------------------------------------

function truckListingSystemPrompt() {
  return (
    'You generate realistic used Class-8 semi tractor listings for a truck market example ' +
    'dataset. Respond with strict JSON only, shaped exactly as ' +
    '{"items":[{"make":string,"model":string,"year":number,"odometerMi":number,' +
    '"trailerType":string,"tireFrontPct":number,"tireRearPct":number,' +
    '"serviceNotes":string,"seller":string}]}. ' +
    'Use real manufacturers (Freightliner, Peterbilt, Kenworth, Volvo Trucks, ' +
    'International, Mack, Western Star) and real model names. ' +
    'year between 1995 and 2030. odometerMi between 50000 and 1500000. ' +
    `trailerType must be one of: ${TRAILER_TYPES.join(', ')}. ` +
    'tireFrontPct and tireRearPct between 5 and 100. ' +
    'serviceNotes is a short note about recent maintenance or condition (3-200 chars). ' +
    'seller is a fictional truck dealership name (e.g. "Cascade Truck Sales", "Delta Fleet Exchange"). ' +
    'Do NOT use real dealership names. ' +
    `Never use any of these words in any field: ${BANNED_WORDS_FOR_PROMPT}.`
  )
}

function truckListingUserPrompt(want, seenMakers) {
  return (
    `Generate ${want} distinct truck listings as JSON, spread across manufacturers, years, and trailer types. ` +
    (seenMakers.length > 0 ? `Avoid repeating these make/model pairs: ${seenMakers.join(', ')}.` : '')
  )
}

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

  const { config, errors } = readAiConfig()
  if (!config) {
    if (errors.includes('AI_API_KEY is missing')) {
      console.error(MISSING_KEY_MESSAGE)
    } else {
      console.error('refresh-postings cannot run:')
      for (const e of errors) console.error(`  - ${e}`)
    }
    return { ok: false, reason: 'no AI config' }
  }

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
  const batchSize = 10
  const postingBatches = Math.ceil(postingTarget / batchSize)
  const postingAccepted = []
  const postingDropped = { shape: 0, reasons: {} }
  let postingRequested = 0

  const loadSys = loadSystemPrompt()

  for (let b = 0; b < postingBatches; b++) {
    const remaining = postingTarget - postingRequested
    const want = Math.min(batchSize, remaining)
    if (want <= 0) break
    if (b > 0) await sleep(config.requestSpacingMs)

    let response
    try {
      response = await chatJson({ system: loadSys, user: loadUserPrompt(want, seenPairs), config })
    } catch (err) {
      console.error(`  ! postings batch ${b + 1}/${postingBatches} request failed: ${err.message}`)
      postingRequested += want
      continue
    }
    postingRequested += want

    const items = Array.isArray(response?.items) ? response.items : []
    for (const raw of items) {
      const parsed = LoadItem.safeParse(raw)
      if (!parsed.success) { postingDropped.shape += 1; continue }
      const result = validateLoadItem(parsed.data)
      if (!result.ok) {
        postingDropped.reasons[result.reason] = (postingDropped.reasons[result.reason] || 0) + 1
        continue
      }
      postingAccepted.push(result.item)
      seenPairs.add(`${result.item.originCity}, ${result.item.originState} -> ${result.item.destinationCity}, ${result.item.destinationState}`)
    }
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
  const applicantBatches = Math.ceil(applicantTarget / batchSize)
  const applicantAccepted = []
  const applicantDropped = { shape: 0, reasons: {} }
  let applicantRequested = 0

  const applicantSys = applicantSystemPrompt()

  for (let b = 0; b < applicantBatches; b++) {
    const remaining = applicantTarget - applicantRequested
    const want = Math.min(batchSize, remaining)
    if (want <= 0) break
    if (b > 0 || postingBatches > 0) await sleep(config.requestSpacingMs)

    let response
    try {
      response = await chatJson({ system: applicantSys, user: applicantUserPrompt(want, [...seenEmails]), config })
    } catch (err) {
      console.error(`  ! applicants batch ${b + 1}/${applicantBatches} request failed: ${err.message}`)
      applicantRequested += want
      continue
    }
    applicantRequested += want

    const items = Array.isArray(response?.items) ? response.items : []
    for (const raw of items) {
      const parsed = ApplicantItem.safeParse(raw)
      if (!parsed.success) { applicantDropped.shape += 1; continue }
      const result = validateApplicantItem(parsed.data)
      if (!result.ok) {
        applicantDropped.reasons[result.reason] = (applicantDropped.reasons[result.reason] || 0) + 1
        continue
      }
      applicantAccepted.push(result.item)
      seenEmails.add(result.item.email.toLowerCase())
    }
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
  const truckListingBatches = Math.ceil(truckListingTarget / batchSize)
  const truckListingAccepted = []
  const truckListingDropped = { shape: 0, reasons: {} }
  let truckListingRequested = 0

  const truckListingSys = truckListingSystemPrompt()

  for (let b = 0; b < truckListingBatches; b++) {
    const remaining = truckListingTarget - truckListingRequested
    const want = Math.min(batchSize, remaining)
    if (want <= 0) break
    if (b > 0 || postingBatches > 0 || applicantBatches > 0) await sleep(config.requestSpacingMs)

    let response
    try {
      response = await chatJson({ system: truckListingSys, user: truckListingUserPrompt(want, [...seenTruckMakers]), config })
    } catch (err) {
      console.error(`  ! truck listings batch ${b + 1}/${truckListingBatches} request failed: ${err.message}`)
      truckListingRequested += want
      continue
    }
    truckListingRequested += want

    const items = Array.isArray(response?.items) ? response.items : []
    for (const raw of items) {
      const parsed = TruckListingItem.safeParse(raw)
      if (!parsed.success) { truckListingDropped.shape += 1; continue }
      const result = validateTruckListingItem(parsed.data)
      if (!result.ok) {
        truckListingDropped.reasons[result.reason] = (truckListingDropped.reasons[result.reason] || 0) + 1
        continue
      }
      truckListingAccepted.push(result.item)
      seenTruckMakers.add(`${result.item.make} ${result.item.model}`)
    }
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
  const postingColumns = [
    'origin_lat', 'origin_lon', 'destination_lat', 'destination_lon',
    'origin_city', 'origin_state', 'destination_city', 'destination_state',
    'broker', 'broker_id', 'commodity', 'rate_usd', 'distance_mi', 'weight_lbs',
    'equipment_type', 'equipment_length_ft', 'posted_at', 'expires_at', 'pickup_at', 'delivery_at', 'status',
  ]
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
  runRefresh()
    .then((result) => {
      if (!result.ok) process.exitCode = 1
      return pool.end()
    })
    .catch((err) => {
      console.error(err.stack || err.message)
      process.exit(1)
    })
}
