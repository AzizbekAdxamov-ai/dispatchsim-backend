// Presentation-layer math shared by loads.service.js (GET /loads/:id) and
// drivers.service.js (a driver's embedded currentLoad). Neither `progress`
// nor `timeline[]` is a stored column (see Q6 in the plan) — both are
// derived from the four timestamp columns on `loads` every time they're
// read, so they can never drift out of sync with booked_at/dispatched_at/
// delivered_at the way a cached value could.
//
// `timeline[]` intentionally returns STRUCTURE, not display text: each
// entry is a `step` key + timestamp + state, never a hardcoded English
// label like "Booked" or "In Transit" — CLAUDE.md's "Hardcoded UI matni
// yoʻq" rule means those labels belong in the frontend, mapped from these
// keys, the same way `equipmentType`/`status` keys are mapped to labels
// there instead of carrying label strings over the wire.

// Clamped 0–100. `neutral` (not yet dispatched) is always 0, `done` is
// always 100 regardless of the timestamp math — a load that was delivered
// late should still read as fully complete, not >100%.
export function computeProgress({ pickupAt, deliveryAt, status }) {
  if (status === 'neutral') return 0
  if (status === 'done') return 100

  const pickup = new Date(pickupAt).getTime()
  const delivery = new Date(deliveryAt).getTime()
  if (!(delivery > pickup)) return 0

  const pct = ((Date.now() - pickup) / (delivery - pickup)) * 100
  return Math.max(0, Math.min(100, Math.round(pct)))
}

// Four fixed steps. `inTransit` has no timestamp of its own — it is "now",
// bracketed by dispatched_at and delivered_at — so its `at` is always null;
// callers that want a point-in-time for it use `progress` instead.
export function computeTimeline({ bookedAt, dispatchedAt, deliveredAt }) {
  const dispatchedState = dispatchedAt ? 'done' : 'pending'
  const inTransitState = deliveredAt ? 'done' : dispatchedAt ? 'current' : 'pending'
  const deliveredState = deliveredAt ? 'done' : 'pending'

  return [
    { step: 'booked', at: bookedAt, state: 'done' },
    { step: 'dispatched', at: dispatchedAt, state: dispatchedState },
    { step: 'inTransit', at: null, state: inTransitState },
    { step: 'delivered', at: deliveredAt, state: deliveredState },
  ]
}
