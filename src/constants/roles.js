// Single source of truth for user role keys on the backend.
// These are the exact strings stored in the database and encoded in JWTs.
//
// Frontend display labels (e.g. "Dispatcher", "Fleet manager") live only in
// the frontend and are mapped from these keys there — human-readable labels
// must never leak into this file, the database, or auth tokens.
export const ROLE_KEYS = ['dispatcher', 'hr', 'finance', 'fleet-manager']

// Picks which of a user's granted roles becomes `active_role` when the
// caller hasn't (or can't) specify one directly — e.g. right after
// registration/invite redemption, or after an admin's role edit removes the
// role the student was currently working in. Always the ROLE_KEYS-order
// first role present in `roles`, independent of whatever order the roles
// happened to come back from SQL in (array_agg's ORDER BY role is
// alphabetical, not this order) or the order an admin checked boxes in.
// Returns null when `roles` is empty — "no work area open yet".
export function pickActiveRole(roles) {
  return ROLE_KEYS.find((k) => roles.includes(k)) ?? null
}
