import { hash01 } from '../../lib/stableHash.js'

export const MIN_ROOM = 0.08
export const MAX_ROOM = 0.22

export function ceilingFor(posting) {
  const room = MIN_ROOM + hash01(posting.id) * (MAX_ROOM - MIN_ROOM)
  const laneMax = Number.isFinite(posting.distanceMi) ? posting.distanceMi * 5 : Infinity
  return Math.min(20000, laneMax, Math.round((posting.rateUsd * (1 + room)) / 25) * 25)
}
