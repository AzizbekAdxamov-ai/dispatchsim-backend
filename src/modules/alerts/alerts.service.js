// Assemble the board.
//
// Every family is asked at once. One failing query must not take the whole
// list down -- an alert list that goes blank on a bad query is worse than
// one missing a row, because blank reads as "nothing is wrong".

import * as repo from './alerts.repository.js'
import * as cashRepo from '../cash/cash.repository.js'
import { FAMILIES, isLeavingSoon, HOS_LOW_THRESHOLD_MIN } from './alerts.catalog.js'
import { simAgo, realAgo, place } from './alerts.format.js'
import { EVENT_TYPES } from '../../constants/loadEvents.js'
import * as solvencyService from '../cash/solvency.service.js'
import * as payrollService from '../payroll/payroll.service.js'
import config from '../../config.js'

// Build one alert from a catalog family and the row behind it. Anything the
// family's own functions need has already been shaped by the caller.
function build(family, entityId, args) {
  const def = FAMILIES[family]
  const key = entityId ? `${family}:${entityId}` : family
  return {
    key,
    family,
    title: def.title(args),
    detail: def.detail(args),
    fingerprint: String(def.fingerprint(args)),
    href: def.href(args),
    stakeUsd: def.stakeUsd(args),
    // Whether the load literally cannot proceed until this is answered.
    // A fact about the work, not a severity: an open road event stops
    // claimArrivedLoads from ever selecting that load.
    blocking: Boolean(def.blocking),
  }
}

// Every source, isolated. A thrown query returns [] and says so in the
// server log rather than emptying the board -- but the failure is not
// swallowed silently either: `degraded` reaches the client, so the UI can
// say the list is incomplete instead of implying all-clear.
async function collect(label, fn, degraded) {
  try {
    return await fn()
  } catch (err) {
    console.error(`[alerts] ${label} failed:`, err.message)
    degraded.push(label)
    return []
  }
}

// One account, one alert. The three states are different facts, not louder
// versions of each other: under water, past the line, and insolvent are
// answered by different numbers and call for different things.
//
// Pure, and exported, so the choice between them can be tested without a
// database behind it. `enabled` is the FINANCE switch (config.js): with the
// money model off nothing accrues against the balance and nothing is
// refused because of it, so an alert about it would be the board reporting
// a consequence that is not coming.
export function cashAlert({ standing, balanceUsd, enabled = config.financeEnabled }) {
  if (!enabled) return null
  if (standing && standing.state === 'insolvent') return build('cash.insolvent', null, standing)
  if (standing && standing.state === 'over_limit') return build('cash.limit-reached', null, standing)
  if (balanceUsd < 0) return build('cash.negative', null, { balanceUsd })
  return null
}

// One alert per driver whose settlement is past due and who is still on the
// job. The SQL clamps days overdue to 0, so a settlement not yet due reads
// as stage 'asks' too; oldestDueAt is what says it is actually late. A
// driver at 'quits' has already left, so there is nothing left to warn about.
const PAY_ALERT_STAGES = new Set(['asks', 'refuses'])
export function payOverdueAlerts(owed, now = new Date()) {
  return owed
    .filter((r) => r.oldestDueAt && new Date(r.oldestDueAt) <= now && PAY_ALERT_STAGES.has(r.stage))
    .map((r) => build('driver.pay-overdue', r.driverId, r))
}

export async function listAlerts({ userId, now = new Date() }) {
  const degraded = []

  const [loads, roadEvents, unassigned, invoices, drivers, hosLow, replies, rateCons, applicants, listings, balanceUsd, standing, acks, owedPay] =
    await Promise.all([
      collect('lateLoads', () => repo.lateLoads(), degraded),
      collect('openRoadEvents', () => repo.openRoadEvents(), degraded),
      collect('unassignedLoads', () => repo.unassignedLoads(), degraded),
      collect('overdueInvoices', () => repo.overdueInvoices(), degraded),
      collect('idleDrivers', () => repo.idleDrivers(), degraded),
      collect('hosLowDrivers', () => repo.hosLowDrivers(HOS_LOW_THRESHOLD_MIN), degraded),
      collect('brokerReplies', () => repo.brokerReplies({ userId }), degraded),
      collect('unacceptedRateCons', () => repo.unacceptedRateCons({ userId }), degraded),
      collect('expiringApplicants', () => repo.expiringApplicants(), degraded),
      collect('expiringListings', () => repo.expiringListings(), degraded),
      collect('balance', () => cashRepo.getBalance(), degraded).then((v) => (Array.isArray(v) ? 0 : v)),
      collect('solvency', () => solvencyService.solvency(), degraded).then((v) => (Array.isArray(v) ? null : v)),
      collect('acks', () => repo.listAcks({ userId }), degraded),
      collect('overduePay', () => payrollService.listOwed(), degraded),
    ])

  const alerts = []

  for (const l of loads) {
    const args = {
      loadId: l.loadId, broker: l.broker, rateUsd: l.rateUsd, status: l.status,
      originLabel: place(l.originCity, l.originState),
      destinationLabel: place(l.destinationCity, l.destinationState),
      agoLabel: simAgo(l.promisedEtaAt, now),
      overLabel: simAgo(l.promisedEtaAt, new Date(l.etaAt)),
    }
    alerts.push(build(l.status === 'crit' ? 'load.late' : 'load.running-behind', l.loadId, args))
  }

  for (const e of roadEvents) {
    alerts.push(build('load.event-open', e.loadId, {
      eventId: e.id, loadId: e.loadId, place: e.place,
      driverName: e.driverName, rateUsd: e.rateUsd,
      summary: EVENT_TYPES[e.eventType]?.summary ?? e.eventType,
    }))
  }

  for (const l of unassigned) {
    alerts.push(build('load.unassigned', l.loadId, {
      loadId: l.loadId, rateUsd: l.rateUsd,
      originLabel: place(l.originCity, l.originState),
      destinationLabel: place(l.destinationCity, l.destinationState),
      agoLabel: simAgo(l.bookedAt, now),
    }))
  }

  for (const i of invoices) {
    alerts.push(build('invoice.overdue', i.loadId, i))
  }

  const cash = cashAlert({ standing, balanceUsd })
  if (cash) alerts.push(cash)

  for (const d of drivers) {
    if (!d.truckId) {
      alerts.push(build('driver.no-truck', d.driverId, d))
    } else {
      alerts.push(build('driver.idle', d.driverId, d))
    }
  }

  alerts.push(...payOverdueAlerts(owedPay, now))

  for (const d of hosLow) {
    alerts.push(build('driver.hos-low', d.driverId, {
      driverId: d.driverId,
      driverName: d.driverName,
      hosRemainingMin: d.hosRemainingMin,
      loadId: d.loadId,
      rateUsd: d.rateUsd,
      hosLabel: `${Math.floor(d.hosRemainingMin / 60)}h ${d.hosRemainingMin % 60}m`,
    }))
  }

  for (const r of replies) {
    alerts.push(build('broker.replied', r.conversationId, {
      ...r,
      originLabel: place(r.originCity, r.originState),
      destinationLabel: place(r.destinationCity, r.destinationState),
      agoLabel: realAgo(r.lastMessageAt, now),
    }))
  }

  for (const r of rateCons) {
    alerts.push(build('broker.rate-con-waiting', r.conversationId, r))
  }

  for (const a of applicants) {
    alerts.push(build('applicant.leaving', a.applicantId, {
      applicantId: a.applicantId, name: a.name,
      experienceLabel: `${a.yearsExperience} yr`,
      homeBaseLabel: place(a.homeBaseCity, a.homeBaseState),
    }))
  }

  for (const t of listings) {
    alerts.push(build('listing.leaving', t.listingId, {
      listingId: t.listingId,
      title: `${t.year} ${t.make} ${t.model}`,
      priceUsd: t.priceUsd,
      locationLabel: t.seller,
    }))
  }

  // An acknowledgement holds only while the situation it acknowledged is
  // still the same one.
  const ackByKey = new Map(acks.map((a) => [a.alertKey, a.fingerprint]))
  const visible = alerts.filter((a) => ackByKey.get(a.key) !== a.fingerprint)

  // Blocking first, then by what is at stake in dollars, then by key so
  // the order is stable.
  //
  // Both keys are facts, not severities. "Blocking" means the run cannot
  // continue until it is answered -- a stopped truck does not arrive, at
  // any rate -- and the dollar figure is printed on the row, so the
  // student can see why each one sits where it does and two people reading
  // the same board get the same order.
  visible.sort((a, b) =>
    Number(b.blocking) - Number(a.blocking)
    || b.stakeUsd - a.stakeUsd
    || a.key.localeCompare(b.key))

  return {
    alerts: visible,
    meta: {
      total: visible.length,
      acknowledged: alerts.length - visible.length,
      // Named so the UI can say "some checks did not run" instead of
      // showing a short list that looks like good news.
      degraded,
    },
  }
}

export async function acknowledge({ userId, alertKey, fingerprint }) {
  return repo.ack({ userId, alertKey, fingerprint })
}

export async function unacknowledge({ userId, alertKey }) {
  return repo.unack({ userId, alertKey })
}
