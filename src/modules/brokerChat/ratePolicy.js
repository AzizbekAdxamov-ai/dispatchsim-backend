import { hash01 } from '../../lib/stableHash.js'

export const MIN_ROOM = 0.08
export const MAX_ROOM = 0.22
// Azizbek qarori 2026-11-06 — the broker's maximum is a round rate.
export const CEILING_STEP_USD = 25

export function ceilingFor(posting) {
  const room = MIN_ROOM + hash01(posting.id) * (MAX_ROOM - MIN_ROOM)
  const laneMax = Number.isFinite(posting.distanceMi) ? posting.distanceMi * 5 : Infinity
  const ceiling = Math.min(20000, laneMax, Math.round((posting.rateUsd * (1 + room)) / CEILING_STEP_USD) * CEILING_STEP_USD)
  // Never offer less than an existing posted price for legacy live quotes.
  return Math.max(posting.rateUsd, Math.floor(ceiling / CEILING_STEP_USD) * CEILING_STEP_USD)
}
