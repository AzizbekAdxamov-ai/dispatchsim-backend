// Prove that a load can actually be late.
//
//   node scripts/late-proof.js
//
// On 2026-09-08 the lateness fix shipped, passed review, passed
// `node --check`, passed a 100,000-roll distribution test -- and could
// not mark a single load late. eta_at was compared against delivery_at:
// one on the compressed calendar, minutes out, the other on the real
// one, hours out. The comparison was always false. Every check that ran
// that day checked the wrong thing, because none of them asked the only
// question that mattered: does the outcome ever occur?
//
// So this script asks it. Six loads with hand-built timestamps go into
// the real table, markLate() runs against the real schema, and the
// resulting statuses are compared to what they must be. Everything
// happens inside a transaction that is ROLLED BACK, so no row survives
// and no ledger moves -- but PostgreSQL, not a mock, produced every
// answer along the way.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'
import { markLate, DASHBOARD_COUNTS_SQL } from '../src/modules/loads/loads.repository.js'
import { LATE_REVEAL_FRACTION } from '../src/constants/simClock.js'

// Six ids well outside anything the generator produces.
const IDS = ['990001', '990002', '990003', '990004', '990005', '990006']

// Every case is stated as: where the truck is on the clock, and what the
// status must therefore be. `null` means markLate must not touch it.
const CASES = [
  {
    id: '990001',
    name: 'vaʼda vaqti oʻtdi, hali yetkazilmadi',
    dispatchedSec: -300, promisedSec: -60, etaSec: +60,
    delivered: null,
    expect: 'crit',
    why: 'kuzatilgan fakt: vaʼda qilingan vaqt oʻtib ketdi',
  },
  {
    id: '990002',
    name: 'kechikadi, yoʻlning 66% ida (fosh boʻlgan)',
    dispatchedSec: -200, promisedSec: +100, etaSec: +160,
    delivered: null,
    expect: 'warn',
    why: `${Math.round(LATE_REVEAL_FRACTION * 100)}% chegarasidan oʻtgan — haydovchi xabar bergan boʻlardi`,
  },
  {
    id: '990003',
    name: 'kechikadi, lekin endi yoʻlga chiqdi (10%)',
    dispatchedSec: -30, promisedSec: +270, etaSec: +330,
    delivered: null,
    expect: null,
    why: 'hali fosh boʻlmagan — buni aytish bashorat boʻlardi, fakt emas',
  },
  {
    id: '990004',
    name: 'vaqtida ketyapti',
    dispatchedSec: -200, promisedSec: +100, etaSec: +90,
    delivered: null,
    expect: null,
    why: 'eta vaʼdadan oldin — kechikish yoʻq',
  },
  {
    id: '990005',
    name: 'kech yetkazildi',
    dispatchedSec: -400, promisedSec: -120, etaSec: -60,
    delivered: -60,
    expect: 'done',
    why: 'yetkazildi, lekin vaʼdadan keyin — on-time hisobiga KIRMASLIGI kerak',
  },
  {
    id: '990006',
    name: 'vaqtida yetkazildi',
    dispatchedSec: -400, promisedSec: -60, etaSec: -120,
    delivered: -120,
    expect: 'done',
    why: 'vaʼdadan oldin yetkazildi — on-time hisobiga kirishi kerak',
  },
]

const INSERT = `
  INSERT INTO loads (
    id, origin_city, origin_state, destination_city, destination_state,
    broker, commodity, rate_usd, distance_mi, weight_lbs,
    equipment_type, equipment_length_ft, status,
    booked_at, pickup_at, delivery_at,
    dispatched_at, promised_eta_at, eta_at, delivered_at
  ) VALUES (
    $1, 'Atlanta', 'GA', 'Denver', 'CO',
    'Proof Freight LLC', 'General', 2000, 800, 20000,
    'dry-van', 53, $2,
    now() - interval '2 days', now() - interval '1 day', now() + interval '1 day',
    now() + ($3::int * interval '1 second'),
    now() + ($4::int * interval '1 second'),
    now() + ($5::int * interval '1 second'),
    CASE WHEN $6::int IS NULL THEN NULL
         ELSE now() + ($6::int * interval '1 second') END
  )`

const client = await pool.connect()
let failed = 0

function report(label, ok, detail) {
  if (!ok) failed += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`)
  if (detail) console.log(`        ${detail}`)
}

try {
  await client.query('BEGIN')

  // Ids are fixed, so a leftover from an interrupted run would collide.
  // Rolled back with everything else.
  await client.query('DELETE FROM loads WHERE id = ANY($1)', [IDS])

  const before = (await client.query(DASHBOARD_COUNTS_SQL)).rows[0]

  for (const c of CASES) {
    await client.query(INSERT, [
      c.id,
      c.delivered === null ? 'ontime' : 'done',
      c.dispatchedSec, c.promisedSec, c.etaSec, c.delivered,
    ])
  }
  console.log(`\n${CASES.length} ta yuk qoʻyildi (tranzaksiya ichida).\n`)

  // --- 1. Does markLate actually fire? --------------------------------
  console.log('1) markLate() haqiqiy sxemaga qarshi:\n')
  await markLate(client)

  const after = await client.query(
    'SELECT id, status FROM loads WHERE id = ANY($1) ORDER BY id', [IDS],
  )
  const statusById = Object.fromEntries(after.rows.map((r) => [r.id, r.status]))

  for (const c of CASES) {
    const actual = statusById[c.id]
    const want = c.expect ?? (c.delivered === null ? 'ontime' : 'done')
    report(
      `${c.id}  ${c.name}  →  ${actual}`,
      actual === want,
      actual === want ? c.why : `kutilgan '${want}', olingan '${actual}'`,
    )
  }

  // The whole point. If this line ever reads 0 again, the fix is gone.
  const moved = CASES.filter((c) => c.expect === 'warn' || c.expect === 'crit').length
  const actuallyMoved = CASES.filter(
    (c) => statusById[c.id] === 'warn' || statusById[c.id] === 'crit',
  ).length
  console.log('')
  report(
    `kechikish sodir boʻldi: ${actuallyMoved} ta yuk 'ontime' dan chiqdi`,
    actuallyMoved === moved && actuallyMoved > 0,
    actuallyMoved === 0
      ? "HECH BIRI. Aynan 8-sentabrdagi holat: kod toʻgʻri koʻrinadi, natija yoʻq."
      : null,
  )

  // --- 2. Does lateness survive delivery? -----------------------------
  console.log('\n2) Yetkazilgandan keyin kechikish saqlanadimi:\n')
  const now = (await client.query(DASHBOARD_COUNTS_SQL)).rows[0]

  const dEvaluated = now.evaluatedLoads - before.evaluatedLoads
  const dOnTime = now.onTimeLoads - before.onTimeLoads
  const dAtRisk = now.atRisk - before.atRisk

  report(
    `evaluatedLoads +${dEvaluated}`,
    dEvaluated === 6,
    '6 ta yuk qoʻshildi, oltalasi ham baholanadi',
  )
  report(
    `atRisk +${dAtRisk}`,
    dAtRisk === 2,
    "990001 (crit) va 990002 (warn) — boshqasi yoʻq",
  )
  report(
    `onTimeLoads +${dOnTime}`,
    dOnTime === 3,
    dOnTime === 3
      ? '990003, 990004 (hali ontime) va 990006 (vaqtida yetkazilgan). 990005 kech yetkazildi va sanalMAYdi.'
      : `kutilgan +3. ${dOnTime === 4 ? "990005 kech yetkazildi, lekin 'vaqtida' deb sanaldi — status='done' faktni oʻchirib yubordi." : ''}`,
  )
} catch (err) {
  failed += 1
  console.error('\nISTISNO:', err.message)
  if (err.detail) console.error('        ', err.detail)
} finally {
  // Nothing written. The table is exactly as it was.
  await client.query('ROLLBACK')
  client.release()
  await pool.end()
}

console.log(failed ? `\n${failed} ta tekshiruv yiqildi.` : '\nHammasi oʻtdi. Tranzaksiya bekor qilindi — bironta satr oʻzgarmadi.')
process.exit(failed ? 1 : 0)
