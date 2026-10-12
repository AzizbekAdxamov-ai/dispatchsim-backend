// A string -> a number in [0, 1), the same every time for the same
// string (FNV-1a, 32-bit). For choices that must hold still: a broker's
// ceiling on one load, a broker's terms across all of theirs. A person
// who changes their number between two messages reads as a machine.
export function hash01(str) {
  let h = 2166136261
  for (let i = 0; i < String(str).length; i += 1) {
    h ^= String(str).charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10000) / 10000
}
