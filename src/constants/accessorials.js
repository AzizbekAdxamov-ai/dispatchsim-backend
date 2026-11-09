// What a broker pays beyond the rate: detention, TONU, layover, lumper.
//
// Found by the 2026-10-05 external run: asked about TONU, one broker said
// $350 and another $75 the same afternoon, and neither figure reached the
// rate confirmation. The model was inventing terms per chat. Now each
// broker has terms -- one set, the same on every load they post -- and
// the chat and the paper read them from here.
//
// Ranges, sources checked 2026-10-05:
//   Detention  https://otrucking.com/resources/guides/detention-pay-rates-2026/
//              dry van / reefer $50-90/hr, specialized (flatbed, step deck)
//              $75-125/hr; free time 2 hours, specialized "may allow 3";
//              ATRI 2025 average $63/hr cited there.
//   TONU, layover, lumper
//              https://otrucking.com/resources/guides/accessorial-charges-list/
//              TONU $150-500; layover $75-300/day; lumper costs are passed
//              back and invoiced to the party on the rate confirmation.
// Neither page carries a publish date; both are a carrier-side guide, not
// a survey. Dispatchers' own numbers replace these when they arrive.
//
// Where in the range a broker sits comes from a hash of their name: fixed
// for that broker, different between brokers, and not something a
// student can learn once and stop asking about.

import { hash01 } from '../lib/stableHash.js'
import { tarpFor } from './freightHandling.js'

export const DETENTION_PER_HOUR = Object.freeze({ standard: Object.freeze([50, 90]), specialized: Object.freeze([75, 125]) })
export const FREE_HOURS = Object.freeze({ standard: 2, specialized: 3 })
export const TONU_USD = Object.freeze([150, 500])
export const LAYOVER_PER_DAY = Object.freeze([75, 300])
// Tarp pay per load, paid on freight that must be tarped. Dispatch-company
// pages (not a survey), checked 2026-11-10:
//   https://otrucking.com/resources/guides/flatbed-tarping-guide/
//   https://lane-math.pages.dev/accessorials/tarp-pay/
export const TARP_PAY_USD = Object.freeze([75, 150])
const TARP_PAY_STEP_USD = 25

// The source names flatbed and step deck as specialized (and hazmat,
// which this program does not model). Everything else is standard.
const SPECIALIZED = new Set(['flatbed', 'step-deck'])

function pickIn([lo, hi], unit, key) {
  return Math.round((lo + hash01(key) * (hi - lo)) / unit) * unit
}

export function brokerTerms(brokerName, equipmentType, commodity = null) {
  const kind = SPECIALIZED.has(equipmentType) ? 'specialized' : 'standard'
  const name = String(brokerName ?? '')
  const tarp = tarpFor({ equipmentType, commodity })
  return {
    openDeck: kind === 'specialized',
    detentionPerHour: pickIn(DETENTION_PER_HOUR[kind], 5, `${name}:detention:${kind}`),
    freeHours: FREE_HOURS[kind],
    tonuUsd: pickIn(TONU_USD, 25, `${name}:tonu`),
    layoverPerDay: pickIn(LAYOVER_PER_DAY, 25, `${name}:layover`),
    tarp,
    tarpPayUsd: tarp?.needed ? pickIn(TARP_PAY_USD, TARP_PAY_STEP_USD, `${name}:tarp`) : null,
  }
}

// The terms as a broker says them and a rate confirmation prints them.
//
// Open-deck detention is its own figure (the source prices it higher, with
// an hour more free), and the line says so: in the 2026-10-06 scenario run
// a broker quoted its flatbed detention as "same terms across the board"
// as its dry-van one, which it was not.
export function termsLines(t) {
  return [
    `Detention${t.openDeck ? ' (open-deck freight)' : ''}: $${t.detentionPerHour}/hr after ${t.freeHours} hours free, at pickup or delivery.`,
    `TONU: $${t.tonuUsd} if the load is cancelled after the truck is dispatched.`,
    `Layover: $${t.layoverPerDay} per day if the truck has to wait overnight.`,
    ...(t.tarpPayUsd ? [`Tarp pay: $${t.tarpPayUsd} per load (${t.tarp.kind}).`] : []),
    'Lumper: paid by the broker against a receipt.',
  ]
}
