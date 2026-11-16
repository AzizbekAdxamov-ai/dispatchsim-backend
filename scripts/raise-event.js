// Force a road event on a load that is in transit.
//
//   node scripts/raise-event.js <loadId> <weather|breakdown|detention|accident|road_closure>
//   node scripts/raise-event.js 600007 breakdown --confirm
//   --allow-remote                         # needed for a non-local database
//
// Admin tool, run by whoever has database access. With --confirm it goes
// through loadEvents.service raiseOnLoad() -- the same code the tick's random
// roll ends in: the event row, the open wait on the driver's log, and the
// driver's own chat report ~12 s later. EVENT_CHANCE_PER_LOAD is untouched.
//
// What it does NOT do: move the ETA. The ETA moves, and the HOS replan runs,
// when the dispatcher RESOLVES the event (loadEvents.service.js resolve()).
// Until then the load simply cannot deliver. The dry run lists each option's
// ETA shift and cost so you can see what resolving would do.
//
// The dry run writes nothing: it only reads the load and the open event.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'
import { loadForEvent, raiseOnLoad, placeFor } from '../src/modules/loadEvents/loadEvents.service.js'
import { EVENT_TYPES } from '../src/constants/loadEvents.js'
import { hostOf, remoteRefusal } from './cliGuards.js'
import { parseRaiseEventArgs, refusalReason, previewOptions } from './raiseEventPlan.js'

const usd = (n) => `$${n.toLocaleString('en-US')}`
const iso = (d) => new Date(d).toISOString()

function fail(message) {
  console.error(message)
  process.exit(1)
}

const args = parseRaiseEventArgs(process.argv.slice(2))
if (args.error) fail(args.error)

const host = hostOf(process.env.DATABASE_URL)
// A dry run only reads, so only a write needs the remote flag.
if (args.confirm) {
  const refusal = remoteRefusal(host, args.allowRemote)
  if (refusal) fail(refusal)
}

try {
  console.log(`\n${args.confirm ? 'RAISE' : 'DRY RUN'} - ${host}\n`)
  const found = await loadForEvent(args.loadId)
  const reason = refusalReason(found ?? { load: null, openEvent: null })
  if (reason) fail(`  refused: ${reason}\n`)

  const { load } = found
  const place = placeFor(load, Number(load.elapsedFraction))
  console.log(`  load      ${load.id}  ${load.originCity}, ${load.originState} -> ${load.destinationCity}, ${load.destinationState}`)
  console.log(`  driver    ${load.driverName ?? '(none)'}   status ${load.status}`)
  console.log(`  ETA       ${iso(load.etaAt)}   promised ${load.promisedEtaAt ? iso(load.promisedEtaAt) : '-'}`)
  console.log(`  event     ${args.cliKind} (${args.eventType}: ${EVENT_TYPES[args.eventType].summary}) near ${place}`)
  console.log(`  driver    would say: "${EVENT_TYPES[args.eventType].report({ place })}"`)
  console.log('  options when resolved (ETA moves only then; HOS replan may add more):')
  for (const o of previewOptions(args.eventType, load.etaAt)) {
    const extras = [
      `+${o.hours}h (${o.etaShiftSec}s real)`,
      `cost ${usd(o.costUsd)}`,
      o.extraMiles ? `${o.extraMiles} extra mi` : null,
      o.accessorialUsd ? `billable +${usd(o.accessorialUsd)}` : null,
      `ETA -> ${iso(o.etaAfter)}`,
    ].filter(Boolean)
    console.log(`    ${o.key.padEnd(16)} ${extras.join('   ')}`)
  }

  if (!args.confirm) {
    console.log('\n  nothing written. Run again with --confirm to raise it.\n')
  } else {
    const event = await raiseOnLoad({ load, eventType: args.eventType, place })
    if (!event) fail('\n  not raised: the load got an open event in the meantime\n')
    console.log(`\n  raised: event #${event.id} at ${iso(event.occurredAt)}\n`)
  }
} catch (err) {
  console.error(`\nfailed: ${err.message}\n`)
  process.exitCode = 1
} finally {
  await pool.end()
}

