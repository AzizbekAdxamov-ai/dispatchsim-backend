// The pure parts of scripts/owner-capital.js and scripts/raise-event.js:
// argument parsing, validation, the event-kind map, the suggested amount,
// the remote guard and the refusal rules. The scripts' database work is run
// by hand against the local database.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseOwnerCapitalArgs, validateAmount, suggestedContributionUsd,
  OWNER_CAPITAL_MAX_USD, TARGET_BALANCE_USD, isRecentDuplicate, DUPLICATE_WINDOW_MINUTES,
} from '../scripts/ownerCapitalPlan.js'
import {
  parseRaiseEventArgs, mapEventKind, refusalReason, previewOptions,
  EVENT_KIND_BY_CLI, CLI_EVENT_KINDS,
} from '../scripts/raiseEventPlan.js'
import { hostOf, remoteRefusal } from '../scripts/cliGuards.js'
import { EVENT_KEYS } from '../src/constants/loadEvents.js'
import { REAL_MS_PER_SIM_DAY } from '../src/constants/simClock.js'

const CAPITAL_AMOUNT = 141649
const HOURS_PER_DAY = 24
const MS_PER_SECOND = 1000
const NEGATIVE_BALANCE = -91649

// ---- owner-capital ----

// Kills: accepting zero, negative, fractional or exponent amounts, which would
// reach an integer column as garbage or write a debit as "capital".
test('validateAmount accepts only positive whole dollars', () => {
  assert.deepEqual(validateAmount('141649'), { amountUsd: CAPITAL_AMOUNT })
  for (const bad of ['0', '-5', '12.5', '1e5', 'abc', '', undefined, '$100', '1,000']) {
    assert.ok(validateAmount(bad).error, `should reject ${bad}`)
  }
})

// Kills: the upper bound being off by one or missing (a typo'd extra zero
// would be written as real money).
test('validateAmount enforces the limit inclusively', () => {
  assert.equal(validateAmount(String(OWNER_CAPITAL_MAX_USD)).amountUsd, OWNER_CAPITAL_MAX_USD)
  assert.ok(validateAmount(String(OWNER_CAPITAL_MAX_USD + 1)).error)
})

// Kills: a suggestion that is not target minus balance, or that goes negative
// (a "contribution" of negative dollars) when the balance is already above it.
test('suggestedContributionUsd brings the balance to the target and never below zero', () => {
  assert.equal(suggestedContributionUsd(NEGATIVE_BALANCE), TARGET_BALANCE_USD - NEGATIVE_BALANCE)
  assert.equal(suggestedContributionUsd(0), TARGET_BALANCE_USD)
  assert.equal(suggestedContributionUsd(TARGET_BALANCE_USD), 0)
  assert.equal(suggestedContributionUsd(TARGET_BALANCE_USD * 4), 0)
})

// Kills: --confirm defaulting to true (a dry run that writes), and flags being
// dropped or swallowing the amount.
test('parseOwnerCapitalArgs defaults to a dry run and reads both flags', () => {
  assert.deepEqual(parseOwnerCapitalArgs(['100']), { amountUsd: 100, confirm: false, allowRemote: false, forceDuplicate: false })
  assert.deepEqual(
    parseOwnerCapitalArgs(['--confirm', '100', '--allow-remote']),
    { amountUsd: 100, confirm: true, allowRemote: true, forceDuplicate: false },
  )
})

// Kills: unknown flags (including a mistyped --confirm) being ignored, and a
// second amount being silently dropped.
test('parseOwnerCapitalArgs rejects unknown options, --company and extra amounts', () => {
  assert.ok(parseOwnerCapitalArgs(['100', '--confrim']).error)
  assert.match(parseOwnerCapitalArgs(['100', '--company', '1']).error, /one company/)
  assert.match(parseOwnerCapitalArgs(['100', '--company=1']).error, /one company/)
  assert.ok(parseOwnerCapitalArgs(['100', '200']).error)
  assert.ok(parseOwnerCapitalArgs([]).error)
})

// ---- remote guard ----

// Kills: a remote host passing without the flag, a local one being refused,
// and an unreadable URL being treated as local.
test('remoteRefusal lets local through and demands --allow-remote elsewhere', () => {
  assert.equal(remoteRefusal('localhost', false), null)
  assert.equal(remoteRefusal('127.0.0.1', false), null)
  assert.match(remoteRefusal('db.example.com', false), /--allow-remote/)
  assert.equal(remoteRefusal('db.example.com', true), null)
  assert.match(remoteRefusal(null, false), /unreadable/)
})

// Kills: hostOf throwing on a bad URL instead of returning null.
test('hostOf reads the host and returns null for garbage', () => {
  assert.equal(hostOf('postgres://u:p@db.example.com:5432/x'), 'db.example.com')
  assert.equal(hostOf('not a url'), null)
  assert.equal(hostOf(undefined), null)
})

// ---- raise-event ----

// Kills: road_closure being passed through as-is (no such key in the
// catalogue) or any mapped key that does not exist in EVENT_TYPES.
test('every command-line kind maps to a real catalogue key', () => {
  assert.equal(mapEventKind('road_closure'), 'roadClosure')
  assert.equal(mapEventKind('weather'), 'weather')
  for (const cli of CLI_EVENT_KINDS) assert.ok(EVENT_KEYS.includes(mapEventKind(cli)), cli)
  assert.deepEqual([...CLI_EVENT_KINDS].sort(), Object.keys(EVENT_KIND_BY_CLI).sort())
})

// Kills: inherited object keys (toString, constructor) passing as kinds, and
// the catalogue key spelling (roadClosure) being accepted on the command line.
test('mapEventKind rejects anything that is not a listed word', () => {
  for (const bad of ['toString', 'constructor', 'roadClosure', 'flood', '', undefined]) {
    assert.equal(mapEventKind(bad), null, String(bad))
  }
})

// Kills: argument order swapped, a missing kind accepted, and --confirm
// defaulting on.
test('parseRaiseEventArgs reads load, kind and flags', () => {
  assert.deepEqual(
    parseRaiseEventArgs(['600011', 'road_closure']),
    { loadId: '600011', cliKind: 'road_closure', eventType: 'roadClosure', confirm: false, allowRemote: false },
  )
  assert.equal(parseRaiseEventArgs(['600011', 'weather', '--confirm', '--allow-remote']).confirm, true)
  assert.equal(parseRaiseEventArgs(['600011', 'weather', '--confirm', '--allow-remote']).allowRemote, true)
  assert.ok(parseRaiseEventArgs(['600011']).error)
  assert.ok(parseRaiseEventArgs(['600011', 'flood']).error)
  assert.ok(parseRaiseEventArgs(['600011', 'weather', '--confrim']).error)
  assert.ok(parseRaiseEventArgs(['600011', 'weather', 'extra']).error)
})

const inTransit = {
  id: '1', status: 'ontime', dispatchedAt: '2026-11-16T10:00:00Z', etaAt: '2026-11-16T11:00:00Z', deliveredAt: null,
}

// Kills: each refusal rule being dropped -- a delivered, undispatched or
// non-transit load, or one that already has an open event, getting a second.
test('refusalReason refuses what the tick would never roll', () => {
  assert.equal(refusalReason({ load: inTransit, openEvent: null }), null)
  assert.equal(refusalReason({ load: { ...inTransit, status: 'warn' }, openEvent: null }), null)
  assert.equal(refusalReason({ load: { ...inTransit, status: 'crit' }, openEvent: null }), null)
  assert.match(refusalReason({ load: null, openEvent: null }), /not found/)
  assert.match(refusalReason({ load: { ...inTransit, deliveredAt: 'x' }, openEvent: null }), /delivered/)
  assert.match(refusalReason({ load: { ...inTransit, dispatchedAt: null }, openEvent: null }), /not dispatched/)
  assert.match(refusalReason({ load: { ...inTransit, etaAt: null }, openEvent: null }), /no ETA/)
  assert.match(refusalReason({ load: { ...inTransit, status: 'neutral' }, openEvent: null }), /not in transit/)
  assert.match(refusalReason({ load: inTransit, openEvent: { id: 7, eventType: 'weather' } }), /open weather event .#7./)
})

// Kills: the ETA shift using hours as seconds, or ignoring the sim clock
// (REAL_MS_PER_SIM_DAY), which would show an ETA the resolve would not give.
test('previewOptions shifts the ETA by the option hours on the sim clock', () => {
  const eta = '2026-11-16T11:00:00.000Z'
  const options = previewOptions('weather', eta)
  const wait = options.find((o) => o.key === 'wait')
  const expectedMs = (wait.hours / HOURS_PER_DAY) * REAL_MS_PER_SIM_DAY
  assert.equal(wait.etaAfter.getTime() - new Date(eta).getTime(), expectedMs)
  assert.equal(wait.etaShiftSec * MS_PER_SECOND, expectedMs)
  const reroute = options.find((o) => o.key === 'reroute')
  assert.ok(reroute.costUsd > 0 && reroute.extraMiles > 0)
})

// ---- owner-capital duplicate guard ----

const DUPLICATE_BASE = '2026-11-16T12:00:00Z'
const minutesAfter = (m) => new Date(new Date(DUPLICATE_BASE).getTime() + m * 60000)

// Kills: no guard, a boundary off by one, or a missing previous row being
// read as a duplicate (the very first contribution would be refused).
test('isRecentDuplicate is true only inside the window', () => {
  assert.equal(isRecentDuplicate(null, minutesAfter(1)), false)
  assert.equal(isRecentDuplicate(DUPLICATE_BASE, minutesAfter(DUPLICATE_WINDOW_MINUTES - 1)), true)
  assert.equal(isRecentDuplicate(DUPLICATE_BASE, minutesAfter(DUPLICATE_WINDOW_MINUTES)), false)
  assert.equal(isRecentDuplicate(DUPLICATE_BASE, minutesAfter(DUPLICATE_WINDOW_MINUTES + 1)), false)
})

// Kills: --force-duplicate not parsed (the override unusable) or on by default.
test('parseOwnerCapitalArgs reads --force-duplicate, off by default', () => {
  assert.equal(parseOwnerCapitalArgs(['100']).forceDuplicate, false)
  assert.equal(parseOwnerCapitalArgs(['100', '--force-duplicate']).forceDuplicate, true)
})
