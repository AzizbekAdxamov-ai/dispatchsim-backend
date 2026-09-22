// Dispatch > Routes: plan a trip through up to seven cities, the way a
// truck route planner does, with the law's stops in it.

import { AppError } from '../../lib/errors.js'
import { resolveCity } from '../tracking/laneSearch.js'
import { routesFor } from '../routing/routing.service.js'
import * as facilitiesService from '../facilities/facilities.service.js'
import { planStops, projectOntoRoute, ROUTE_CORRIDOR_MI, describeWarning } from '../facilities/stopPlan.js'
import { summarizeTrip } from './tripSummary.js'

// A full tank at the start: trucks.fuel_capacity_gal's own DEFAULT
// (migration 006_trucks.sql) -- the planner has no particular truck.
export const PLANNER_TANK_GAL = 240

const STOP_KINDS = new Set(['truck_stop', 'fuel', 'repair', 'rest_area'])

export async function planTrip({ waypoints, truck }) {
  const resolved = waypoints.map((q, i) => {
    const c = resolveCity(q)
    if (!c) throw new AppError('UNKNOWN_CITY', { waypoint: i, query: q })
    return { city: c.city, state: c.state, lat: c.lat, lon: c.lon }
  })

  const legs = []
  for (let i = 0; i < resolved.length - 1; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- legs are few; each is a
    // cache read after the first time anyone plans that pair.
    const routes = await routesFor(resolved[i], resolved[i + 1])
    const primary = routes.find((r) => r.alternativeIndex === 0) ?? routes[0]
    if (!primary) throw new AppError('ROUTE_UNAVAILABLE')
    legs.push(primary)
  }

  // One line for the whole trip: each leg's geometry, joined without
  // repeating the shared waypoint.
  const geometry = legs.flatMap((l, i) => (i === 0 ? l.geometry : l.geometry.slice(1)))
  const distanceMi = legs.reduce((s, l) => s + l.distanceMi, 0)

  const facilities = await facilitiesService.listAll()
  const departAt = new Date().toISOString()
  const plan = planStops({
    routeGeometry: geometry,
    distanceMi,
    startFuelGallons: PLANNER_TANK_GAL,
    fuelCapacityGal: PLANNER_TANK_GAL,
    facilities,
    dispatchedAt: departAt,
  })

  const summary = summarizeTrip({ waypoints: resolved, legs, truck, dutyTimeline: plan.dutyTimeline })

  // Every stop inside the routing corridor, in road order -- where the
  // driver COULD stop; `plannedStops` below is where the law says they WILL.
  // Offsets are measured along the geometry in its own miles; scaled to
  // the legs' road miles so "mile 412" here is mile 412 of the summary.
  const [endLon, endLat] = geometry[geometry.length - 1]
  const geometryMi = projectOntoRoute(geometry, { lat: endLat, lon: endLon }).offsetMi
  const scale = geometryMi > 0 ? distanceMi / geometryMi : 1
  const truckStops = facilities
    .filter((f) => STOP_KINDS.has(f.kind))
    .map((f) => {
      const { offsetMi, perpMi } = projectOntoRoute(geometry, { lat: Number(f.lat), lon: Number(f.lon) })
      return { f, offsetMi: offsetMi * scale, perpMi }
    })
    .filter((x) => x.perpMi <= ROUTE_CORRIDOR_MI)
    .sort((a, b) => a.offsetMi - b.offsetMi)
    .map(({ f, offsetMi, perpMi }) => ({
      id: f.id,
      name: f.name,
      kind: f.kind,
      city: f.nearCity,
      state: f.nearState,
      mile: Math.round(offsetMi),
      offRouteMi: Math.round(perpMi * 10) / 10,
      lat: Number(f.lat),
      lon: Number(f.lon),
      fuelPriceCents: f.fuelPriceCents ?? null,
      amenities: f.amenities ?? [],
    }))

  const byId = new Map(facilities.map((f) => [f.id, f]))

  // A rest with no facility is still a stop the plan makes -- the timeline
  // and legalArrivalAt already carry it -- but `plan.stops` only holds
  // facility-backed rows (stop_visits.facility_id is NOT NULL, 036), so
  // without this the summary's own "Stops 10h 30m" pointed at a report
  // that read "no stop is required". Shoulder rests come from the timeline's
  // stationary off-duty/sleeper blocks that no facility-backed stop covers.
  const coveredAt = new Set(plan.stops.map((s) => s.routeOffsetMi))
  const shoulderRests = (plan.dutyTimeline ?? [])
    .filter((e) => (e.status === 'off-duty' || e.status === 'sleeper-berth')
      && e.routeOffsetMi != null
      && !coveredAt.has(Math.round(e.routeOffsetMi)))
    .map((e) => ({
      reason: 'rest',
      mile: Math.round(e.routeOffsetMi),
      facility: null, // the 'Roadside' row the report already knows how to render
      gallons: null,
      costUsd: null,
    }))

  return {
    ...summary,
    truck,
    geometry,
    tankGal: PLANNER_TANK_GAL,
    plannedStops: [
      ...plan.stops.map((s) => ({
        reason: s.reason,
        mile: s.routeOffsetMi,
        facility: byId.has(s.facilityId)
          ? {
            id: s.facilityId,
            name: byId.get(s.facilityId).name,
            city: byId.get(s.facilityId).nearCity,
            state: byId.get(s.facilityId).nearState,
            lat: Number(byId.get(s.facilityId).lat),
            lon: Number(byId.get(s.facilityId).lon),
          }
          : null,
        gallons: s.gallons,
        costUsd: s.costUsd,
      })),
      ...shoulderRests,
    ].sort((a, b) => a.mile - b.mile),
    hosFacts: [...plan.hosFacts, ...plan.warnings.map((w) => ({ code: w.code, cfr: null, detail: describeWarning(w) }))],
    truckStops,
  }
}
