// Payment terms and how many days each one allows before an invoice is due.
//
// Single source of truth: migration 014 mirrors these keys in the
// `loads_terms_valid` CHECK, and finance.repository.js builds its SQL CASE
// from TERM_DAYS below rather than hardcoding a second copy — a duplicated
// day count that drifts would quietly mis-age every receivable.
//
// net45/net60 exist so a broker's real payment behaviour can be expressed.
// A 'D' rated broker that pays in 68 days cannot be represented by net30,
// and flattening it to net30 would erase exactly the consequence the
// student is supposed to feel.

export const TERM_DAYS = Object.freeze({
  quickpay: 2,
  net15: 15,
  net30: 30,
  net45: 45,
  net60: 60,
})

export const TERM_KEYS = Object.freeze(Object.keys(TERM_DAYS))

// A broker's stated days-to-pay -> the closest term that does not promise
// faster payment than the broker actually gives. Rounding DOWN would make a
// slow broker look punctual, so each band is chosen by upper bound.
export function termsForDaysToPay(days) {
  if (days == null) return 'net30'
  if (days <= 20) return 'net15'
  if (days <= 35) return 'net30'
  if (days <= 50) return 'net45'
  return 'net60'
}

// Renders the SQL fragment finance uses to turn a term into an interval.
// Built from TERM_DAYS so the SQL and the JS can never disagree.
export function termsIntervalSql(column = 'l.payment_terms') {
  const whens = TERM_KEYS
    .map((k) => `        WHEN '${k}' THEN interval '${TERM_DAYS[k]} days'`)
    .join('\n')
  return `CASE ${column}\n${whens}\n        ELSE interval '30 days'\n      END`
}
