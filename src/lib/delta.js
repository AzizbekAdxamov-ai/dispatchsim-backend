// Shared "current vs previous period" delta shape used across the fleet
// truck-detail metrics (weeklyDistance, mpg, idleHours, maintenanceCost) —
// one function so every caller computes deltaPct/up identically instead of
// four subtly different rewrites of the same three lines.
//
// `deltaPct` is always the non-negative MAGNITUDE of the change; direction
// lives separately in `up`, matching the mock shape this replaces
// (`{ value, deltaPct, up }`).
export function withDelta(current, previous) {
  const deltaPct = previous > 0 ? Math.round((Math.abs(current - previous) / previous) * 100) : current > 0 ? 100 : 0
  return { value: current, deltaPct, up: current >= previous }
}
