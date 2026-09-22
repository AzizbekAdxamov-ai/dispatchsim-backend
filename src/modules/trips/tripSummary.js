// The numbers on a trip plan, from the legs and the truck's cost inputs.
// Pure -- trips.service.js does the I/O. The layout these fill (Vehicle,
// Start/Stops/End with running miles and hours, Dist/Time/Stops/Driving,
// Tolls/Fuel/Fixed/Total) is the truck route planner dispatchers use
// (TruckRouter's Trip Summary, from Azizbek's screenshots, 2026-09-21).
//
//   Driving  -- per leg, the road's own duration (OSRM), never faster than
//               the truck's max speed allows: max(duration, miles / mph).
//   Stops    -- the time the HOS-legal plan (facilities/stopPlan.js) puts
//               the truck OFF the road: 30-minute breaks, 10-hour rests,
//               34-hour restarts, fuel stops. A planner that showed only
//               driving time would promise an arrival the law forbids.
//   Fuel     -- miles / MPG * $/gal.
//   Fixed    -- cost per mile * miles + cost per hour * total hours, the
//               planner's own definition (0.40 * 2,084.9 mi + 15 * 31.03 h
//               = $1,299.42 on the reference screenshot).
//   Tolls    -- null: this project has no toll data. Said, not guessed.

export function legDrivingMinutes(leg, maxMph) {
  const road = Number(leg.durationMin) || 0
  if (!(maxMph > 0)) return road
  return Math.max(road, (leg.distanceMi / maxMph) * 60)
}

// Minutes of the plan that are not driving.
export function stopMinutes(dutyTimeline) {
  let ms = 0
  for (const e of dutyTimeline || []) {
    if (e.status === 'driving') continue
    ms += new Date(e.endedAt).getTime() - new Date(e.startedAt).getTime()
  }
  return ms / 60000
}

const round2 = (x) => Math.round(x * 100) / 100
const round1 = (x) => Math.round(x * 10) / 10

export function summarizeTrip({ waypoints, legs, truck, dutyTimeline }) {
  const drivingPerLeg = legs.map((l) => legDrivingMinutes(l, truck.maxMph))
  const distanceMi = legs.reduce((s, l) => s + l.distanceMi, 0)
  const drivingMin = drivingPerLeg.reduce((s, m) => s + m, 0)
  const stopsMin = stopMinutes(dutyTimeline)
  const timeMin = drivingMin + stopsMin

  const fuelUsd = truck.mpg > 0 ? (distanceMi / truck.mpg) * truck.fuelPricePerGal : null
  const fixedUsd = truck.costPerMile * distanceMi + truck.costPerHour * (timeMin / 60)

  // Running totals at each waypoint, the way the summary lists them.
  let mi = 0
  let min = 0
  const points = waypoints.map((w, i) => {
    if (i > 0) {
      mi += legs[i - 1].distanceMi
      min += drivingPerLeg[i - 1]
    }
    return { ...w, cumulativeMi: round1(mi), cumulativeDrivingMin: Math.round(min) }
  })

  return {
    waypoints: points,
    legs: legs.map((l, i) => ({
      from: waypoints[i],
      to: waypoints[i + 1],
      distanceMi: round1(l.distanceMi),
      drivingMin: Math.round(drivingPerLeg[i]),
      roadRefs: l.roadRefs ?? [],
    })),
    totals: {
      distanceMi: round1(distanceMi),
      timeMin: Math.round(timeMin),
      stopsMin: Math.round(stopsMin),
      drivingMin: Math.round(drivingMin),
      tollsUsd: null,
      fuelUsd: fuelUsd == null ? null : round2(fuelUsd),
      fixedUsd: round2(fixedUsd),
      totalUsd: round2((fuelUsd ?? 0) + fixedUsd),
    },
  }
}
