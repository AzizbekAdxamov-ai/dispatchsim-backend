// Things that happen on the road, and what the dispatcher can do about them.
//
// WHY THIS REPLACES delayFactor
//
// Until now a load's delay was rolled at dispatch: eta_at was set to
// promised * delayFactor(), the number was decided before the truck moved,
// and nothing ever said why. A student watching a load slide from 'ontime'
// to 'crit' had no cause to look at, nothing to do about it, and no way to
// tell a bad decision from bad luck. The distribution was right and the
// lesson was absent.
//
// An event is the same delay with a reason attached and a decision in the
// middle. Snow closes I-80; the driver calls it in; you can sit it out for
// free or route around it for fuel and miles. That is dispatch. The delay
// is no longer something the simulator knows in advance -- it does not
// exist until something causes it.
//
// EVERY OPTION COSTS SOMETHING
//
// No option is the right one. Waiting is free and slow, spending is fast
// and expensive, and which is correct depends on the promise, the broker,
// and what is in the account -- facts the student has and the program does
// not judge. An option with no downside would be the program telling them
// what to do.

import { DUTY_STATUS } from './hosClock.js'
import { FUEL_PRICE_PER_GAL, AVG_MPG } from '../modules/finance/finance.constants.js'

// About one load in five meets something. Stated per LOAD, because that is
// the number a person can reason about -- "most runs are clean, some are
// not" -- rather than a per-tick probability nobody can picture. The
// per-tick figure is derived below.
export const EVENT_CHANCE_PER_LOAD = 0.2

// Turn "one in five loads" into "this much chance for this stretch of road".
//
// Measured in ELAPSED TIME, not in ticks. The first version divided the
// run into ticks and used a hardcoded 30-second cadence -- which is right
// locally and wrong in production, where Vercel's cron floor is 60 seconds.
// The deployed app therefore rolled half as often and about one load in TEN
// met something instead of one in five. The code was internally consistent,
// the test asserted the code against its own constant, and nothing said the
// shipped rate was half the documented one.
//
// Given a fraction f of the run since the last check, the chance of meeting
// something in that stretch is 1 - (1 - P)^f. Over a whole run the
// fractions sum to 1 and the total comes back to P exactly, at any cadence
// -- 30 seconds, 60, or an hour missed during a deploy.
export function chanceForFraction(fractionOfRun) {
  if (!(fractionOfRun > 0)) return 0
  const f = Math.min(1, fractionOfRun)
  return 1 - (1 - EVENT_CHANCE_PER_LOAD) ** f
}

// Extra fuel for extra miles, at the same price the rest of the sim uses.
function fuelFor(extraMiles) {
  return Math.round((extraMiles / AVG_MPG) * FUEL_PRICE_PER_GAL)
}

// The catalog.
//
// `weight` is relative frequency among events, not a probability. `hours`
// are SIMULATED hours added to the ETA. `costUsd` leaves the account when
// the option is chosen. `billable` marks an option that ADDS to the
// invoice instead of spending -- detention is real money a carrier is
// owed, and a student who never learns to bill it is being taught to work
// for free.
export const EVENT_TYPES = Object.freeze({
  weather: {
    weight: 3,
    // What the driver reports. The dispatcher hears it from the person,
    // not from a system banner.
    report: (e) => `Weather has ${e.place} shut down. Nothing is moving.`,
    summary: 'Weather closure',
    options: [
      {
        key: 'wait',
        label: 'Sit it out',
        detail: 'Park until it clears. Costs nothing but time.',
        hours: 8, costUsd: 0,
      },
      {
        key: 'reroute',
        label: 'Route around it',
        detail: 'Longer road, more fuel, back on the move now.',
        hours: 3, extraMiles: 140,
      },
    ],
  },

  breakdown: {
    weight: 2,
    report: (e) => `Truck is down outside ${e.place}. I am on the shoulder.`,
    summary: 'Breakdown',
    options: [
      {
        key: 'roadside',
        label: 'Roadside repair',
        detail: 'Mobile mechanic comes to the truck. Cheaper, slower.',
        hours: 9, costUsd: 480,
      },
      {
        key: 'tow',
        label: 'Tow to a shop',
        detail: 'Back on the road sooner, and it costs what towing costs.',
        hours: 4, costUsd: 1450,
      },
    ],
  },

  detention: {
    weight: 3,
    report: (e) => `Sitting at the dock in ${e.place}. They have not started on me.`,
    summary: 'Detention at the dock',
    options: [
      {
        key: 'wait',
        label: 'Wait it out',
        detail: 'Say nothing and lose the hours.',
        hours: 5, costUsd: 0,
      },
      {
        key: 'bill',
        label: 'Bill detention',
        detail: 'Same wait, invoiced at the standard hourly rate.',
        hours: 5, costUsd: 0,
        // Detention is billed by the hour after the free window. $65/hr
        // is the common contract figure; the free two hours are already
        // spent by the time the driver calls.
        billable: { label: 'Detention', hours: 3, perHourUsd: 65 },
      },
    ],
  },

  roadClosure: {
    weight: 2,
    report: (e) => `${e.place} is closed. Wreck ahead of me, they are turning everyone around.`,
    summary: 'Road closed',
    options: [
      {
        key: 'wait',
        label: 'Wait for it to open',
        detail: 'They usually clear it. Usually.',
        hours: 6, costUsd: 0,
      },
      {
        key: 'detour',
        label: 'Take the detour',
        detail: 'Adds miles and fuel, keeps the wheels turning.',
        hours: 2, extraMiles: 95,
      },
    ],
  },
})

export const EVENT_KEYS = Object.freeze(Object.keys(EVENT_TYPES))

// Weighted pick. rng is injectable so tests can pin it.
export function pickEventType(rng = Math.random) {
  const total = EVENT_KEYS.reduce((sum, k) => sum + EVENT_TYPES[k].weight, 0)
  let roll = rng() * total
  for (const key of EVENT_KEYS) {
    roll -= EVENT_TYPES[key].weight
    if (roll < 0) return key
  }
  return EVENT_KEYS[EVENT_KEYS.length - 1]
}

// What an option actually does, with fuel worked out from the miles so
// the two can never disagree.
export function resolveOption(eventType, optionKey) {
  const type = EVENT_TYPES[eventType]
  if (!type) return null
  const option = type.options.find((o) => o.key === optionKey)
  if (!option) return null

  const extraMiles = option.extraMiles ?? 0
  const costUsd = (option.costUsd ?? 0) + (extraMiles > 0 ? fuelFor(extraMiles) : 0)
  const accessorialUsd = option.billable
    ? option.billable.hours * option.billable.perHourUsd
    : 0

  return {
    key: option.key,
    label: option.label,
    hours: option.hours,
    extraMiles,
    costUsd,
    accessorialUsd,
    accessorialLabel: option.billable
      ? `${option.billable.label} ${option.billable.hours}h`
      : null,
  }
}

// The options as the dispatcher sees them, with every number filled in.
// Built from the same resolveOption the server uses to apply the choice,
// so the price on the button is the price that is charged.
export function optionsFor(eventType) {
  const type = EVENT_TYPES[eventType]
  if (!type) return []
  return type.options.map((o) => ({
    ...resolveOption(eventType, o.key),
    detail: o.detail,
  }))
}

// What the driver's log says while an event's delay runs (duty_events,
// 037). The duty status is a fact the law defines, not a choice:
//
//   49 CFR 395.2, "On-duty time", includes all time "waiting to be
//   loaded or unloaded" (detention at the dock) and all time "repairing,
//   obtaining assistance, or remaining in attendance upon a disabled
//   commercial motor vehicle" (a breakdown, repaired on the shoulder or
//   towed) -- On Duty Not Driving.
//   Routing around weather or a closure is more road: Driving.
//   Sitting out weather or a closure with the truck parked is Off Duty --
//   the driver is relieved of work while nothing can move. That one is a
//   stated modelling decision (a real driver could also log Sleeper
//   Berth); the adverse-conditions extension (395.1(b)(1)) is not
//   modelled, as hosClock.js's header says.
const DUTY_DURING = Object.freeze({
  weather: { wait: DUTY_STATUS.OFF_DUTY, reroute: DUTY_STATUS.DRIVING },
  breakdown: { roadside: DUTY_STATUS.ON_DUTY_NOT_DRIVING, tow: DUTY_STATUS.ON_DUTY_NOT_DRIVING },
  detention: { wait: DUTY_STATUS.ON_DUTY_NOT_DRIVING, bill: DUTY_STATUS.ON_DUTY_NOT_DRIVING },
  roadClosure: { wait: DUTY_STATUS.OFF_DUTY, detour: DUTY_STATUS.DRIVING },
})

export function dutyStatusDuring(eventType, optionKey) {
  return DUTY_DURING[eventType]?.[optionKey] ?? null
}

// What the driver is doing while the event is OPEN -- before any option
// is chosen. The wait's status is a fact about the EVENT under 49 CFR
// 395.2, not about the choice: attending a disabled truck is On Duty
// whether it ends up repaired on the shoulder or towed, sitting out
// weather/closure is Off Duty the whole time it is parked. Every event
// type here resolves into one of those two while open, so the mapping is
// by type, not by option. loadEvents.service.js's dutyStatusDuring keeps
// its own role: the RESOLVED delay's status, which is the option's.
const DUTY_WHILE_OPEN = Object.freeze({
  weather: DUTY_STATUS.OFF_DUTY,
  breakdown: DUTY_STATUS.ON_DUTY_NOT_DRIVING,
  detention: DUTY_STATUS.ON_DUTY_NOT_DRIVING,
  roadClosure: DUTY_STATUS.OFF_DUTY,
})

export function dutyStatusWhileOpen(eventType) {
  return DUTY_WHILE_OPEN[eventType] ?? null
}
