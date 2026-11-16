// The pure half of raise-event.js: the command line, the event-kind map, and
// what a forced event would do. No database, no process.

import { EVENT_KEYS, optionsFor } from '../src/constants/loadEvents.js'
import { simDaysToSeconds } from '../src/constants/simClock.js'
import { IN_TRANSIT_STATUSES } from '../src/modules/loadEvents/loadEvents.sql.js'

// The command-line word -> the key in EVENT_TYPES. Only road_closure differs
// (the catalogue keys it roadClosure). A word with no entry here is rejected,
// never guessed at.
export const EVENT_KIND_BY_CLI = Object.freeze({
  weather: 'weather',
  breakdown: 'breakdown',
  detention: 'detention',
  accident: 'accident',
  road_closure: 'roadClosure',
})

export const CLI_EVENT_KINDS = Object.freeze(Object.keys(EVENT_KIND_BY_CLI))

const HOURS_PER_DAY = 24
const MS_PER_SECOND = 1000
const FLAG_CONFIRM = '--confirm'
const FLAG_ALLOW_REMOTE = '--allow-remote'
const EXPECTED_POSITIONALS = 2

// The catalogue key for a command-line word, or null. Checked against
// EVENT_KEYS as well, so a catalogue rename cannot leave a dead mapping.
export function mapEventKind(cliKind) {
  if (!Object.hasOwn(EVENT_KIND_BY_CLI, cliKind)) return null
  const key = EVENT_KIND_BY_CLI[cliKind]
  return EVENT_KEYS.includes(key) ? key : null
}

export function parseRaiseEventArgs(argv) {
  let confirm = false
  let allowRemote = false
  const positional = []
  for (const arg of argv) {
    if (arg === FLAG_CONFIRM) confirm = true
    else if (arg === FLAG_ALLOW_REMOTE) allowRemote = true
    else if (arg.startsWith('--')) return { error: `unknown option ${arg}` }
    else positional.push(arg)
  }
  if (positional.length !== EXPECTED_POSITIONALS) {
    return { error: `usage: raise-event <loadId> <${CLI_EVENT_KINDS.join('|')}> [--confirm] [--allow-remote]` }
  }
  const [loadId, cliKind] = positional
  const eventType = mapEventKind(cliKind)
  if (!eventType) return { error: `unknown event kind "${cliKind}"; use one of ${CLI_EVENT_KINDS.join(', ')}` }
  return { loadId, cliKind, eventType, confirm, allowRemote }
}

// Why this load cannot take an event, or null when it can. The same facts
// the tick's query selects on (IN_TRANSIT_LOADS_SQL), plus the open-event
// rule (load_events_one_open) -- stated as reasons rather than a silent skip.
export function refusalReason({ load, openEvent }) {
  if (!load) return 'load not found'
  if (load.deliveredAt) return 'load is already delivered'
  if (!load.dispatchedAt) return 'load is not dispatched'
  if (!load.etaAt) return 'load has no ETA'
  if (!IN_TRANSIT_STATUSES.includes(load.status)) {
    return `load is "${load.status}", not in transit (${IN_TRANSIT_STATUSES.join('/')})`
  }
  if (openEvent) return `load already has an open ${openEvent.eventType} event (#${openEvent.id}); resolve it first`
  return null
}

// What each option would do if chosen, with the ETA it would give. The ETA
// moves only when an option is resolved (loadEvents.service.js resolveInner),
// by the option's SIMULATED hours on the compressed clock. The HOS replan
// that follows can move it further; that is not previewed here.
export function previewOptions(eventType, etaAt) {
  const etaMs = new Date(etaAt).getTime()
  return optionsFor(eventType).map((o) => {
    const shiftSec = simDaysToSeconds(o.hours / HOURS_PER_DAY)
    return {
      key: o.key,
      label: o.label,
      hours: o.hours,
      extraMiles: o.extraMiles,
      costUsd: o.costUsd,
      accessorialUsd: o.accessorialUsd,
      etaShiftSec: shiftSec,
      etaAfter: new Date(etaMs + shiftSec * MS_PER_SECOND),
    }
  })
}
