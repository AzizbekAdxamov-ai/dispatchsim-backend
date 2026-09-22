// simplify.js: Ramer-Douglas-Peucker polyline simplification -- the pure
// function tracking.service.js runs the full OSRM geometry through to
// build the board's lightweight routeGeometry (see its own
// BOARD_TOLERANCE_MI header). Each test names the mutation it kills, the
// same convention laneSearch.test.js/routing.test.js already use.
//
// No database, no HTTP -- coordinates in, coordinates out.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { simplifyPath, pointToSegmentDistanceMi } from '../src/modules/routing/simplify.js'
import { haversineMi } from '../scripts/seed/cities.js'

// Total great-circle length of a [[lon,lat], ...] path, summed leg by
// leg -- used only to compare a simplified path's length against the
// original's, never by simplify.js itself.
function pathLengthMi(coordinates) {
  let total = 0
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    total += haversineMi(
      { lat: coordinates[i][1], lon: coordinates[i][0] },
      { lat: coordinates[i + 1][1], lon: coordinates[i + 1][0] },
    )
  }
  return total
}

// ---------------------------------------------------------------------
// simplifyPath: straight lines, turns, endpoints
// ---------------------------------------------------------------------

test('simplifyPath: a straight line loses its interior points, keeps both ends', () => {
  // THE MUTATION: dropping the `maxDist > toleranceMi` guard (or flipping
  // it to always push) would keep every point of a dead-straight line
  // instead of collapsing it to two.
  const straight = []
  for (let i = 0; i <= 20; i += 1) straight.push([-96.0 + i * 0.01, 30.0])

  const simplified = simplifyPath(straight, 1)

  assert.equal(simplified.length, 2)
  assert.deepEqual(simplified[0], straight[0])
  assert.deepEqual(simplified[simplified.length - 1], straight[straight.length - 1])
})

test('simplifyPath: a sharp turn is kept -- deviation well past tolerance', () => {
  // Dallas-ish coordinates, a right-angle turn: 0.5 deg north (~35 mi),
  // then 0.5 deg east. The corner sits ~35 mi off the straight line from
  // start to end -- nowhere near a 1 mi tolerance.
  // THE MUTATION: the max-deviation search picking the point with the
  // SMALLEST distance instead of the largest (`dist < maxDist`) would
  // find the wrong point, or none, and the RDP split would never happen
  // on this input -- collapsing the corner into a straight line.
  const path = [[-96.8, 32.8], [-96.8, 33.3], [-96.3, 33.3]]

  const cornerDeviation = pointToSegmentDistanceMi(path[1], path[0], path[2])
  assert.ok(cornerDeviation > 15, `corner deviation ${cornerDeviation} should be tens of miles`)

  const simplified = simplifyPath(path, 1)
  assert.equal(simplified.length, 3)
  assert.deepEqual(simplified, path)
})

test('simplifyPath: a deviation smaller than tolerance is dropped', () => {
  // Same shape as the turn above, but the corner is nudged a fraction of
  // a mile off the straight line (not 0.5 deg -- a tiny lon offset) and
  // the tolerance is set comfortably above that.
  const path = [[-96.8, 32.8], [-96.799, 33.05], [-96.8, 33.3]]
  const deviation = pointToSegmentDistanceMi(path[1], path[0], path[2])
  assert.ok(deviation < 0.1, `expected a sub-0.1mi wobble, got ${deviation}`)

  const simplified = simplifyPath(path, 1)
  assert.equal(simplified.length, 2)
  assert.deepEqual(simplified[0], path[0])
  assert.deepEqual(simplified[1], path[2])
})

test('simplifyPath: first and last points are always kept, any tolerance', () => {
  // THE MUTATION: seeding `keep` without forcing index 0 / n-1 to 1 (or
  // an off-by-one range in the stack's initial [start, end]) could drop
  // an endpoint on a path whose real first/last points are themselves
  // "redundant" relative to their neighbors.
  const path = [[-100, 30], [-99, 30], [-98, 30], [-97, 30], [-96, 30]]
  // A huge tolerance -- everything in the middle collapses, but the
  // contract is the two ends survive regardless.
  const simplified = simplifyPath(path, 100000)
  assert.equal(simplified.length, 2)
  assert.deepEqual(simplified[0], path[0])
  assert.deepEqual(simplified[1], path[path.length - 1])
})

test('simplifyPath: a two-point path is returned unchanged', () => {
  const path = [[-96.0, 32.0], [-95.0, 33.0]]
  const simplified = simplifyPath(path, 0.001)
  assert.deepEqual(simplified, path)
  // Not the SAME array reference -- callers should be free to treat the
  // result as their own copy.
  assert.notEqual(simplified, path)
})

// ---------------------------------------------------------------------
// pointToSegmentDistanceMi: segment distance, not vertex distance
// ---------------------------------------------------------------------

test('pointToSegmentDistanceMi: perpendicular to the SEGMENT, not the nearest vertex', () => {
  // A, B ~530 mi apart (roughly Oklahoma City to just past Nashville,
  // along one latitude). C sits almost exactly abeam the segment's own
  // midpoint, half a degree of latitude off the line -- close to the
  // LINE, far from either END.
  //
  // THE MUTATION this catches: a "point-to-point" stand-in (distance to
  // whichever endpoint is nearer) would answer ~300 mi here -- ten times
  // too far -- because C is nowhere near A or B individually, only near
  // the line connecting them. A correct point-to-segment distance must
  // answer with the much smaller cross-track figure.
  const A = [-100, 30]
  const B = [-90, 30]
  const C = [-95, 30.5]

  const segmentDistance = pointToSegmentDistanceMi(C, A, B)
  const nearestVertexDistance = Math.min(
    haversineMi({ lat: C[1], lon: C[0] }, { lat: A[1], lon: A[0] }),
    haversineMi({ lat: C[1], lon: C[0] }, { lat: B[1], lon: B[0] }),
  )

  assert.ok(segmentDistance < 30, `segment distance ${segmentDistance} should be well under 30 mi`)
  assert.ok(nearestVertexDistance > 250, `vertex distance ${nearestVertexDistance} should be hundreds of miles`)
  assert.ok(segmentDistance < nearestVertexDistance / 5, 'point-to-segment must read far smaller than point-to-point here')

  // And RDP itself must act on the SEGMENT figure: with a tolerance that
  // sits strictly between the two (comfortably above the correct segment
  // distance, comfortably below the wrong vertex-distance one), the
  // point must be dropped. A point-to-point stand-in would keep it.
  const simplified = simplifyPath([A, C, B], 40)
  assert.equal(simplified.length, 2, 'a point-to-point distance would have wrongly kept the middle point here')
})

test('pointToSegmentDistanceMi: a point off the END of a short segment measures to that endpoint', () => {
  // C is due north of B, past the end of the A->B segment -- its
  // perpendicular foot on the great circle through A/B falls outside
  // [A, B], so the answer must be the ordinary distance to B (the
  // nearer end), not a cross-track figure computed as if the segment
  // extended infinitely past B.
  const A = [-97, 30]
  const B = [-96, 30]
  const C = [-96, 30.2]

  const distance = pointToSegmentDistanceMi(C, A, B)
  const distanceToB = haversineMi({ lat: C[1], lon: C[0] }, { lat: B[1], lon: B[0] })
  assert.ok(Math.abs(distance - distanceToB) < 0.5, `expected ~${distanceToB}, got ${distance}`)
})

// ---------------------------------------------------------------------
// Fidelity: the simplified path must not meaningfully shorten the route
// ---------------------------------------------------------------------

test('simplifyPath: simplified path length stays close to the original', () => {
  // A ~1,000 mi Dallas -> Orlando-ish path, 401 points, with a small
  // deterministic wiggle standing in for a real road's own bends (a
  // dead-straight synthetic line would trivially simplify to 2 points
  // and prove nothing about length preservation).
  const DALLAS = [-96.7970, 32.7767]
  const ORLANDO = [-81.3792, 28.5383]
  const n = 400
  const path = []
  for (let i = 0; i <= n; i += 1) {
    const f = i / n
    const lon = DALLAS[0] + (ORLANDO[0] - DALLAS[0]) * f
    const lat = DALLAS[1] + (ORLANDO[1] - DALLAS[1]) * f + 0.15 * Math.sin(f * 40)
    path.push([lon, lat])
  }

  const originalLength = pathLengthMi(path)
  // The production tolerance (tracking.service.js's BOARD_TOLERANCE_MI).
  // Not imported -- that constant lives in a service module with its own
  // dependencies (loads.repository.js, routing.service.js); the number
  // is repeated here as a plain literal, same as this file's other
  // hand-picked test fixtures.
  const BOARD_TOLERANCE_MI = 3
  const simplified = simplifyPath(path, BOARD_TOLERANCE_MI)
  const simplifiedLength = pathLengthMi(simplified)

  assert.ok(simplified.length < path.length, 'should actually drop points')
  const pctDiff = (100 * Math.abs(simplifiedLength - originalLength)) / originalLength
  // A simplified polyline is a set of chords across the original curve,
  // so it is ALWAYS shorter, never longer -- 2% is a generous ceiling
  // for a wiggle this gentle at this tolerance (measured actual: well
  // under 1%).
  assert.ok(pctDiff < 2, `length drifted ${pctDiff.toFixed(2)}% -- original ${originalLength.toFixed(1)} mi, simplified ${simplifiedLength.toFixed(1)} mi`)
})
