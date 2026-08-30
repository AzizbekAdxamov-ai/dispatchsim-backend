// Orchestrator for the AI seed generator.
//
//   npm run generate:seed -- --dry-run --seed 42
//   npm run generate:seed -- --seed 7
//
// Flow: request AI suggestions in small sequential batches (never
// parallel -- see config.js's requestSpacingMs, derived from AI_MAX_RPM)
// -> validate every item through validate.js -> hand the accepted items
// to build.js -> render to SQL -> a final gate decides whether the
// result is good enough to become src/db/seeds/001_demo_data.sql at all.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAiConfig, sleep, MISSING_KEY_MESSAGE } from './seed/config.js'
import { chatJson } from './seed/aiClient.js'
import { CITIES } from './seed/cities.js'
import { SERVICE_NAMES } from './seed/services.js'
import { BROKERS, LoadItem, DriverItem, TruckItem, MaintenanceItem } from './seed/schemas.js'
import {
  BANNED,
  validateLoadItem,
  validateDriverItem,
  validateTruckItem,
  validateMaintenanceItem,
} from './seed/validate.js'
import { buildSeed } from './seed/build.js'
import { renderSeedFile } from './seed/render.js'
import { POSTING_CONFIG } from './seed/postings.js'
import { EQUIPMENT_KEYS } from '../src/constants/equipment.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SEED_SQL_PATH = path.join(__dirname, '..', 'src', 'db', 'seeds', '001_demo_data.sql')
const REPORT_PATH = path.join(__dirname, 'seed-report.json')

// The prompt needs to tell the model which words to avoid, but this
// file's own source text must not spell them out either -- that would
// trip the exact same sweep everything else in scripts/seed/ goes
// through. So the word list is pulled out of validate.js's BANNED regex
// at runtime instead of being retyped here.
const BANNED_WORDS_FOR_PROMPT = BANNED.source
  .replace(/^\\b\(/, '')
  .replace(/\)\\b$/, '')
  .split('|')
  .join(', ')

const CITY_LIST = CITIES.map((c) => `${c.city}, ${c.state}`).join(' | ')

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run')
  const seedIdx = argv.indexOf('--seed')
  const seedArg = seedIdx !== -1 ? argv[seedIdx + 1] : undefined
  const seed = seedArg !== undefined ? Number(seedArg) : 42
  if (!Number.isInteger(seed)) {
    throw new Error('--seed must be an integer')
  }
  return { dryRun, seed }
}

// ---------------------------------------------------------------------
// Prompts -- one system/user pair per category. The AI's JSON is a
// courtesy, not the real gate: validate.js is what actually enforces the
// closed lists and the banned-word rule, these prompts just save round
// trips by asking nicely first.
// ---------------------------------------------------------------------

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

function loadUserPrompt(want, seenPairs, seenBrokers) {
  const recentPairs = [...seenPairs].slice(-25)
  const recentBrokers = [...seenBrokers]
  return (
    `Generate ${want} distinct freight loads as JSON. Vary origin/destination pairs, ` +
    'brokers, commodities and equipment types across the batch. ' +
    (recentPairs.length > 0 ? `Avoid repeating these origin->destination pairs already used: ${recentPairs.join('; ')}. ` : '') +
    (recentBrokers.length > 0 ? `Try to spread across brokers beyond just: ${recentBrokers.join(', ')}. ` : '')
  )
}

function driverSystemPrompt() {
  return (
    'You generate realistic long-haul truck driver profiles for a dispatch-board ' +
    'example dataset. Respond with strict JSON only, shaped exactly as ' +
    '{"items":[{"fullName":string,"phone":string,"email":string,"homeBaseCity":string,' +
    '"homeBaseState":2-letter string,"cdlClass":"A" or "B"}]}. ' +
    `homeBaseCity/homeBaseState must be chosen verbatim from this list: ${CITY_LIST}. ` +
    'phone should look like a US phone number. email must be a plausible personal address. ' +
    `Never use any of these words in any field: ${BANNED_WORDS_FOR_PROMPT}.`
  )
}

function driverUserPrompt(want) {
  return `Generate ${want} distinct driver profiles as JSON, spread across different home-base cities.`
}

function truckSystemPrompt() {
  return (
    'You generate realistic North American Class-8 semi tractor records for a fleet ' +
    'example dataset. Respond with strict JSON only, shaped exactly as ' +
    '{"items":[{"make":string,"model":string,"year":number}]}. ' +
    'Use real manufacturers (Freightliner, Peterbilt, Kenworth, Volvo Trucks, ' +
    'International, Mack, Western Star) and real model names. year between 2015 and 2026. ' +
    `Never use any of these words in any field: ${BANNED_WORDS_FOR_PROMPT}.`
  )
}

function truckUserPrompt(want) {
  return `Generate ${want} distinct tractor records as JSON, spread across manufacturers and years.`
}

function maintenanceSystemPrompt() {
  return (
    'You generate short maintenance notes for a fleet example dataset. Respond with ' +
    'strict JSON only, shaped exactly as {"items":[{"service":string,"notes":string}]}. ' +
    `service must be exactly one of: ${SERVICE_NAMES.join(', ')}. ` +
    'notes is a short (3-120 character) free-text note about the work item. ' +
    `Never use any of these words in any field: ${BANNED_WORDS_FOR_PROMPT}.`
  )
}

function maintenanceUserPrompt(want) {
  return `Generate ${want} distinct maintenance notes as JSON, spread across different services.`
}

// ---------------------------------------------------------------------
// Batch runner
// ---------------------------------------------------------------------

function summarizeDrops(dropped) {
  const parts = []
  if (dropped.shape > 0) parts.push(`${dropped.shape} bad shape`)
  for (const [reason, count] of Object.entries(dropped.reasons)) {
    parts.push(`${count} ${reason}`)
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

async function generateCategory({ label, config, target, batchSize, schema, validator, buildSystem, buildUser, onAccepted }) {
  const accepted = []
  const dropped = { shape: 0, reasons: {} }
  let requested = 0
  const batches = Math.ceil(target / batchSize)
  const system = buildSystem()

  for (let b = 0; b < batches; b++) {
    const remaining = target - requested
    const want = Math.min(batchSize, remaining)
    if (want <= 0) break
    if (b > 0) await sleep(config.requestSpacingMs)

    let response
    try {
      response = await chatJson({ system, user: buildUser(want), config })
    } catch (err) {
      console.error(`  ! ${label} batch ${b + 1}/${batches} request failed: ${err.message}`)
      requested += want
      continue
    }
    requested += want

    const items = Array.isArray(response?.items) ? response.items : []
    for (const raw of items) {
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        dropped.shape += 1
        continue
      }
      const result = validator(parsed.data)
      if (!result.ok) {
        dropped.reasons[result.reason] = (dropped.reasons[result.reason] || 0) + 1
        continue
      }
      accepted.push(result.item)
      onAccepted?.(result.item)
    }
  }

  const dropTotal = dropped.shape + Object.values(dropped.reasons).reduce((s, n) => s + n, 0)
  console.log(`-> ${requested} ${label} requested, ${accepted.length} accepted, ${dropTotal} dropped${summarizeDrops(dropped)}`)

  return { accepted, requested }
}

// ---------------------------------------------------------------------
// Final gate: counts within +/-10% of target, zero banned words in the
// rendered SQL. Relational integrity (no dangling FK, ids/emails/plates
// unique, one active load per driver, one driver per truck) is enforced
// earlier by build.js's assertIntegrity(), which throws before this
// point is ever reached -- so it is a precondition here, not a re-check.
function checkGate(summary, sql) {
  const problems = []
  for (const [label, s] of Object.entries(summary)) {
    if (s.requested === 0) continue
    const ratio = s.accepted / s.requested
    if (ratio < 0.9 || ratio > 1.1) {
      problems.push(`${label}: ${s.accepted}/${s.requested} accepted (${Math.round(ratio * 100)}%, need 90-110%)`)
    }
  }
  const bannedMatch = sql.match(BANNED)
  if (bannedMatch) {
    problems.push(`banned word found in rendered SQL: "${bannedMatch[0]}"`)
  }
  return { ok: problems.length === 0, problems }
}

async function writeReport(data) {
  await mkdir(path.dirname(REPORT_PATH), { recursive: true })
  await writeFile(REPORT_PATH, JSON.stringify(data, null, 2), 'utf8')
  console.error(`wrote ${path.relative(process.cwd(), REPORT_PATH)}`)
}

async function finish({ seed, driverItems, truckItems, loadItems, maintenanceItems, postingItems, summary }) {
  let built
  try {
    built = buildSeed({ driverItems, truckItems, loadItems, maintenanceItems, postingItems: postingItems || [], seed })
  } catch (err) {
    await writeReport({ summary, buildError: err.message })
    console.error(`build stage failed: ${err.message}`)
    process.exitCode = 1
    return
  }

  const sql = renderSeedFile(built.inserts)
  const gate = checkGate(summary, sql)

  if (!gate.ok) {
    await writeReport({ summary, gate })
    console.error('gate check failed:')
    for (const p of gate.problems) console.error(`  - ${p}`)
    process.exitCode = 1
    return
  }

  await mkdir(path.dirname(SEED_SQL_PATH), { recursive: true })
  await writeFile(SEED_SQL_PATH, sql, 'utf8')
  console.log(`wrote ${path.relative(process.cwd(), SEED_SQL_PATH)}`)
  console.log(
    `totals: ${built.counts.drivers} drivers, ${built.counts.trucks} trucks, ${built.counts.loads} loads, ` +
      `${built.counts.maintenanceRecords} maintenance records, ${built.counts.truckDailyMetrics} daily-metric rows, ` +
      `${built.counts.postings} postings`
  )
}

// ---------------------------------------------------------------------
// Dry run: a small built-in fixture stands in for the AI, so the whole
// validate -> build -> render -> write pipeline can be exercised with no
// network access and no API key.
// ---------------------------------------------------------------------

const FIXTURE_LOADS = [
  { originCity: 'Dallas', originState: 'TX', destinationCity: 'Houston', destinationState: 'TX', broker: 'TQL', commodity: 'Packaged retail goods', equipmentType: 'dry-van', weightLbs: 24000, ratePerMile: 2.1 },
  { originCity: 'Chicago', originState: 'IL', destinationCity: 'Kansas City', destinationState: 'MO', broker: 'Landstar', commodity: 'Auto parts', equipmentType: 'dry-van', weightLbs: 31000, ratePerMile: 1.95 },
  { originCity: 'Los Angeles', originState: 'CA', destinationCity: 'Phoenix', destinationState: 'AZ', broker: 'C.H. Robinson', commodity: 'Electronics', equipmentType: 'dry-van', weightLbs: 18500, ratePerMile: 2.3 },
  { originCity: 'Atlanta', originState: 'GA', destinationCity: 'Charlotte', destinationState: 'NC', broker: 'Echo Global', commodity: 'Frozen poultry', equipmentType: 'reefer', weightLbs: 26000, ratePerMile: 2.6 },
  { originCity: 'Denver', originState: 'CO', destinationCity: 'Salt Lake City', destinationState: 'UT', broker: 'RXO', commodity: 'Structural steel beams', equipmentType: 'flatbed', weightLbs: 34000, ratePerMile: 2.4 },
  { originCity: 'Seattle', originState: 'WA', destinationCity: 'Spokane', destinationState: 'WA', broker: 'Werner', commodity: 'Bottled beverages', equipmentType: 'dry-van', weightLbs: 21000, ratePerMile: 2.0 },
  { originCity: 'Newark', originState: 'NJ', destinationCity: 'Boston', destinationState: 'MA', broker: 'Schneider', commodity: 'Paper goods', equipmentType: 'dry-van', weightLbs: 19500, ratePerMile: 2.35 },
  { originCity: 'Memphis', originState: 'TN', destinationCity: 'Nashville', destinationState: 'TN', broker: 'J.B. Hunt', commodity: 'Fresh produce', equipmentType: 'reefer', weightLbs: 22500, ratePerMile: 2.5 },
  { originCity: 'Houston', originState: 'TX', destinationCity: 'San Antonio', destinationState: 'TX', broker: 'XPO Logistics', commodity: 'Industrial pipe fittings', equipmentType: 'flatbed', weightLbs: 29000, ratePerMile: 2.2 },
  { originCity: 'Portland', originState: 'OR', destinationCity: 'Boise', destinationState: 'ID', broker: 'Coyote Logistics', commodity: 'Lumber', equipmentType: 'flatbed', weightLbs: 33500, ratePerMile: 2.45 },
  { originCity: 'Detroit', originState: 'MI', destinationCity: 'Columbus', destinationState: 'OH', broker: 'TQL', commodity: 'Automotive stampings', equipmentType: 'dry-van', weightLbs: 27500, ratePerMile: 1.9 },
  { originCity: 'Orlando', originState: 'FL', destinationCity: 'Jacksonville', destinationState: 'FL', broker: 'Landstar', commodity: 'Chemical drums', equipmentType: 'tanker', weightLbs: 24500, ratePerMile: 2.7 },
]

const FIXTURE_DRIVERS = [
  { fullName: 'Carlos Jimenez', phone: '512-555-0111', email: 'carlos.jimenez@example.com', homeBaseCity: 'San Antonio', homeBaseState: 'TX', cdlClass: 'A' },
  { fullName: 'Priya Nair', phone: '773-555-0122', email: 'priya.nair@example.com', homeBaseCity: 'Chicago', homeBaseState: 'IL', cdlClass: 'A' },
  { fullName: 'Wesley Combs', phone: '470-555-0133', email: 'wesley.combs@example.com', homeBaseCity: 'Atlanta', homeBaseState: 'GA', cdlClass: 'A' },
  { fullName: 'Hannah Brooks', phone: '303-555-0144', email: 'hannah.brooks@example.com', homeBaseCity: 'Denver', homeBaseState: 'CO', cdlClass: 'B' },
  { fullName: 'Tyrell Banks', phone: '901-555-0155', email: 'tyrell.banks@example.com', homeBaseCity: 'Memphis', homeBaseState: 'TN', cdlClass: 'A' },
  { fullName: 'Grace Lindqvist', phone: '206-555-0166', email: 'grace.lindqvist@example.com', homeBaseCity: 'Seattle', homeBaseState: 'WA', cdlClass: 'A' },
  { fullName: 'Omar Haddad', phone: '713-555-0177', email: 'omar.haddad@example.com', homeBaseCity: 'Houston', homeBaseState: 'TX', cdlClass: 'A' },
  { fullName: 'Renee Castillo', phone: '973-555-0188', email: 'renee.castillo@example.com', homeBaseCity: 'Newark', homeBaseState: 'NJ', cdlClass: 'B' },
]

const FIXTURE_TRUCKS = [
  { make: 'Freightliner', model: 'Cascadia', year: 2022 },
  { make: 'Peterbilt', model: '579', year: 2021 },
  { make: 'Kenworth', model: 'T680', year: 2023 },
  { make: 'Volvo Trucks', model: 'VNL', year: 2020 },
  { make: 'International', model: 'LT', year: 2024 },
]

const FIXTURE_MAINTENANCE = [
  { service: 'Oil change', notes: 'Routine interval service' },
  { service: 'Tire rotation', notes: 'Front and rear rotation' },
  { service: 'Brake system inspection', notes: 'Pad wear check' },
  { service: 'Annual DOT inspection', notes: 'Yearly compliance check' },
  { service: 'Battery check', notes: 'Cold-weather readiness check' },
  { service: 'Coolant flush', notes: 'Scheduled fluid replacement' },
]

// Dry-run fixture for postings — same shape as AI-generated LoadItem.
// Has at least one of each equipment type so round-robin covers all tiers.
const FIXTURE_POSTINGS = [
  { originCity: 'Dallas', originState: 'TX', destinationCity: 'Houston', destinationState: 'TX', broker: 'TQL', commodity: 'Packaged retail goods', equipmentType: 'dry-van', weightLbs: 24000, ratePerMile: 2.8 },
  { originCity: 'Chicago', originState: 'IL', destinationCity: 'Kansas City', destinationState: 'MO', broker: 'Landstar', commodity: 'Auto parts', equipmentType: 'dry-van', weightLbs: 31000, ratePerMile: 1.8 },
  { originCity: 'Los Angeles', originState: 'CA', destinationCity: 'Phoenix', destinationState: 'AZ', broker: 'C.H. Robinson', commodity: 'Electronics', equipmentType: 'reefer', weightLbs: 18500, ratePerMile: 2.3 },
  { originCity: 'Atlanta', originState: 'GA', destinationCity: 'Charlotte', destinationState: 'NC', broker: 'Echo Global', commodity: 'Frozen poultry', equipmentType: 'reefer', weightLbs: 26000, ratePerMile: 3.2 },
  { originCity: 'Denver', originState: 'CO', destinationCity: 'Salt Lake City', destinationState: 'UT', broker: 'RXO', commodity: 'Structural steel beams', equipmentType: 'flatbed', weightLbs: 34000, ratePerMile: 2.4 },
  { originCity: 'Seattle', originState: 'WA', destinationCity: 'Spokane', destinationState: 'WA', broker: 'Werner', commodity: 'Bottled beverages', equipmentType: 'dry-van', weightLbs: 21000, ratePerMile: 2.0 },
  { originCity: 'Newark', originState: 'NJ', destinationCity: 'Boston', destinationState: 'MA', broker: 'Schneider', commodity: 'Paper goods', equipmentType: 'step-deck', weightLbs: 19500, ratePerMile: 2.35 },
  { originCity: 'Memphis', originState: 'TN', destinationCity: 'Nashville', destinationState: 'TN', broker: 'J.B. Hunt', commodity: 'Fresh produce', equipmentType: 'tanker', weightLbs: 22500, ratePerMile: 2.5 },
  { originCity: 'Houston', originState: 'TX', destinationCity: 'San Antonio', destinationState: 'TX', broker: 'XPO Logistics', commodity: 'Industrial pipe fittings', equipmentType: 'flatbed', weightLbs: 29000, ratePerMile: 1.5 },
  { originCity: 'Portland', originState: 'OR', destinationCity: 'Boise', destinationState: 'ID', broker: 'Coyote Logistics', commodity: 'Lumber', equipmentType: 'power-only', weightLbs: 33500, ratePerMile: 2.45 },
  { originCity: 'Detroit', originState: 'MI', destinationCity: 'Columbus', destinationState: 'OH', broker: 'TQL', commodity: 'Automotive stampings', equipmentType: 'dry-van', weightLbs: 27500, ratePerMile: 1.9 },
  { originCity: 'Orlando', originState: 'FL', destinationCity: 'Jacksonville', destinationState: 'FL', broker: 'Landstar', commodity: 'Chemical drums', equipmentType: 'tanker', weightLbs: 24500, ratePerMile: 2.7 },
]

async function runDryRun({ seed }) {
  console.log('dry run: using a built-in fixture instead of any AI request')

  const loadResults = FIXTURE_LOADS.map((raw) => validateLoadItem(LoadItem.parse(raw)))
  const driverResults = FIXTURE_DRIVERS.map((raw) => validateDriverItem(DriverItem.parse(raw)))
  const truckResults = FIXTURE_TRUCKS.map((raw) => validateTruckItem(TruckItem.parse(raw)))
  const maintenanceResults = FIXTURE_MAINTENANCE.map((raw) => validateMaintenanceItem(MaintenanceItem.parse(raw)))
  const postingResults = FIXTURE_POSTINGS.map((raw) => validateLoadItem(LoadItem.parse(raw)))

  const loadItems = loadResults.filter((r) => r.ok).map((r) => r.item)
  const driverItems = driverResults.filter((r) => r.ok).map((r) => r.item)
  const truckItems = truckResults.filter((r) => r.ok).map((r) => r.item)
  const maintenanceItems = maintenanceResults.filter((r) => r.ok).map((r) => r.item)
  const postingItems = postingResults.filter((r) => r.ok).map((r) => r.item)

  const summary = {
    drivers: { requested: FIXTURE_DRIVERS.length, accepted: driverItems.length },
    trucks: { requested: FIXTURE_TRUCKS.length, accepted: truckItems.length },
    loads: { requested: FIXTURE_LOADS.length, accepted: loadItems.length },
    maintenance: { requested: FIXTURE_MAINTENANCE.length, accepted: maintenanceItems.length },
    postings: { requested: FIXTURE_POSTINGS.length, accepted: postingItems.length },
  }
  for (const [label, s] of Object.entries(summary)) {
    console.log(`-> ${s.requested} ${label} requested, ${s.accepted} accepted, ${s.requested - s.accepted} dropped`)
  }

  await finish({ seed, driverItems, truckItems, loadItems, maintenanceItems, postingItems, summary })
}

// ---------------------------------------------------------------------
// Real run
// ---------------------------------------------------------------------

async function runGeneration({ config, seed }) {
  const seenPairs = new Set()
  const seenBrokers = new Set()

  const drivers = await generateCategory({
    label: 'drivers', config, target: 30, batchSize: 15,
    schema: DriverItem, validator: validateDriverItem,
    buildSystem: driverSystemPrompt, buildUser: (want) => driverUserPrompt(want),
  })

  const trucks = await generateCategory({
    label: 'trucks', config, target: 15, batchSize: 15,
    schema: TruckItem, validator: validateTruckItem,
    buildSystem: truckSystemPrompt, buildUser: (want) => truckUserPrompt(want),
  })

  const loads = await generateCategory({
    label: 'loads', config, target: 200, batchSize: 20,
    schema: LoadItem, validator: validateLoadItem,
    buildSystem: loadSystemPrompt,
    buildUser: (want) => loadUserPrompt(want, seenPairs, seenBrokers),
    onAccepted: (item) => {
      seenPairs.add(`${item.originCity}, ${item.originState} -> ${item.destinationCity}, ${item.destinationState}`)
      seenBrokers.add(item.broker)
    },
  })

  const maintenance = await generateCategory({
    label: 'maintenance', config, target: 45, batchSize: 25,
    schema: MaintenanceItem, validator: validateMaintenanceItem,
    buildSystem: maintenanceSystemPrompt, buildUser: (want) => maintenanceUserPrompt(want),
  })

  // Postings reuse the LoadItem shape and prompts — same city/broker/
  // equipment constraints, just routed through buildPostingRows instead
  // of buildLoadRow. Own seenPairs/seenBrokers to avoid overlap with
  // the committed-loads pool.
  const postingSeenPairs = new Set()
  const postingSeenBrokers = new Set()
  const postings = await generateCategory({
    label: 'postings', config, target: POSTING_CONFIG.poolTarget, batchSize: 25,
    schema: LoadItem, validator: validateLoadItem,
    buildSystem: loadSystemPrompt,
    buildUser: (want) => loadUserPrompt(want, postingSeenPairs, postingSeenBrokers),
    onAccepted: (item) => {
      postingSeenPairs.add(`${item.originCity}, ${item.originState} -> ${item.destinationCity}, ${item.destinationState}`)
      postingSeenBrokers.add(item.broker)
    },
  })

  const summary = {
    drivers: { requested: drivers.requested, accepted: drivers.accepted.length },
    trucks: { requested: trucks.requested, accepted: trucks.accepted.length },
    loads: { requested: loads.requested, accepted: loads.accepted.length },
    maintenance: { requested: maintenance.requested, accepted: maintenance.accepted.length },
    postings: { requested: postings.requested, accepted: postings.accepted.length },
  }

  await finish({
    seed,
    driverItems: drivers.accepted,
    truckItems: trucks.accepted,
    loadItems: loads.accepted,
    maintenanceItems: maintenance.accepted,
    postingItems: postings.accepted,
    summary,
  })
}

async function main() {
  const { dryRun, seed } = parseArgs(process.argv.slice(2))

  if (dryRun) {
    await runDryRun({ seed })
    return
  }

  const { config, errors } = readAiConfig()
  if (!config) {
    if (errors.includes('AI_API_KEY is missing')) {
      console.error(MISSING_KEY_MESSAGE)
    } else {
      console.error('AI seed generator cannot run:')
      for (const e of errors) console.error(`  - ${e}`)
    }
    process.exitCode = 1
    return
  }

  await runGeneration({ config, seed })
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exitCode = 1
})
