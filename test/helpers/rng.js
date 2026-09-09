// A seeded RNG, so a distribution test that passes today passes tomorrow.
// mulberry32: 32-bit state, uniform enough for counting outcomes and small
// enough to read in one sitting.
export function seeded(seed = 1) {
  let a = seed >>> 0
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
