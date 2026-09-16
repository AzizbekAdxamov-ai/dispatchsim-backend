// Bazada nima bor. Hech narsani o'zgartirmaydi.
//
//   npm run db:state
//   npm run prod -- db:state
//
// Reset qilishdan oldin ko'rish uchun. "Bazada nimadir bor ekan" degan
// taassurot bilan ma'lumot o'chirish — eng qimmat xatoning boshlanishi.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'

const host = (() => {
  try { return new URL(process.env.DATABASE_URL).hostname } catch { return '?' }
})()

// Kompaniyaga tegishli (reset o'chiradi) va dunyoga tegishli (qoladi).
const COMPANY = [
  'drivers', 'trucks', 'loads', 'driver_settlements', 'load_events',
  'driver_conversations', 'driver_messages', 'broker_conversations',
  'broker_messages', 'broker_checks', 'maintenance_records',
  'truck_daily_metrics', 'alert_acks', 'cash_ledger',
]
const WORLD = ['load_postings', 'driver_applicants', 'truck_listings', 'brokers', 'users', 'invite_codes']

async function counts(tables) {
  const parts = tables.map((t) => `(SELECT count(*) FROM ${t})::int AS ${t}`)
  const { rows } = await pool.query(`SELECT ${parts.join(', ')}`)
  return rows[0]
}

try {
  console.log(`\nbaza: ${host}\n`)

  console.log('KOMPANIYA (reset o\'chiradi)')
  const company = await counts(COMPANY)
  let companyTotal = 0
  for (const [k, v] of Object.entries(company)) {
    companyTotal += v
    if (v > 0) console.log(`  ${k.padEnd(22)} ${String(v).padStart(6)}`)
  }
  if (companyTotal === 0) console.log('  (bo\'sh)')

  console.log('\nDUNYO (reset tegmaydi)')
  for (const [k, v] of Object.entries(await counts(WORLD))) {
    console.log(`  ${k.padEnd(22)} ${String(v).padStart(6)}`)
  }

  const { rows: [bal] } = await pool.query(
    `SELECT coalesce(sum(amount_usd), 0)::int AS balance,
            count(*)::int AS entries,
            count(*) FILTER (WHERE kind = 'opening')::int AS openings
       FROM cash_ledger`,
  )
  console.log(`\nBALANS  $${bal.balance.toLocaleString('en-US')}  (${bal.entries} ta yozuv, ${bal.openings} ta ochilish)`)

  // Board sog'ligi: ko'rinadigan e'lon soni. Bo'sh board — birinchi
  // foydalanuvchi hech narsa qila olmaydi degani.
  const { rows: [board] } = await pool.query(`
    SELECT count(*) FILTER (WHERE status = 'open' AND posted_at <= now() AND expires_at > now())::int AS live,
           count(*)::int AS total
      FROM load_postings`)
  console.log(`BOARD   ${board.live} ta ko'rinadi (jami ${board.total})`)

  const { rows: [u] } = await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE is_admin)::int AS admins FROM users`)
  console.log(`USERS   ${u.total} ta (${u.admins} ta admin)\n`)
} finally {
  await pool.end()
}
