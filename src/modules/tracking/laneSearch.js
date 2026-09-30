// Lane search + recommendation math for the fleet map's A→B panel.
//
// Pure functions only: query strings in, resolved cities and ranked
// postings out, no database. The endpoint in tracking.service.js wraps
// these with the open-postings read -- the same split position.js uses
// so the geometry can be tested without a database.
//
// Everything here answers a dispatcher's actual question: "if I put a
// truck on lane A→B, what's out there?" The lane's own miles come from
// cities.js's roadMiles() -- the SAME function the seed used to store
// distance_mi on every load and posting, so a searched lane can never
// quote a mileage the board itself would disagree with.

import { CITIES, roadMiles } from '../../../scripts/seed/cities.js'

// "Dallas, TX" / "dallas , tx" -> the city row. Both parts are matched
// case-insensitively -- people type "dallas, tx", not "Dallas, TX". Bare
// names work when they are unambiguous ("Dallas"); if two cities in the
// set ever share a name, a bare query returns null rather than guessing
// -- a wrong guess draws the lane to the wrong state, which is worse
// than making the user type the state. Since the set grew to cover all
// 48 states there are real collisions in it (Portland ME/OR, Charleston
// SC/WV, Springfield IL/MO), so this path is load-bearing rather than
// theoretical; cityCompletions() below is how a user reaches either one.
export function resolveCity(query) {
  const q = typeof query === 'string' ? query.trim() : ''
  if (!q) return null

  const withState = q.match(/^(.+?),\s*([A-Za-z]{2})$/)
  if (withState) {
    const name = withState[1].trim().toLowerCase()
    const state = withState[2].toUpperCase()
    return CITIES.find((c) => c.city.toLowerCase() === name && c.state === state) || null
  }

  const bare = CITIES.filter((c) => c.city.toLowerCase() === q.toLowerCase())
  return bare.length === 1 ? bare[0] : null
}

// Google-style type-ahead: every city whose name (or "City, ST" pair)
// starts with the query, most-populous-name-first is not knowable here --
// alphabetical keeps the dropdown stable across keystrokes, which reads
// as calmer than entries jumping around. `limit` guards the payload; the
// closed set is under 200 cities, so worst case is tiny anyway.
export function cityCompletions(query, limit = 6) {
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (q.length < 2) return []

  const matches = CITIES
    .filter((c) => c.city.toLowerCase().startsWith(q) || `${c.city}, ${c.state}`.toLowerCase().startsWith(q))
    .sort((a, b) => (a.city + a.state).localeCompare(b.city + b.state))
    .slice(0, limit)
    .map(({ city, state, lat, lon }) => ({ city, state, lat, lon }))

  return matches
}

// Per-posting scorecard: what the ranking is made of, kept next to the
// row so the UI can state WHY a posting is recommended instead of only
// showing an order (and so a test can pin each component separately).
export function scorePosting(posting, { lane, anchor }) {
  const ratePerMile = posting.rateUsd != null && posting.distanceMi > 0
    ? Math.round((posting.rateUsd / posting.distanceMi) * 100) / 100
    : null

  // Deadhead from the searched origin when there is one; a destination-
  // only search anchors nothing (the truck would already be at B after
  // the lane, so the origin deadhead is the number that matters -- but
  // with no A there is no honest anchor, hence null).
  const deadheadMi = anchor
    ? roadMiles(anchor, { lat: posting.originLat, lon: posting.originLon })
    : null

  // 2 = the posting IS this lane. 1 = shares one end (a truck could take
  // it first or deadhead out after). 0 = off-lane filler for the panel.
  let laneFit = 0
  if (lane) {
    const sameOrigin = posting.originCity === lane.origin.city && posting.originState === lane.origin.state
    const sameDest = posting.destinationCity === lane.destination.city && posting.destinationState === lane.destination.state
    laneFit = sameOrigin && sameDest ? 2 : (sameOrigin || sameDest) ? 1 : 0
  }

  return { ratePerMile, deadheadMi, laneFit }
}

// The panel's list: exact-lane freight first (highest $/mile within the
// tier), then one-end freight, then the best of the rest. A hidden rate
// ("call for rate") can't be ranked on price -- within its tier it sinks
// below ranked postings rather than masquerading as a 0 $/mile bargain,
// and the row says why: rateHidden comes back on the posting.
export function rankPostings(postings, { lane = null, anchor = null, limit = 6 } = {}) {
  const scored = postings.map((p) => ({
    ...p,
    score: scorePosting(p, { lane, anchor }),
  }))

  scored.sort((a, b) => {
    if (b.score.laneFit !== a.score.laneFit) return b.score.laneFit - a.score.laneFit
    const aRate = a.score.ratePerMile
    const bRate = b.score.ratePerMile
    if (aRate == null && bRate != null) return 1
    if (bRate == null && aRate != null) return -1
    if (aRate != null && bRate != null && bRate !== aRate) return bRate - aRate
    const aDead = a.score.deadheadMi
    const bDead = b.score.deadheadMi
    if (aDead != null && bDead != null && aDead !== bDead) return aDead - bDead
    return a.id - b.id
  })

  return scored.slice(0, limit)
}

// No lane searched yet: the panel still has to say something useful.
// Hot lanes = the open postings grouped into origin→destination pairs,
// busiest first, with the pair's average $/mile as the price signal.
// One posting = one lane is fine (count 1 is honest); the sort prefers
// pairs the market keeps repeating.
export function hotLanes(postings, limit = 6) {
  const groups = new Map()
  for (const p of postings) {
    const key = `${p.originCity},${p.originState}->${p.destinationCity},${p.destinationState}`
    if (!groups.has(key)) {
      groups.set(key, {
        origin: { city: p.originCity, state: p.originState, lat: p.originLat, lon: p.originLon },
        destination: { city: p.destinationCity, state: p.destinationState, lat: p.destinationLat, lon: p.destinationLon },
        count: 0,
        rateSum: 0,
        ratedCount: 0,
        distanceMi: p.distanceMi,
      })
    }
    const g = groups.get(key)
    g.count += 1
    if (p.rateUsd != null && p.distanceMi > 0) {
      g.rateSum += p.rateUsd / p.distanceMi
      g.ratedCount += 1
    }
  }

  const lanes = [...groups.values()].map((g) => ({
    origin: g.origin,
    destination: g.destination,
    count: g.count,
    avgRatePerMile: g.ratedCount > 0 ? Math.round((g.rateSum / g.ratedCount) * 100) / 100 : null,
    distanceMi: g.distanceMi,
  }))

  lanes.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    const aRate = a.avgRatePerMile
    const bRate = b.avgRatePerMile
    if (aRate == null && bRate != null) return 1
    if (bRate == null && aRate != null) return -1
    if (aRate != null && bRate != null && bRate !== aRate) return bRate - aRate
    return 0
  })

  return lanes.slice(0, limit)
}
