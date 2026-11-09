// Data-access layer for the `driver_applicants` table and `drivers` INSERT.
// This is the ONLY file that writes SQL against these tables.
//
// Read queries follow loadBoard.repository.js patterns: parameterized,
// camelCase aliases, no SELECT *.

import { query } from '../../db/pool.js'
import { DRIVING_LIMIT_HOURS } from '../../constants/hosClock.js'

const MINUTES_PER_HOUR = 60
const FULL_DRIVE_CLOCK_MIN = DRIVING_LIMIT_HOURS * MINUTES_PER_HOUR

const APPLICANT_COLUMNS = `
  a.id, a.full_name AS "fullName", a.email, a.phone,
  a.cdl_class AS "cdlClass", a.cdl_state AS "cdlState",
  a.license_expires_on AS "licenseExpiresOn",
  a.years_experience AS "yearsExperience",
  a.home_base_city AS "homeBaseCity", a.home_base_state AS "homeBaseState",
  a.endorsements, a.desired_equipment AS "desiredEquipment",
  a.mvr_violations AS "mvrViolations",
  a.preventable_accidents AS "preventableAccidents",
  a.employment_gap_months AS "employmentGapMonths",
  a.desired_pay_model AS "desiredPayModel",
  a.desired_pay_percent_bp AS "desiredPayPercentBp",
  a.desired_pay_per_mile_cents AS "desiredPayPerMileCents",
  a.available_from AS "availableFrom",
  a.posted_at AS "postedAt", a.expires_at AS "expiresAt",
  a.status, a.hired_driver_id AS "hiredDriverId",
  a.hired_by_user_id AS "hiredByUserId", a.hired_at AS "hiredAt",
  a.created_at AS "createdAt", a.updated_at AS "updatedAt"
`

function buildFilter({ cdlClass, homeBaseState, minYearsExperience, desiredEquipment }) {
  const conditions = [
    `a.status = 'open'`,
    `a.posted_at <= now()`,
    `a.expires_at > now()`,
  ]
  const params = []

  if (cdlClass) {
    params.push(cdlClass)
    conditions.push(`a.cdl_class = $${params.length}`)
  }

  if (homeBaseState) {
    params.push(homeBaseState)
    conditions.push(`a.home_base_state = $${params.length}`)
  }

  if (minYearsExperience != null) {
    params.push(minYearsExperience)
    conditions.push(`a.years_experience >= $${params.length}`)
  }

  if (desiredEquipment) {
    params.push(desiredEquipment)
    conditions.push(`a.desired_equipment = $${params.length}`)
  }

  return { conditions, params }
}

function sortClause(sort) {
  switch (sort) {
    case 'experience': return 'ORDER BY a.years_experience DESC'
    case 'expiring':   return 'ORDER BY a.license_expires_on ASC'
    case 'newest':
    default:           return 'ORDER BY a.posted_at DESC'
  }
}

export async function listApplicants({ cdlClass, homeBaseState, minYearsExperience, desiredEquipment, sort, limit, offset }) {
  const { conditions, params } = buildFilter({ cdlClass, homeBaseState, minYearsExperience, desiredEquipment })
  const where = `WHERE ${conditions.join(' AND ')}`

  params.push(limit)
  const limitIdx = params.length
  params.push(offset)
  const offsetIdx = params.length

  const result = await query(
    `SELECT ${APPLICANT_COLUMNS}
     FROM driver_applicants a
     ${where}
     ${sortClause(sort)}
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  )
  return result.rows
}

export async function getApplicantById(id) {
  const result = await query(
    `SELECT ${APPLICANT_COLUMNS}
     FROM driver_applicants a
     WHERE a.id = $1`,
    [id],
  )
  return result.rows[0] ?? null
}

// Next driver ID from sequence (format: 'd' + number)
export async function nextDriverId(client) {
  const result = await client.query(
    `SELECT 'd' || nextval('hired_driver_id_seq')::text AS id`,
  )
  return result.rows[0].id
}

// Insert a new driver row from applicant data. All coordinate/location
// fields MUST be provided — computeDeadhead skips drivers with NULL coords.
export async function insertDriver(client, {
  id, name, email, phone, cdlClass, cdlNumber, licenseExpiresOn,
  homeBaseCity, homeBaseState, dutyStatus,
  payModel, payPercentBp, payPerMileCents,
  currentCity, currentState, currentLat, currentLon,
  bio, preferences = {},
}) {
  const result = await client.query(
    `INSERT INTO drivers (
       id, name, email, phone, cdl_class, cdl_number, license_expires_on,
       home_base_city, home_base_state, current_city, current_state,
       current_lat, current_lon,
       duty_status, hos_remaining_min,
       pay_model, pay_percent_bp, pay_per_mile_cents,
       bio, preferences, current_location
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11,
       $12, $13,
       -- A full clock, not NULL. NULL meant collectWarnings compared the
       -- pickup drive time against nothing, so tight-pickup-window never
       -- fired for a driver hired through HR.
       $14, $18,
       $15, $16, $17,
       $19, $20::jsonb, $21
     )
     RETURNING id`,
    [
      id, name, email, phone, cdlClass, cdlNumber, licenseExpiresOn,
      homeBaseCity, homeBaseState, currentCity, currentState,
      currentLat, currentLon,
      dutyStatus,
      payModel, payPercentBp, payPerMileCents,
      FULL_DRIVE_CLOCK_MIN, bio, JSON.stringify(preferences), `${currentCity}, ${currentState}`,
    ],
  )
  return result.rows[0]
}

// The onboarding charge already covers a physical, drug screen and MVR
// pull. Record completion in the SAME transaction; no expiry date is
// invented when the applicant does not provide one. Dispatch stays advisory.
export async function insertQualification(client, driverId, applicant) {
  await client.query(
    `INSERT INTO driver_qualification
       (driver_id, cdl_status, medical_status, mvr_checked_on, mvr_violations, mvr_status, da_status)
     VALUES ($1, 'valid', 'valid', CURRENT_DATE, $2, 'valid', 'valid')
     ON CONFLICT (driver_id) DO NOTHING`,
    [driverId, applicant.mvrViolations],
  )
}

export async function listHiredWithoutBio(client, { lock = false } = {}) {
  const result = await client.query(
    `SELECT ${APPLICANT_COLUMNS}, d.id AS "driverId",
            d.current_city AS "driverCurrentCity", d.current_state AS "driverCurrentState"
       FROM driver_applicants a JOIN drivers d ON d.id = a.hired_driver_id
      WHERE a.status = 'hired' AND NULLIF(btrim(d.bio), '') IS NULL
      ORDER BY a.id ${lock ? 'FOR UPDATE OF d, a' : ''}`,
  )
  return result.rows
}

export async function fillMissingProfile(client, driverId, { bio }) {
  const result = await client.query(
    `UPDATE drivers SET bio = $2,
       current_location = CASE
         WHEN NULLIF(btrim(current_location), '') IS NULL
          AND current_city IS NOT NULL AND current_state IS NOT NULL
         THEN current_city || ', ' || current_state ELSE current_location END,
       updated_at = now()
     WHERE id = $1 AND NULLIF(btrim(bio), '') IS NULL
     RETURNING id`,
    [driverId, bio],
  )
  return result.rows[0] ?? null
}

// Atomic conditional UPDATE on applicant — race-condition gate.
// Returns updated row on success, null on 0-row UPDATE.
export async function hireApplicantAtomically(client, applicantId, userId, driverId) {
  const result = await client.query(
    `UPDATE driver_applicants a
       SET status = 'hired',
           hired_driver_id = $1,
           hired_by_user_id = $2,
           hired_at = now(),
           updated_at = now()
     WHERE a.id = $3
       AND a.status = 'open'
       AND a.posted_at  <= now()
       AND a.expires_at > now()
     RETURNING ${APPLICANT_COLUMNS}`,
    [driverId, userId, applicantId],
  )
  return result.rows[0] ?? null
}

// Post-failure lookup to determine which error to throw.
export async function getApplicantForHire(client, applicantId) {
  const result = await client.query(
    `SELECT ${APPLICANT_COLUMNS}
     FROM driver_applicants a WHERE a.id = $1`,
    [applicantId],
  )
  return result.rows[0] ?? null
}

// Count open applicants for meta
export async function countOpenApplicants({ cdlClass, homeBaseState, minYearsExperience, desiredEquipment }) {
  const { conditions, params } = buildFilter({ cdlClass, homeBaseState, minYearsExperience, desiredEquipment })
  const result = await query(
    `SELECT count(*)::int AS count FROM driver_applicants a WHERE ${conditions.join(' AND ')}`,
    params,
  )
  return result.rows[0].count
}
