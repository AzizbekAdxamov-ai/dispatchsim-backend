// Business logic for HR applicant endpoints.
//
// The hire flow follows loadBoard.service.js's booking pattern:
// pre-flight checks outside transaction → atomic conditional UPDATE
// inside transaction → driver INSERT → coordinate lookup → error mapping.

import { withTransaction } from '../../db/pool.js'
import * as hrRepo from './hr.repository.js'
import { AppError } from '../../lib/errors.js'
import { findCity } from '../../../scripts/seed/cities.js'
import * as cash from '../cash/cash.service.js'
import { DRIVER_ONBOARDING_USD } from '../../constants/simClock.js'

// ---------------------------------------------------------------------
// Read endpoints
// ---------------------------------------------------------------------

export async function listApplicants({ cdlClass, homeBaseState, minYearsExperience, desiredEquipment, sort, page, limit }) {
  const offset = (page - 1) * limit
  const [applicants, total] = await Promise.all([
    hrRepo.listApplicants({ cdlClass, homeBaseState, minYearsExperience, desiredEquipment, sort, limit, offset }),
    hrRepo.countOpenApplicants({ cdlClass, homeBaseState, minYearsExperience, desiredEquipment }),
  ])
  return { applicants, meta: { page, limit, total } }
}

export async function getApplicantById(id) {
  const applicant = await hrRepo.getApplicantById(id)
  if (!applicant) {
    throw new AppError('APPLICANT_NOT_FOUND')
  }
  return applicant
}

// ---------------------------------------------------------------------
// Hire (POST /hr/applicants/:id/hire)
// ---------------------------------------------------------------------

/**
 * Hire an applicant. Creates a driver row and atomically marks the
 * applicant as hired. Throws AppError on failure.
 *
 * Returns { driver, applicant } on success.
 */
export async function hireApplicant({ applicantId, userId }) {
  // Pre-flight: fetch applicant and check status BEFORE transaction.
  // This avoids holding a transaction open for the read, and matches
  // loadBoard.service.js's pattern (read posting, then enter transaction).
  const applicant = await hrRepo.getApplicantById(applicantId)

  if (!applicant) {
    throw new AppError('APPLICANT_NOT_FOUND')
  }

  // posted_at in the future — treat as not found (not expired)
  // Rationale: don't reveal the applicant's existence before the market opens.
  if (new Date(applicant.postedAt) > new Date()) {
    throw new AppError('APPLICANT_NOT_FOUND')
  }

  // Already expired
  if (new Date(applicant.expiresAt) <= new Date()) {
    throw new AppError('APPLICANT_EXPIRED')
  }

  // Already hired
  if (applicant.status === 'hired') {
    throw new AppError('APPLICANT_ALREADY_HIRED')
  }

  // Resolve coordinates from home base city (required for deadhead).
  // computeDeadhead in postings.js: `if (d.current_lat == null || d.current_lon == null) continue`
  // A driver with NULL coords is invisible to the load board.
  const homeCity = findCity(applicant.homeBaseCity, applicant.homeBaseState)

  let driverId

  try {
    await withTransaction(async (client) => {
      // Step 1: Generate driver ID from sequence
      driverId = await hrRepo.nextDriverId(client)

      // Step 2: Build CDL number (H-prefixed to differ from seed drivers)
      const cdlNumber = `${applicant.cdlState}-H${driverId.slice(1)}`

      // Step 3: Insert driver with coordinates from home base
      await hrRepo.insertDriver(client, {
        id: driverId,
        name: applicant.fullName,
        email: applicant.email,
        phone: applicant.phone,
        cdlClass: applicant.cdlClass,
        cdlNumber,
        licenseExpiresOn: applicant.licenseExpiresOn,
        homeBaseCity: applicant.homeBaseCity,
        homeBaseState: applicant.homeBaseState,
        currentCity: homeCity?.city ?? applicant.homeBaseCity,
        currentState: homeCity?.state ?? applicant.homeBaseState,
        currentLat: homeCity?.lat ?? null,
        currentLon: homeCity?.lon ?? null,
        // NOT 'off'. 'off' means not working for the company (the load
        // board once filtered on `duty_status <> 'off'` too), so a roster hired
        // through HR was invisible to dispatch -- the board reported no
        // available driver for a company that had just hired three.
        dutyStatus: 'resting',
        payModel: applicant.desiredPayModel,
        payPercentBp: applicant.desiredPayPercentBp,
        payPerMileCents: applicant.desiredPayPerMileCents,
      })

      // Step 3b: hiring is not free -- DOT physical, drug screen, MVR
      // pull, orientation. Small on its own; the point is that hiring
      // five drivers for a fleet with two trucks shows up in the ledger
      // instead of costing nothing.
      // A driver is a recurring wage, not a one-off fee. Hiring one into
      // a company that cannot pay the drivers it has is the decision this
      // refuses -- and the driver who is already owed three weeks will
      // tell you so in chat.
      await cash.assertCanCommit(client, 'hiring a driver')

      await cash.spend(client, {
        kind: 'driver_onboarding',
        amountUsd: DRIVER_ONBOARDING_USD,
        description: `Onboarding — ${applicant.fullName}`,
        refType: 'driver',
        refId: driverId,
        userId,
      })

      // Step 4: Atomically mark applicant as hired
      const updated = await hrRepo.hireApplicantAtomically(client, applicantId, userId, driverId)

      if (!updated) {
        // Race condition: applicant was hired/expired between our
        // pre-flight read and this UPDATE. ROLLBACK — the driver
        // row above is also undone. Determine cause with fresh SELECT.
        const existing = await hrRepo.getApplicantForHire(client, applicantId)
        if (!existing || new Date(existing.postedAt) > new Date()) {
          throw new AppError('APPLICANT_NOT_FOUND')
        }
        if (existing.status === 'hired') {
          throw new AppError('APPLICANT_ALREADY_HIRED')
        }
        if (new Date(existing.expiresAt) <= new Date()) {
          throw new AppError('APPLICANT_EXPIRED')
        }
        throw new AppError('INTERNAL_ERROR')
      }
    })
  } catch (err) {
    // Narrow constraint mapping — only specific known constraints.
    // All other violations fall through as 500 — the real cause
    // must be visible in logs, not hidden behind a generic message.
    if (err.code === '23505' && err.constraint === 'drivers_email_key') {
      throw new AppError('DRIVER_EMAIL_TAKEN')
    }
    if (err.code === '23505' && err.constraint === 'drivers_cdl_number_key') {
      console.error(`CDL number collision: ${err.detail}`)
      throw err
    }
    throw err
  }

  return {
    driver: { id: driverId },
    applicant: { ...applicant, status: 'hired', hiredDriverId: driverId, hiredByUserId: userId },
  }
}
