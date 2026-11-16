// Put owner capital into the company: ONE cash_ledger row, kind 'adjustment'.
//
//   node scripts/owner-capital.js 141649              # dry run (default)
//   node scripts/owner-capital.js 141649 --confirm    # writes
//   --allow-remote                                    # needed for a non-local database
//
// The dry run does the real insert inside a transaction and rolls it back,
// so "after" is what the database itself computes, not a guess. Nothing
// persists (a rolled-back insert may skip one ledger id; that is all).
//
// The row goes through cash.service receive() -> cash.repository addEntry(),
// the one place ledger rows are written: positive amount = money in, the
// balance is the sum of the ledger (no cache column to update).
//
// Note: `npm run prod --` appends --allow-remote itself, so against prod the
// real guard is --confirm. Read the dry run first.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'
import { receive } from '../src/modules/cash/cash.service.js'
import { solvency } from '../src/modules/cash/solvency.service.js'
import { hostOf, remoteRefusal } from './cliGuards.js'
import {
  OWNER_CAPITAL_KIND, OWNER_CAPITAL_DESCRIPTION, TARGET_BALANCE_USD,
  parseOwnerCapitalArgs, suggestedContributionUsd,
} from './ownerCapitalPlan.js'

const usd = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US')}`

function fail(message) {
  console.error(message)
  process.exit(1)
}

const args = parseOwnerCapitalArgs(process.argv.slice(2))
if (args.error) fail(args.error)

const host = hostOf(process.env.DATABASE_URL)
const refusal = remoteRefusal(host, args.allowRemote)
if (refusal) fail(refusal)

function show(label, s) {
  console.log(`  ${label.padEnd(7)} balance ${usd(s.balanceUsd).padStart(10)}   state ${s.state}   credit headroom ${usd(s.creditAvailableUsd)}`)
}

const client = await pool.connect()
try {
  console.log(`\n${args.confirm ? 'WRITE' : 'DRY RUN'} - ${host}\n`)
  await client.query('BEGIN')

  const before = await solvency(client)
  const row = await receive(client, {
    kind: OWNER_CAPITAL_KIND,
    amountUsd: args.amountUsd,
    description: OWNER_CAPITAL_DESCRIPTION,
  })
  const after = await solvency(client)

  console.log(`  ${OWNER_CAPITAL_KIND} +${usd(args.amountUsd)}  "${OWNER_CAPITAL_DESCRIPTION}"`)
  show('before', before)
  show('after', after)
  const suggested = suggestedContributionUsd(before.balanceUsd)
  console.log(`  to reach ${usd(TARGET_BALANCE_USD)}: ${usd(suggested)}`)

  if (args.confirm) {
    await client.query('COMMIT')
    console.log(`\n  written: ledger row #${row.id}\n`)
  } else {
    await client.query('ROLLBACK')
    console.log('\n  nothing written. Run again with --confirm to write.\n')
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {})
  console.error(`\nfailed, nothing changed: ${err.message}\n`)
  process.exitCode = 1
} finally {
  client.release()
  await pool.end()
}
