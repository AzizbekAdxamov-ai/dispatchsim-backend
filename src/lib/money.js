// Rounds a fractional dollar figure to the nearest cent. Every fractional
// money value in the app (driver pay, fuel cost, margins, factoring fees,
// ...) is computed here in JS and never stored as a `numeric` column — see
// Qaror Q2 in the plan: node-pg returns `numeric` as a string, and
// `.toLocaleString()` on that silently produces garbage rather than a
// visible error.
export function money(n) {
  return Math.round(n * 100) / 100
}
