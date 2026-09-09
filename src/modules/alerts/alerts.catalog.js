// What the board is allowed to say.
//
// Two rules govern every entry here, and both come from mistakes this
// project has already made.
//
// 1. A FACT, NEVER A VERDICT. "Load 4471 was promised 6 minutes ago and
//    has not delivered" is a fact. "Load 4471 is at risk" is the program
//    telling the student what to think. The dashboard already lost a
//    fabricated risk score and a green/amber/red deadhead scale for this
//    reason. An alert that cannot be phrased as something that HAPPENED
//    does not belong in this file.
//
// 2. THE DATA MUST BE ALIVE. Before adding an alert, check that something
//    WRITES the column it reads. trucks.fuel_pct is set once at purchase
//    and never again; drivers.hos_remaining_min is only ever set to 660;
//    maintenance_records and truck_daily_metrics have no runtime writer at
//    all. A low-fuel warning or an HOS countdown built on those would be
//    a permanent lie -- either always silent or always shouting -- and
//    would look exactly as correct as the lateness check that could never
//    fire. Those alerts are deliberately absent. When a writer exists,
//    they can be added here in one place.
//
// The fingerprint decides when an acknowledgement stops applying. Each
// family answers one question: what would have to change for this to be a
// different situation, rather than the same one a minute later?

import { CREDIT_LIMIT_USD, CREDIT_APR } from '../../constants/simClock.js'

// Money in the account moves constantly -- the tick charges interest every
// 30 seconds -- so a fingerprint of the exact balance would un-silence the
// alert almost immediately. A whole thousand dollars is the resolution of
// the acknowledgement, and the UI says so: "silenced until the balance
// moves $1,000".
export const CASH_ACK_RESOLUTION_USD = 1000

export function cashFingerprint(balanceUsd) {
  return `k${Math.floor(balanceUsd / CASH_ACK_RESOLUTION_USD)}`
}

// A posting, applicant or listing is "leaving soon" relative to ITS OWN
// life, not to a number somebody picked. Lifetimes are derived from
// Little's Law and change whenever the drip is retuned; a hardcoded "15
// minutes left" would silently become wrong the day poolTarget moved.
export const LEAVING_SOON_FRACTION = 0.2

export function fractionRemaining({ postedAt, expiresAt, now = new Date() }) {
  const total = new Date(expiresAt) - new Date(postedAt)
  if (!(total > 0)) return 1
  return Math.max(0, Math.min(1, (new Date(expiresAt) - now) / total))
}

export function isLeavingSoon(args) {
  return fractionRemaining(args) <= LEAVING_SOON_FRACTION
}

// The catalog itself. `key` is the family; the entity id is appended by the
// service to make the ack key.
export const FAMILIES = Object.freeze({
  'load.late': {
    // A promise that has already passed. Nothing predicted, nothing scored.
    title: (a) => `Load ${a.loadId} was promised ${a.agoLabel} ago`,
    detail: (a) => `${a.broker} · ${a.originLabel} → ${a.destinationLabel} · not delivered`,
    // 'crit' is the only status this fires on, so the fingerprint is the
    // status itself: a load that goes from behind to late says so again.
    fingerprint: (a) => a.status,
    href: (a) => `/loads/${a.loadId}`,
    // What is actually at stake, used for ordering. Not a severity.
    stakeUsd: (a) => a.rateUsd,
  },

  'load.running-behind': {
    title: (a) => `Load ${a.loadId} will arrive after the promised time`,
    detail: (a) => `${a.broker} · about ${a.overLabel} past the window`,
    fingerprint: (a) => a.status,
    href: (a) => `/loads/${a.loadId}`,
    stakeUsd: (a) => a.rateUsd,
  },

  'load.unassigned': {
    // Booked and paid for, sitting still. The pickup window is NOT quoted
    // here: pickup_at and delivery_at come from the posting on the real
    // calendar, while everything the company does runs on the compressed
    // one. Quoting a real-calendar deadline next to compressed-calendar
    // events is the same mistake that made lateness impossible.
    title: (a) => `Load ${a.loadId} has no driver`,
    detail: (a) => `Booked ${a.agoLabel} ago · $${a.rateUsd.toLocaleString('en-US')} · ${a.originLabel} → ${a.destinationLabel}`,
    fingerprint: () => 'unassigned',
    href: (a) => `/loads/${a.loadId}`,
    stakeUsd: (a) => a.rateUsd,
  },

  'invoice.overdue': {
    title: (a) => `$${a.amountUsd.toLocaleString('en-US')} from ${a.broker} is ${a.daysPastDue} days past due`,
    detail: (a) => `Load ${a.loadId} · ${a.paymentTerms}`,
    // Every simulated day past due is a different situation to be in.
    fingerprint: (a) => `d${a.daysPastDue}`,
    href: (a) => `/finance/invoices/${a.loadId}`,
    stakeUsd: (a) => a.amountUsd,
  },

  'cash.negative': {
    title: (a) => `Balance is -$${Math.abs(a.balanceUsd).toLocaleString('en-US')}`,
    detail: () => `Interest accrues at ${(CREDIT_APR * 100).toFixed(0)}% APR on the credit line`,
    fingerprint: (a) => cashFingerprint(a.balanceUsd),
    href: () => '/cash',
    stakeUsd: (a) => Math.abs(a.balanceUsd),
  },

  'cash.limit-reached': {
    // $50,000 is a contractual limit, not a threshold somebody chose, so
    // it is stated as the number it is.
    title: (a) => `The $${CREDIT_LIMIT_USD.toLocaleString('en-US')} credit line is used up`,
    detail: (a) => `Balance is -$${Math.abs(a.balanceUsd).toLocaleString('en-US')}`,
    fingerprint: (a) => cashFingerprint(a.balanceUsd),
    href: () => '/cash',
    stakeUsd: (a) => Math.abs(a.balanceUsd),
  },

  'driver.idle': {
    // The truck is paid for either way. This is the cost of an empty seat,
    // stated without calling it a mistake -- resting between loads is what
    // the driver is supposed to do.
    title: (a) => `${a.driverName} has no load`,
    detail: (a) => `Truck ${a.truckId} · ${a.locationLabel}`,
    fingerprint: () => 'idle',
    href: (a) => `/drivers/${a.driverId}`,
    stakeUsd: () => 0,
  },

  'driver.no-truck': {
    title: (a) => `${a.driverName} has no truck`,
    detail: () => 'Hired and paid for, cannot be dispatched',
    fingerprint: () => 'no-truck',
    href: (a) => `/drivers/${a.driverId}`,
    stakeUsd: () => 0,
  },

  'broker.replied': {
    title: (a) => `${a.broker} replied`,
    detail: (a) => `${a.agoLabel} ago · ${a.originLabel} → ${a.destinationLabel}`,
    // A second reply is a new thing to read.
    fingerprint: (a) => `m${a.lastMessageId}`,
    href: (a) => `/broker-chat/${a.conversationId}`,
    stakeUsd: () => 0,
  },

  'broker.rate-con-waiting': {
    title: (a) => `Rate confirmation from ${a.broker} is not accepted`,
    detail: (a) => `$${a.rateUsd.toLocaleString('en-US')} agreed · the load is not booked until it is accepted`,
    fingerprint: (a) => `r${a.rateUsd}`,
    href: (a) => `/broker-chat/${a.conversationId}`,
    stakeUsd: (a) => a.rateUsd,
  },

  'applicant.leaving': {
    title: (a) => `${a.name} is leaving the applicant pool`,
    detail: (a) => `${a.experienceLabel} · ${a.homeBaseLabel}`,
    fingerprint: () => 'leaving',
    href: (a) => `/hr/applicants/${a.applicantId}`,
    stakeUsd: () => 0,
  },

  'listing.leaving': {
    title: (a) => `${a.title} is leaving the market`,
    detail: (a) => `$${a.priceUsd.toLocaleString('en-US')} · ${a.locationLabel}`,
    fingerprint: () => 'leaving',
    href: (a) => `/fleet/market/${a.listingId}`,
    stakeUsd: () => 0,
  },
})

export const FAMILY_KEYS = Object.freeze(Object.keys(FAMILIES))
