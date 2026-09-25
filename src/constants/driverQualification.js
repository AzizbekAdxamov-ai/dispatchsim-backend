// The driver qualification file (DQ), as facts and a verdict-free
// reading of them.
//
// 49 CFR 391 Subpart E is the carrier's paperwork duty: a qualification
// file for every driver employed to drive, kept current -- CDL, the DOT
// medical certificate (391.43), a Motor Vehicle Record review at least
// yearly (391.25), and the drug & alcohol program (Part 382). A dispatcher
// who assigns a load never reads the file; the question is whether it is
// CLEAN, and "clean" is a summary of four independent document states.
//
// This module is where that summary lives, once: the frontend shows the
// badge these helpers return, and nothing else recomputes it. The states
// are the seed's own vocabulary (039's CHECKs and build.js) -- a status
// here is never invented, only read and timed.
//
// The compressed calendar runs underneath: one simulated day is
// REAL_MS_PER_SIM_DAY real ms (simClock.js), so a certificate expiring
// in 30 simulated days expires in under a real minutes' worth of
// sessions. The 30/90-day windows below are the FMCSA practice of
// warning BEFORE a document lapses -- expressed in simulated days, which
// is the only time this program's company actually has.

import { REAL_MS_PER_SIM_DAY } from './simClock.js'

// A document inside this window is 'expiring' -- the carrier is expected
// to renew before it lapses, so the warning fires early. 90 days is the
// common medical-card renewal reminder window; 30 is the CDL renewal
// reminder most states use. Both are SIMULATED days here, like every
// other day count on the company side.
export const CDL_EXPIRING_DAYS = 30
export const MEDICAL_EXPIRING_DAYS = 90
export const MVR_EXPIRING_DAYS = 30

// How stale an MVR review may be before it stops being 'valid'
// (49 CFR 391.25: at least once every 12 months).
export const MVR_MAX_AGE_DAYS = 365

// Document types in the order the screen lists them. `cfr` is the rule
// each one answers to -- shown on the screen, because a fact with its
// source teaches more than a fact alone (same discipline as
// hosClock.js's VIOLATION_TYPES).
export const DQ_DOCUMENT_TYPES = [
  { key: 'cdl', label: 'CDL', cfr: '49 CFR 383' },
  { key: 'medical', label: 'Medical certificate', cfr: '49 CFR 391.43' },
  { key: 'mvr', label: 'MVR review', cfr: '49 CFR 391.25' },
  { key: 'drugAlcohol', label: 'Drug & alcohol', cfr: '49 CFR 382' },
]

// Reading one document's status against a date. `storedStatus` is what
// the row says (seeded or updated); the date side is re-derived here so
// the SAME row reads differently as the clock moves -- an expiry the
// seed wrote as future does not stay 'valid' for ever just because the
// row was not touched. Rows without a date yet ('missing'/'suspended')
// pass through untouched: there is nothing to time.
export function readDocumentStatus(storedStatus, expiresOn, todayMs) {
  if (expiresOn == null || storedStatus === 'missing' || storedStatus === 'suspended') {
    return storedStatus
  }
  const expiryMs = new Date(expiresOn).getTime()
  if (!Number.isFinite(expiryMs)) return storedStatus
  if (expiryMs <= todayMs) return 'expired'
  return storedStatus
}

// The file's overall state, from its worst document. The order IS the
// rule: one expired or missing document means the file is not clear --
// not on average, not eventually, at all. 'attention' is the state of a
// file whose documents are all technically current but one is inside its
// renewal window: legal today, a violation the day it lapses.
export function fileState(documentStatuses) {
  const states = new Set(documentStatuses)
  if (states.has('expired') || states.has('missing') || states.has('suspended')) return 'action'
  if (states.has('expiring')) return 'attention'
  return 'clear'
}

// A driver cleared to take new work, or not. 'attention' does NOT block:
// a medical card 80 days from expiry is a renewal task, not a legal
// barrier. Expired, missing, suspended -- those are facts that stop the
// dispatch decision, the same way an insolvent company stops a purchase
// (consequence over blocking, stated where it bites).
export function dispatchClear(documentStatuses) {
  return fileState(documentStatuses) !== 'action'
}

// The date columns as simulated-day offsets the frontend can render
// without its own calendar: how long until each expiry, in sim days.
// Null for documents without a date.
export function daysUntil(expiresOn, todayMs) {
  if (expiresOn == null) return null
  const expiryMs = new Date(expiresOn).getTime()
  if (!Number.isFinite(expiryMs)) return null
  return Math.ceil((expiryMs - todayMs) / REAL_MS_PER_SIM_DAY)
}
