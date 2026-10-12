// The runs a driver has asked not to be given (drivers.preferences, 054).
//
// One reader for the jsonb, so the dispatch check, the driver's own
// prompt and the profile page all mean the same thing by it. It takes
// what it understands -- avoidCities, avoidStates, why -- and ignores
// anything else, so a request kind added later does not break a reader
// that does not know it yet.
//
// Nothing here enforces. A conflict is a FACT the dispatcher is shown and
// the driver reacts to; whether to dispatch anyway is the student's call.

function placeKey(city, state) {
  return `${String(city ?? '').trim().toLowerCase()}|${String(state ?? '').trim().toUpperCase()}`
}

export function readPreferences(raw) {
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const avoidCities = (Array.isArray(p.avoidCities) ? p.avoidCities : [])
    .filter((c) => c && typeof c.city === 'string' && typeof c.state === 'string')
    .map((c) => ({ city: c.city.trim(), state: c.state.trim().toUpperCase() }))
  const avoidStates = (Array.isArray(p.avoidStates) ? p.avoidStates : [])
    .filter((s) => typeof s === 'string' && s.trim() !== '')
    .map((s) => s.trim().toUpperCase())
  const why = typeof p.why === 'string' && p.why.trim() !== '' ? p.why.trim() : null
  return { avoidCities, avoidStates, why }
}

export function hasRequests(prefs) {
  return prefs.avoidCities.length > 0 || prefs.avoidStates.length > 0
}

// The places, said the way a dispatcher would: "New York, NY", "NJ".
export function avoidedPlaces(prefs) {
  return [...prefs.avoidCities.map((c) => `${c.city}, ${c.state}`), ...prefs.avoidStates]
}

// Where a lane runs into a request: the pickup, the delivery, or both.
// Each conflict names the place and which end of the trip it is.
export function preferenceConflicts(prefs, lane) {
  const cities = new Set(prefs.avoidCities.map((c) => placeKey(c.city, c.state)))
  const states = new Set(prefs.avoidStates)
  const out = []
  for (const [end, city, state] of [
    ['pickup', lane.originCity, lane.originState],
    ['delivery', lane.destinationCity, lane.destinationState],
  ]) {
    const st = String(state ?? '').toUpperCase()
    if (cities.has(placeKey(city, state))) out.push({ end, place: `${city}, ${st}` })
    else if (states.has(st)) out.push({ end, place: st })
  }
  return out
}
