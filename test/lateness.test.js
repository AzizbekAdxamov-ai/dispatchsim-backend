// The tests that would have caught 2026-09-08.
//
// That day the lateness fix passed `node --check`, passed review, and
// passed a 100,000-roll check of delayFactor's distribution -- and no
// load could be late. The distribution was fine. The OUTCOME never
// occurred, because eta_at was compared against a timestamp on the other
// clock. Every assertion here is therefore about an outcome, not a shape.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  simDaysToSeconds,
  REAL_SEC_PER_SIM_DAY,
} from '../src/constants/simClock.js'
import {
  EVENT_CHANCE_PER_LOAD, chanceForFraction, pickEventType,
  EVENT_KEYS, EVENT_TYPES, optionsFor, resolveOption,
} from '../src/constants/loadEvents.js'
import { seeded } from './helpers/rng.js'

test('one load in five meets something, at ANY scheduler cadence', () => {
  // This is the test that would have caught the shipped defect. The first
  // version divided the run into ticks using a hardcoded 30-second
  // cadence; Vercel's cron floor is 60 seconds, so production rolled half
  // as often and about one load in TEN met something. The old test
  // asserted the code against its own constant and passed the whole time.
  //
  // The rate is now taken from elapsed time, so the number of checks does
  // not matter. Every count below has to land on the same total.
  for (const checks of [1, 2, 4, 8, 16, 40, 137]) {
    let survives = 1
    for (let i = 0; i < checks; i += 1) survives *= 1 - chanceForFraction(1 / checks)
    const total = 1 - survives
    assert.ok(
      Math.abs(total - EVENT_CHANCE_PER_LOAD) < 1e-9,
      `${checks} ta tekshiruv: ${(total * 100).toFixed(4)}%`,
    )
  }
})

test('uneven checks still add up -- a missed hour does not change the rate', () => {
  // A deploy, a cold start, a cron that skipped: the fractions between
  // checks become uneven. They still sum to one run, so the total must not
  // move.
  const fractions = [0.05, 0.4, 0.02, 0.33, 0.2]
  const sum = fractions.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - 1) < 1e-9, 'test setup')
  let survives = 1
  for (const f of fractions) survives *= 1 - chanceForFraction(f)
  assert.ok(Math.abs(1 - survives - EVENT_CHANCE_PER_LOAD) < 1e-9)
})

test('a zero or negative stretch of road meets nothing', () => {
  // sinceCheckFraction is NULL for a load with no transit window, and
  // Number(null) is 0. A roll on that must be impossible, not certain.
  for (const f of [0, -1, Number.NaN, null, undefined]) {
    assert.equal(chanceForFraction(f), 0, `${f}`)
  }
  assert.ok(chanceForFraction(1) > 0 && chanceForFraction(1) < 1)
  // Clamped: a fraction over 1 cannot exceed the per-load rate.
  assert.equal(chanceForFraction(5), chanceForFraction(1))
})

test('every event type can be drawn, and every option is priced', () => {
  const rng = seeded(4)
  const seen = new Set()
  for (let i = 0; i < 20000; i += 1) seen.add(pickEventType(rng))
  // A type nobody can draw is dead weight that reads as content. The one
  // exception is a weight-0 type: raised on purpose by a report, never by dice.
  const drawable = EVENT_KEYS.filter((k) => EVENT_TYPES[k].weight > 0)
  assert.equal(seen.size, drawable.length)
  assert.ok(!seen.has('accident'))

  for (const type of EVENT_KEYS) {
    const options = optionsFor(type)
    assert.ok(options.length >= 2, `${type} uchun tanlov yo'q`)
    for (const o of options) {
      assert.ok(Number.isInteger(o.hours) && o.hours >= 0, `${type}/${o.key}`)
      assert.ok(Number.isInteger(o.costUsd) && o.costUsd >= 0, `${type}/${o.key}`)
    }
  }
})

test('no option is free of both money and time', () => {
  // An option with no downside would be the program telling the student
  // which one to pick. Every choice has to cost hours, dollars, or both.
  for (const type of EVENT_KEYS) {
    for (const o of optionsFor(type)) {
      assert.ok(o.hours > 0 || o.costUsd > 0, `${type}/${o.key} hech narsaga tushmaydi`)
    }
  }
})

test('the faster option is the expensive one, in every event', () => {
  // Not a rule the code enforces -- a check that the catalogue actually
  // presents a trade rather than a right answer and a wrong one.
  for (const type of EVENT_KEYS) {
    const options = optionsFor(type).filter((o) => !o.accessorialUsd)
    if (options.length < 2) continue
    const byHours = [...options].sort((a, b) => a.hours - b.hours)
    assert.ok(
      byHours[0].costUsd >= byHours[byHours.length - 1].costUsd,
      `${type}: tezrog'i arzonroq — bu tanlov emas`,
    )
  }
})

test('an unknown event or option resolves to nothing rather than to zero', () => {
  // Zero would charge nothing and add no hours while still marking the
  // event resolved -- a free pass that looks like a working feature.
  assert.equal(resolveOption('blizzard-of-the-century', 'wait'), null)
  assert.equal(resolveOption('weather', 'teleport'), null)
})

// THE test. Not "is the distribution right" -- "can a load be late at all".
test('a late factor survives the conversion to whole seconds', () => {
  // Every transit window the posting generator can produce, and the
  // smallest delay the minor band can roll.
  for (let days = 0.5; days <= 5; days += 0.25) {
    const promised = simDaysToSeconds(days)
    const eta = simDaysToSeconds(days * 1.05)
    assert.ok(
      eta > promised,
      `${days} kunlik oyna: promised ${promised}s, eta ${eta}s -- yaxlitlash kechikishni yeb yubordi`,
    )
  }
})

// Kills: REAL_SEC_PER_SIM_DAY or simDaysToSeconds drifting back to the 2-minute day (ratio 720, 240 s)
test('the two clocks are 48x apart, which is why they must never be compared', () => {
  // The real bug, stated as arithmetic. A 2-day promise is 60 real minutes
  // on the compressed clock (30 min/day since 2026-11-08) and 48 real
  // hours on the real one. Any comparison between the two is 48x wrong, and always in the same
  // direction, which is why it looked like "no load is ever late" rather
  // than like a bug.
  const simSeconds = simDaysToSeconds(2)
  const realSeconds = 2 * 24 * 60 * 60
  assert.equal(simSeconds, 3600)
  assert.equal(realSeconds / simSeconds, 48)
  assert.equal(REAL_SEC_PER_SIM_DAY, 1800)
})

test('simDaysToSeconds returns whole seconds and never zero', () => {
  // make_interval's `mins` argument is an integer and rejects the
  // fractional day counts a transit window produces; the conversion has
  // to land on an integer here or PostgreSQL refuses the statement.
  for (const d of [0, 0.001, 0.5, 1, 1.333, 2, 4.75]) {
    const s = simDaysToSeconds(d)
    assert.equal(s, Math.trunc(s), `${d} kun -> ${s}`)
    assert.ok(s >= 1, `${d} kun -> ${s}`)
  }
})


test('the ledger has a word for a tow, and it is not fuel', async () => {
  // A $1,450 tow booked as 'fuel' would put it in the fuel line of every
  // expense report and make cost-per-mile quietly wrong -- the same class
  // of defect as two settlement systems disagreeing: the number is right
  // and what it is called is not. Migration 027 adds 'road_event'.
  const { readFile } = await import('node:fs/promises')
  const sql = await readFile(
    new URL('../src/db/migrations/027_load_events.sql', import.meta.url), 'utf8',
  )
  assert.match(sql, /'road_event'/)
  // And it has to be in the once-per-reference index, or resolving an
  // event twice could charge twice even though load_events refuses it.
  const idx = sql.slice(sql.indexOf('cash_ledger_once_per_ref'))
  assert.match(idx, /road_event/)
})

test('a load with an open event does not arrive', async () => {
  // The mechanic that makes an event a decision rather than a
  // notification: ignoring one has to cost something. If claimArrivedLoads
  // still picked up a stopped truck, the load would deliver on time while
  // the driver was reporting a breakdown, and ignoring events would be the
  // winning strategy.
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(
    new URL('../src/modules/loads/loads.repository.js', import.meta.url), 'utf8',
  )
  // Anchored on the function DECLARATIONS. Slicing between the bare words
  // took the first mention of markDelivered, which is inside a comment 160
  // lines earlier -- a backwards slice, an empty string, and a test that
  // failed for a reason that had nothing to do with the code it checks.
  const start = src.indexOf('export async function claimArrivedLoads')
  const end = src.indexOf('export async function markDelivered')
  assert.ok(start > 0 && end > start, 'funksiyalar topilmadi')
  const claim = src.slice(start, end)
  assert.match(claim, /load_events/)
  assert.match(claim, /resolved_at IS NULL/)
})
