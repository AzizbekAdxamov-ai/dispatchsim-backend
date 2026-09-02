// Driver applicant (labor market) seed generator.
//
// Applicants mirror the posting pattern: generated daily, appear/disappear
// on the board via posted_at/expires_at. HR reviews and hires them.
//
// Determinism guarantee: timestamps are offset integers (minutes from now()),
// same as postings.js. IDs come from applicant_id_seq (migration 015), so
// they keep the a<number> shape the applicants_id_format CHECK wants without
// ever repeating across runs.

import { raw } from './render.js'

// ---------------------------------------------------------------------
// Email uniqueness
// ---------------------------------------------------------------------
// driver_applicants.email is UNIQUE, and so is drivers.email (a hire copies
// it over). The model invents the address, and it reaches for the same
// plausible names on every run, so the second run died on
// driver_applicants_email_key. Identity is not the model's job: the local
// part carries the sequence id, exactly as the primary key comes from
// applicant_id_seq rather than the array index. Dedupe inside one batch is
// not enough here -- the collision is with rows already in the table.
export function emailWithId(rawEmail, id) {
  const [local, domain] = String(rawEmail ?? '').toLowerCase().split('@')
  const cleanLocal = (local || 'driver').replace(/[^a-z0-9._+-]/g, '') || 'driver'
  let cleanDomain = (domain || '').replace(/[^a-z0-9.-]/g, '')
  // applicants_email_fmt requires a dot in the domain; a model answer of
  // 'bob@localhost' would pass zod and then fail the CHECK.
  if (!/^[^.]+(\.[^.]+)+$/.test(cleanDomain)) cleanDomain = 'example.com'
  return `${cleanLocal}.${id}@${cleanDomain}`
}

// ---------------------------------------------------------------------
// Configuration — lifetime is CALCULATED, never hardcoded
// ---------------------------------------------------------------------

export const APPLICANT_CONFIG = {
  poolTarget: 20,       // kuniga generatsiya
  visibleTarget: 6,     // bir vaqtda bozorda ko'rinadigani
  coverageHours: 26,    // cron 24s + 2s zaxira
}

// Little qonuni — same formula as postings.js
const avgLifetimeMin = Math.round(
  (APPLICANT_CONFIG.visibleTarget * APPLICANT_CONFIG.coverageHours * 60) /
   APPLICANT_CONFIG.poolTarget
)

// available_from window: how far ahead an applicant can be available
const AVAILABLE_WINDOW_HOURS = 48

// ---------------------------------------------------------------------
// Tier definitions — relative, not absolute
// ---------------------------------------------------------------------

export const APPLICANT_TIERS = [
  ['strong',   0.25],
  ['solid',    0.40],
  ['risky',    0.25],
  ['mismatch', 0.10],
]

// ---------------------------------------------------------------------
// fitRating — composite quality indicator (no banned words in name)
// ---------------------------------------------------------------------

function computeFitRating(item) {
  return (
    item.yearsExperience * 10
    - item.mvrViolations * 15
    - item.preventableAccidents * 30
    - item.employmentGapMonths * 2
  )
}

// ---------------------------------------------------------------------
// Classification — percentile-based, deterministic
// ---------------------------------------------------------------------

function classifyApplicants(items) {
  // Compute fitRating and sort descending (best first), tiebreak by index
  const scored = items.map((item, idx) => ({
    item,
    fitRating: computeFitRating(item),
    _idx: idx,
  }))
  scored.sort((a, b) => b.fitRating - a.fitRating || a._idx - b._idx)

  const n = scored.length
  const strongEnd = Math.max(1, Math.ceil(n * 0.25))
  const solidEnd = Math.max(strongEnd + 1, Math.ceil(n * 0.65))   // 25 + 40 = 65
  const riskyEnd = Math.max(solidEnd + 1, Math.ceil(n * 0.90))    // 65 + 25 = 90

  for (let i = 0; i < n; i++) {
    if (i < strongEnd) {
      scored[i].tier = 'strong'
    } else if (i < solidEnd) {
      scored[i].tier = 'solid'
    } else if (i < riskyEnd) {
      scored[i].tier = 'risky'
    } else {
      scored[i].tier = 'mismatch'
    }
  }

  return scored
}

// ---------------------------------------------------------------------
// Mismatch injection — deliberate credential mismatch
//
// The best candidates (top 50%) are candidates for mismatch. Every k-th
// one (stepping through to reach 10% of total) gets one deliberate flaw:
//   1. desiredEquipment='tanker' but 'tanker' removed from endorsements
//   2. cdlClass='B' but desiredEquipment stays heavy
//   3. license_expires_on set to 15-45 days from now (expiring soon)
//
// Deterministic: rotation by index, no rng() — preserves seed reproducibility.
// ---------------------------------------------------------------------

const MISMATCH_TYPES = ['missing_endorsement', 'cdl_mismatch', 'expiring_license']

function injectMismatch(scored, rng) {
  // Select from top 50%, every k-th to reach ~10% of total
  const topHalf = scored.filter((s) => s.tier !== 'mismatch' && s._idx < Math.floor(scored.length / 2))
  const mismatchCount = Math.max(1, Math.ceil(scored.length * 0.10))
  const step = Math.max(1, Math.floor(topHalf.length / mismatchCount))

  let injected = 0
  for (let i = 0; i < topHalf.length && injected < mismatchCount; i += step) {
    const s = topHalf[i]
    const flawType = MISMATCH_TYPES[injected % MISMATCH_TYPES.length]
    const item = { ...s.item }

    switch (flawType) {
      case 'missing_endorsement':
        // Add 'tanker' to desiredEquipment but remove from endorsements
        item.desiredEquipment = 'tanker'
        item.endorsements = item.endorsements.filter((e) => e !== 'tanker')
        break
      case 'cdl_mismatch':
        // Downgrade CDL but keep heavy equipment desire
        item.cdlClass = 'B'
        break
      case 'expiring_license':
        // License expires in 15-45 days
        item.licenseExpiresOn = new Date(Date.now() + (15 + injected * 5) * 86400000)
        break
    }

    s.item = item
    s.tier = 'mismatch'
    injected++
  }

  return scored
}

// ---------------------------------------------------------------------
// buildApplicantRows — main export
// ---------------------------------------------------------------------

/**
 * Build driver_applicants rows from validated applicant items.
 *
 * Timestamps use raw("now() + interval '<n> minutes'") — same pattern
 * as postings.js. raw() returns { __raw: true, value: ... }, so we
 * access .value when building SQL.
 */
export function buildApplicantRows({ rng, applicantItems , applicantIds }) {
  if (applicantItems.length === 0) return []

  // Classify by fitRating percentile
  let scored = classifyApplicants(applicantItems)

  // Inject mismatch flaws into top candidates
  scored = injectMismatch(scored, rng)

  // Backfill count — first visibleTarget are backfilled into the past
  const backfillCount = Math.max(1, Math.min(APPLICANT_CONFIG.visibleTarget, scored.length))

  const rows = scored.map(({ item, tier }, idx) => {
    // Per-applicant lifetime: avgLifetimeMin ± 70% jitter, min 20 min
    const lifetimeMin = Math.max(20, Math.round(avgLifetimeMin * (0.3 + rng() * 1.4)))

    // Timestamp offsets (integer minutes — deterministic)
    const postedOffset = idx < backfillCount
      ? -(1 + Math.floor(rng() * lifetimeMin))     // in the past (backfill)
      : Math.floor(rng() * (APPLICANT_CONFIG.coverageHours * 60 + 1))  // in the future
    const expiresOffset = postedOffset + lifetimeMin

    // available_from: 0-48h after now (for future postings) or already available
    const availableWindowMin = AVAILABLE_WINDOW_HOURS * 60
    const availableOffset = idx < backfillCount
      ? -Math.floor(rng() * availableWindowMin)     // already available
      : Math.floor(rng() * availableWindowMin)      // up to 48h from now

    // license_expires_on: 1-5 years from now (except mismatch-injected ones)
    const licenseDays = tier === 'mismatch' && item.licenseExpiresOn
      ? undefined  // already set by injectMismatch
      : 365 + Math.floor(rng() * (4 * 365))  // 1-5 years

    // Pay model → split into the two DB columns
    const payPercentBp = item.desiredPayModel === 'percent' ? item.desiredPayValue : null
    const payPerMileCents = item.desiredPayModel === 'permile' ? item.desiredPayValue : null

    return {
      // Ids come from applicant_id_seq (migration 015), NOT from the array
      // index. Index-based ids meant every run produced a1..a20 and the
      // second run died on driver_applicants_pkey.
      id: applicantIds[idx],
      full_name: item.fullName,
      email: emailWithId(item.email, applicantIds[idx]),
      phone: item.phone,
      cdl_class: item.cdlClass,
      cdl_state: item.cdlState,
      license_expires_on: item.licenseExpiresOn instanceof Date
        ? item.licenseExpiresOn.toISOString().slice(0, 10)
        : `${new Date(Date.now() + licenseDays * 86400000).toISOString().slice(0, 10)}`,
      years_experience: item.yearsExperience,
      home_base_city: item.homeBaseCity,
      home_base_state: item.homeBaseState,
      endorsements: item.endorsements,
      desired_equipment: item.desiredEquipment,
      mvr_violations: item.mvrViolations,
      preventable_accidents: item.preventableAccidents,
      employment_gap_months: item.employmentGapMonths,
      desired_pay_model: item.desiredPayModel,
      desired_pay_percent_bp: payPercentBp,
      desired_pay_per_mile_cents: payPerMileCents,
      available_from: raw(`now() + interval '${availableOffset} minutes'`),
      posted_at: raw(`now() + interval '${postedOffset} minutes'`),
      expires_at: raw(`now() + interval '${expiresOffset} minutes'`),
      status: 'open',
      tier,  // for assertIntegrity / reporting, not stored in DB
    }
  })

  return rows
}
