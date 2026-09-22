// Business logic for /facilities. No SQL here -- see
// facilities.repository.js.

import { AppError } from '../../lib/errors.js'
import { findCity } from '../../../scripts/seed/cities.js'
import { placeAlongRoute, SPACING_MI } from '../../../scripts/seed/facilities.js'
import * as repo from './facilities.repository.js'

// point: { lat, lon } (a raw road point, e.g. from /facilities?near=) or
// { city, state } (resolved through the closed CITIES set, the same
// "never trust a caller's own lat/lon for a CITY lookup" rule
// routing.service.js's resolveCity states -- but a facility legitimately
// sits OFF a city, on a road between two of them, so a caller-supplied
// lat/lon is accepted here when that's literally what was asked for,
// unlike routing.service.js's resolveCity which only ever takes a city).
function resolvePoint(point) {
  if (point && Number.isFinite(point.lat) && Number.isFinite(point.lon)) {
    return { lat: point.lat, lon: point.lon }
  }
  const city = findCity(point?.city, point?.state)
  if (!city) throw new AppError('UNKNOWN_CITY')
  return { lat: city.lat, lon: city.lon }
}

// The single closest facility to `point`, optionally restricted to
// `kinds`. No radius bound -- see facilities.sql.js's NEAREST_ONE_SQL.
export async function nearestTo(point, kinds) {
  const { lat, lon } = resolvePoint(point)
  return repo.nearestTo(lat, lon, kinds ?? null)
}

// Every facility within radiusMi of `point`, nearest first.
export async function listNear(point, radiusMi, kinds) {
  const { lat, lon } = resolvePoint(point)
  return repo.listNear(lat, lon, radiusMi, kinds ?? null)
}

// Every facility, filtered to `kinds` in JS rather than in SQL --
// facilities.repository.js's listAll() takes no arguments on purpose (see
// its own header: it's the full "what already exists" set
// scripts/generate-facilities.js dedupes new placements against, where a
// kind filter would never apply), so a caller that wants a kind-filtered
// full list (the /facilities endpoint with no `near`) filters what comes
// back instead of adding a second SQL shape for the same table scan.
export async function listAll(kinds) {
  const rows = await repo.listAll()
  if (!kinds || kinds.length === 0) return rows
  const allowed = new Set(kinds)
  return rows.filter((row) => allowed.has(row.kind))
}

// New stop points for one route's geometry, against every facility
// already known -- the read half of scripts/generate-facilities.js's
// generate-then-insert loop, exposed here so anything else that needs
// "what facilities would this lane need" (a future dispatcher-facing
// feature, per the plan) can ask without re-querying the database itself.
// corridorMi defaults to SPACING_MI (scripts/seed/facilities.js) -- the
// same HOS-derived spacing the generator itself uses, not a second
// default invented here.
export async function alongRoute(geometry, corridorMi = SPACING_MI) {
  const existing = await repo.listAll()
  return placeAlongRoute(geometry, { spacingMi: corridorMi, existing })
}
