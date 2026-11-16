// What is in the database. Changes nothing: every statement is a SELECT and
// the whole read runs inside a READ ONLY transaction, so the database itself
// refuses a write even if one were added here by mistake.
//
//   npm run db-state
//   npm run prod -- db-state
//
// There is one company and one cash ledger (no company_id anywhere), so
// "per company" is the whole database. The solvency block is the cash
// service's own solvency() -- the same numbers assertCanCommit decides on.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'
import { solvency } from '../src/modules/cash/solvency.service.js'
import { CREDIT_LIMIT_USD } from '../src/constants/simClock.js'

const host = (() => {
  try { return new URL(process.env.DATABASE_URL).hostname } catch { return '?' }
})()

const usd = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US')}`
const pad = (v, w) => String(v).padEnd(w)
const padL = (v, w) => String(v).padStart(w)

// The marketplaces, for context only.
const WORLD = ['load_postings', 'driver_applicants', 'truck_listings', 'brokers', 'users']

async function groupCounts(client, table, column) {
  const { rows } = await client.query(
    `SELECT coalesce(${column}::text, '(none)') AS key, count(*)::int AS n
       FROM ${table} GROUP BY 1 ORDER BY 2 DESC, 1`,
  )
  return rows
}

function printCounts(title, rows) {
  const total = rows.reduce((s, r) => s + r.n, 0)
  console.log(`  ${pad(title, 10)} total ${total}`)
  for (const r of rows) console.log(`    ${pad(r.key, 18)} ${padL(r.n, 6)}`)
}

const client = await pool.connect()
try {
  await client.query('BEGIN READ ONLY')
  console.log(`\ndatabase: ${host}\n`)

  const { rows: kinds } = await client.query(
    `SELECT kind, count(*)::int AS n, coalesce(sum(amount_usd), 0)::int AS total
       FROM cash_ledger GROUP BY kind ORDER BY sum(amount_usd), kind`,
  )
  console.log('CASH LEDGER by kind (most negative first)')
  console.log(`  ${pad('kind', 18)} ${padL('rows', 6)} ${padL('sum', 14)}`)
  let balance = 0
  let rowsTotal = 0
  for (const k of kinds) {
    balance += k.total
    rowsTotal += k.n
    console.log(`  ${pad(k.kind, 18)} ${padL(k.n, 6)} ${padL(usd(k.total), 14)}`)
  }
  console.log(`  ${pad('BALANCE', 18)} ${padL(rowsTotal, 6)} ${padL(usd(balance), 14)}`)
  const biggestDrain = kinds.find((k) => k.total < 0)
  if (biggestDrain && biggestDrain.kind !== 'opening') {
    console.log(`  biggest drain: ${biggestDrain.kind} (${usd(biggestDrain.total)})`)
  }

  const s = await solvency(client)
  console.log('\nSOLVENCY (cash.service solvency())')
  const lines = [
    ['state', s.state],
    ['balance', usd(s.balanceUsd)],
    ['assets', usd(s.assetsUsd)],
    ['  receivables', usd(s.receivablesUsd)],
    ['  fleet value', `${usd(s.fleetValueUsd)} (${s.truckCount} trucks)`],
    ['liabilities', usd(s.liabilitiesUsd)],
    ['  unpaid wages', usd(s.unpaidWagesUsd)],
    ['net worth', usd(s.netWorthUsd)],
    ['credit limit', usd(CREDIT_LIMIT_USD)],
    ['credit headroom', `${usd(s.creditAvailableUsd)}${s.creditAvailableUsd < 0 ? '  (line used up)' : ''}`],
    ['over the limit by', usd(s.overLimitUsd)],
  ]
  for (const [k, v] of lines) console.log(`  ${pad(k, 20)} ${v}`)

  console.log('\nCOMPANY')
  printCounts('drivers', await groupCounts(client, 'drivers', "'all'"))
  printCounts('trucks', await groupCounts(client, 'trucks', 'status'))
  printCounts('loads', await groupCounts(client, 'loads', 'status'))

  console.log('\nWORLD')
  const parts = WORLD.map((t) => `(SELECT count(*) FROM ${t})::int AS ${t}`)
  const { rows: [world] } = await client.query(`SELECT ${parts.join(', ')}`)
  for (const [k, v] of Object.entries(world)) console.log(`  ${pad(k, 20)} ${padL(v, 6)}`)
  console.log('')
} finally {
  await client.query('ROLLBACK').catch(() => {})
  client.release()
  await pool.end()
}
