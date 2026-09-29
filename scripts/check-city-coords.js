#!/usr/bin/env node
// Checks every entry in scripts/seed/cities.js against the US Census
// state boundary it claims to be in.
//
// Why this exists: cities.js's own header says a wrong latitude there
// "produces a plausible-looking but wrong mileage that nobody downstream
// would ever catch". That was true as long as the only check on those
// numbers was a human reading them. This script is the machine that
// reads them: it projects each coordinate with the app's own projection
// and asks whether the point falls inside that state's polygon.
//
// The boundaries come from frontend/src/data/usMap.js (generated from
// us-atlas's states-10m, i.e. Census cartographic boundaries) and the
// projection from frontend/src/utils/usProjection.js -- the same two
// modules the tracking map draws with, so this check cannot disagree
// with what the app itself considers "inside Texas".
//
// Resolution: the projected view is 740x400 px for the whole continental
// US, about 4 miles per pixel. So this catches a wrong state, a swapped
// lat/lon and a sign error; it cannot catch a coordinate that is off by
// a mile inside the right state. TOLERANCE_PX allows for genuinely
// border-straddling cities (Kansas City, Davenport) and for DC, which is
// smaller than a pixel at this scale.
//
// The frontend is a separate repository. If it is not checked out beside
// this one the script says so and exits 0 rather than failing a build
// that has nothing to do with it.
//
// Usage: npm run check:cities

import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CITIES } from './seed/cities.js'

const here = dirname(fileURLToPath(import.meta.url))
const frontend = resolve(here, '..', '..', 'frontend')
const mapPath = join(frontend, 'src', 'data', 'usMap.js')
const projPath = join(frontend, 'src', 'utils', 'usProjection.js')

const TOLERANCE_PX = 1.5

if (!existsSync(mapPath) || !existsSync(projPath)) {
  console.log(`frontend not found beside this repo (${frontend}) -- skipping the boundary check.`)
  process.exit(0)
}

const { PROJECTION_BOUNDS, STATE_PATHS } = await import(pathToFileURL(mapPath).href)
const { makeProject } = await import(pathToFileURL(projPath).href)

// The generated paths use only absolute M/L and Z, one subpath per ring.
function parsePath(d) {
  const rings = []
  let ring = null
  for (const token of d.trim().split(/(?=[MLZ])/)) {
    const cmd = token[0]
    if (cmd === 'Z') { if (ring && ring.length > 2) rings.push(ring); ring = null; continue }
    const [x, y] = token.slice(1).trim().split(/\s+/).map(Number)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`unparsable path segment: ${token}`)
    if (cmd === 'M') { if (ring && ring.length > 2) rings.push(ring); ring = [[x, y]] } else ring.push([x, y])
  }
  if (ring && ring.length > 2) rings.push(ring)
  return rings
}

function insideRing(ring, px, py) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// Even-odd across every ring: a point in a state's hole (none here, but
// islands and enclaves exist in the source) is counted the same way the
// SVG renderer would count it.
function insideRings(rings, px, py) {
  let inside = false
  for (const ring of rings) if (insideRing(ring, px, py)) inside = !inside
  return inside
}

function distToSegment(px, py, [x1, y1], [x2, y2]) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

function distToRings(rings, px, py) {
  let best = Infinity
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      best = Math.min(best, distToSegment(px, py, ring[j], ring[i]))
    }
  }
  return best
}

// STATE_PATHS carries full state names; cities.js carries postal codes.
const STATE_NAME = {
  AL: 'Alabama', AR: 'Arkansas', AZ: 'Arizona', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DC: 'District of Columbia', DE: 'Delaware', FL: 'Florida',
  GA: 'Georgia', IA: 'Iowa', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', MA: 'Massachusetts',
  MD: 'Maryland', ME: 'Maine', MI: 'Michigan', MN: 'Minnesota', MO: 'Missouri',
  MS: 'Mississippi', MT: 'Montana', NC: 'North Carolina', ND: 'North Dakota',
  NE: 'Nebraska', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NV: 'Nevada', NY: 'New York', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VA: 'Virginia', VT: 'Vermont', WA: 'Washington', WI: 'Wisconsin',
  WV: 'West Virginia', WY: 'Wyoming',
}

const project = makeProject(PROJECTION_BOUNDS)
const ringsByName = new Map(STATE_PATHS.map((s) => [s.name, parsePath(s.d)]))

const inside = []
const nearBorder = []
const wrong = []

for (const c of CITIES) {
  const name = STATE_NAME[c.state]
  if (!name) { wrong.push({ c, why: `no state name for code ${c.state}` }); continue }
  const rings = ringsByName.get(name)
  if (!rings) { wrong.push({ c, why: `no boundary for ${name}` }); continue }
  const { x, y } = project(c.lat, c.lon)
  // A latitude outside +-90 (a swapped lat/lon) makes mercY() NaN, and
  // every comparison against NaN is false -- which would have read as
  // "not inside, distance unknown". Say what actually happened instead.
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    wrong.push({ c, why: `lat/lon do not project (lat ${c.lat}, lon ${c.lon}) -- swapped?` })
    continue
  }
  if (insideRings(rings, x, y)) { inside.push(c); continue }
  const d = distToRings(rings, x, y)
  if (d <= TOLERANCE_PX) nearBorder.push({ c, d })
  else wrong.push({ c, why: `${d.toFixed(2)} px (~${(d * 4).toFixed(0)} mi) outside ${name}` })
}

console.log(`${CITIES.length} cities checked against Census state boundaries`)
console.log(`  inside their state:          ${inside.length}`)
console.log(`  within ${TOLERANCE_PX} px of the border: ${nearBorder.length}`)
for (const n of nearBorder) console.log(`      ${n.c.city}, ${n.c.state} (${n.d.toFixed(2)} px)`)
console.log(`  in the wrong place:          ${wrong.length}`)
for (const w of wrong) console.log(`      ${w.c.city}, ${w.c.state}: ${w.why}`)

process.exit(wrong.length === 0 ? 0 : 1)
