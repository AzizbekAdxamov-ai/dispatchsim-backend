// Ramer-Douglas-Peucker polyline simplification, for one job: turning the
// full OSRM road geometry (osrm.js now asks for overview=full -- see its
// own header on why, and the point counts that made 'simplified' unusable
// at city zoom) into the lightweight copy tracking.service.js sends on
// every 10s board poll. The full geometry itself is never thrown away --
// it stays in lane_routes and is what position.js's pointAlongPath()
// walks for the marker -- this module only ever produces a SEPARATE,
// shorter array for the map to draw at a zoom level where the difference
// is invisible. See tracking.service.js's BOARD_TOLERANCE_MI for how the
// tolerance passed in here is derived.
//
// Pure function, no I/O, no knowledge of miles-per-pixel or the board --
// same split as position.js/laneSearch.js: the geometry math is testable
// without a database or a screen.

// Earth radius in miles, same as scripts/seed/cities.js's own
// EARTH_RADIUS_MI (matching the haversineMi() it exports below). Not
// re-exported from there -- cities.js keeps it module-private -- so it is
// repeated here rather than reached into, the same duplication
// usProjection.js already accepts for interpolateGreatCircle() (see that
// file's own header: "the same math position.js uses server-side").
const EARTH_RADIUS_MI = 3958.8

function toRad(deg) {
  return (deg * Math.PI) / 180
}

function toLatLon([lon, lat]) {
  return { lat, lon }
}

// Great-circle angular separation between two points, in RADIANS (not
// miles -- the cross-track/along-track formulas below need the angle
// itself, miles is angle * EARTH_RADIUS_MI). Same haversine formula
// cities.js's haversineMi() uses, kept in radian form here because
// dividing a mile figure back into radians would be the same computation
// done twice for no reason.
function angularDistanceRad(a, b) {
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)))
}

// Initial bearing from a to b, in radians, standard forward-azimuth
// formula (movable-type.co.uk's own reference derivation, the same one
// GPS/marine navigation software uses). Needed only as an input to
// crossTrackDistanceMi below -- never returned on its own.
function bearingRad(a, b) {
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const dLon = toRad(b.lon - a.lon)
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return Math.atan2(y, x)
}

// Perpendicular distance, in miles, from point `p` to the SEGMENT
// `segStart` -> `segEnd` -- not to the infinite line through them, and
// not to whichever endpoint happens to be closer (a naive point-to-point
// distance, which is a different, wrong number -- see simplify.test.js's
// "point-to-segment, not point-to-point" case for a concrete triple where
// the two disagree).
//
// Method: great-circle cross-track distance (the point's perpendicular
// distance to the GREAT CIRCLE that passes through segStart and segEnd),
// then clamp to the segment by checking the along-track distance -- the
// distance from segStart to the point on that great circle nearest `p`.
// If that projected point falls before segStart or after segEnd, the
// nearest point ON THE SEGMENT is whichever endpoint is closer, and the
// answer is the ordinary haversine distance to that endpoint instead.
//
// A flat/planar approximation (project lon/lat onto a local x/y plane and
// do 2D point-to-segment geometry) would be simpler, but a single RDP
// pass on a full route runs its first comparison against the segment
// spanning the ENTIRE path (e.g. Dallas -> Orlando, 1,085 mi, 14+ degrees
// of longitude) -- a flat projection distorts badly over a span that
// wide, right where the algorithm's very first decision is made. The
// spherical formula used here is exact regardless of segment length, the
// same standard this codebase already holds itself to for geography
// (position.js's slerp, cities.js's haversineMi).
export function pointToSegmentDistanceMi(point, segStart, segEnd) {
  const p = toLatLon(point)
  const a = toLatLon(segStart)
  const b = toLatLon(segEnd)

  // Degenerate segment (both ends the same coordinate, e.g. a route whose
  // geometry momentarily repeats a vertex) -- there is no "line" to
  // project onto, only a point to measure straight to.
  const segAngular = angularDistanceRad(a, b)
  if (segAngular < 1e-12) {
    return angularDistanceRad(a, p) * EARTH_RADIUS_MI
  }

  const d13 = angularDistanceRad(a, p)
  if (d13 < 1e-12) return 0 // p IS segStart

  const theta13 = bearingRad(a, p)
  const theta12 = bearingRad(a, b)

  // Signed cross-track angular distance: how far off the GREAT CIRCLE
  // through a/b the point p sits, positive/negative by side. Clamped into
  // asin's domain -- floating-point can push the sine product a hair past
  // 1 for a point almost exactly on the line, which would otherwise turn
  // a ~0 mi deviation into NaN.
  const sinCrossTrack = Math.sin(d13) * Math.sin(theta13 - theta12)
  const crossTrackRad = Math.asin(Math.min(1, Math.max(-1, sinCrossTrack)))

  // Along-track angular distance: how far from `a`, ALONG the great
  // circle, the point nearest p (its perpendicular foot) sits.
  const cosCrossTrack = Math.cos(crossTrackRad)
  const alongTrackRad = cosCrossTrack === 0
    ? 0
    : Math.acos(Math.min(1, Math.max(-1, Math.cos(d13) / cosCrossTrack)))

  if (alongTrackRad < 0 || alongTrackRad > segAngular) {
    // The perpendicular foot falls outside a..b -- the closest point ON
    // THE SEGMENT is an endpoint, not a point on the line beyond it.
    return Math.min(angularDistanceRad(a, p), angularDistanceRad(b, p)) * EARTH_RADIUS_MI
  }

  return Math.abs(crossTrackRad) * EARTH_RADIUS_MI
}

// Ramer-Douglas-Peucker, iterative (an explicit stack of [startIdx, endIdx]
// index ranges into the ORIGINAL array, not recursive calls on sliced
// copies) -- a full OSRM route can carry several thousand points (see
// osrm.js's own header: 2,000+ for a 1,085 mi lane), and a pathological
// point arrangement can make naive recursion's depth track the point
// count 1:1. An explicit stack has no call-depth limit to hit and never
// copies the array except once, at the end, to build the kept-points
// result.
//
// `coordinates`: [[lon,lat], ...] (OSRM's own order, matching osrm.js /
// lane_routes.geometry -- see osrm.js's header on why this is kept
// verbatim rather than converted to {lat,lon}). `toleranceMi`: a point is
// dropped only if EVERY point between the two ends currently bracketing
// it deviates from the segment connecting them by `toleranceMi` or less;
// the caller decides that number (tracking.service.js's
// BOARD_TOLERANCE_MI derives it from the board map's own screen scale --
// see the comment there for the full computation, not repeated here so
// the two can't drift apart in the retelling).
//
// The first and last coordinate are ALWAYS kept -- a simplified route
// that no longer starts/ends at the lane's own endpoints would silently
// shift where the line begins and ends, which is a worse error than any
// amount of mid-route smoothing.
export function simplifyPath(coordinates, toleranceMi) {
  if (!Array.isArray(coordinates)) return coordinates
  const n = coordinates.length
  if (n <= 2) return coordinates.slice()

  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1

  const stack = [[0, n - 1]]
  while (stack.length > 0) {
    const [startIdx, endIdx] = stack.pop()
    if (endIdx <= startIdx + 1) continue // no point strictly between them

    const segStart = coordinates[startIdx]
    const segEnd = coordinates[endIdx]

    let maxDist = -1
    let maxIdx = -1
    for (let i = startIdx + 1; i < endIdx; i += 1) {
      const dist = pointToSegmentDistanceMi(coordinates[i], segStart, segEnd)
      if (dist > maxDist) {
        maxDist = dist
        maxIdx = i
      }
    }

    if (maxDist > toleranceMi) {
      keep[maxIdx] = 1
      stack.push([startIdx, maxIdx])
      stack.push([maxIdx, endIdx])
    }
    // else: every point between startIdx/endIdx is within tolerance of the
    // straight segment connecting them -- none of them get kept, and the
    // range collapses to just its two (already-kept) ends.
  }

  const result = []
  for (let i = 0; i < n; i += 1) {
    if (keep[i]) result.push(coordinates[i])
  }
  return result
}
