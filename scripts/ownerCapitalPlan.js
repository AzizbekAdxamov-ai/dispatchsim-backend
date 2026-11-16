// The pure half of owner-capital.js: reading the command line and deciding
// how much to suggest. No database, no process.

export const OWNER_CAPITAL_KIND = 'adjustment'
export const OWNER_CAPITAL_DESCRIPTION = 'Owner capital contribution'

// A contribution above this is a typo, not a decision: the company opens
// with $200,000 (OPENING_BALANCE_USD) and the credit line is $50,000.
export const OWNER_CAPITAL_MAX_USD = 500000

// The balance the suggestion aims for: a working cushion above zero, not
// just enough to unlock the credit line.
export const TARGET_BALANCE_USD = 50000

// A second contribution inside this window is almost surely the same command
// run twice. Real top-ups are minutes apart at the very least; --force-duplicate
// overrides it on purpose.
export const DUPLICATE_WINDOW_MINUTES = 10

const MS_PER_MINUTE = 60000
const FLAG_CONFIRM = '--confirm'
const FLAG_FORCE_DUPLICATE = '--force-duplicate'
const FLAG_ALLOW_REMOTE = '--allow-remote'
const FLAG_COMPANY = '--company'
const WHOLE_DOLLARS = /^\d+$/

// amount_usd is an integer column (019): whole dollars only.
export function validateAmount(raw) {
  if (raw === undefined || raw === '') return { error: 'amount is required, e.g. 141649' }
  if (!WHOLE_DOLLARS.test(raw)) return { error: `amount must be a positive whole number of dollars (got "${raw}")` }
  const amountUsd = Number(raw)
  if (amountUsd <= 0) return { error: 'amount must be greater than zero' }
  if (amountUsd > OWNER_CAPITAL_MAX_USD) {
    return { error: `amount $${amountUsd.toLocaleString('en-US')} is above the $${OWNER_CAPITAL_MAX_USD.toLocaleString('en-US')} limit` }
  }
  return { amountUsd }
}

// What to put in to bring the balance up to the target. Zero when it is
// already there: a contribution is never negative.
export function suggestedContributionUsd(balanceUsd, targetUsd = TARGET_BALANCE_USD) {
  return Math.max(0, targetUsd - balanceUsd)
}

// True when the last owner-capital row is newer than the window. Both times
// come from the database (occurred_at, now()) so the two clocks agree.
export function isRecentDuplicate(lastAt, now, windowMinutes = DUPLICATE_WINDOW_MINUTES) {
  if (!lastAt) return false
  return new Date(now).getTime() - new Date(lastAt).getTime() < windowMinutes * MS_PER_MINUTE
}

export function parseOwnerCapitalArgs(argv) {
  let confirm = false
  let forceDuplicate = false
  let allowRemote = false
  const positional = []
  for (const arg of argv) {
    if (arg === FLAG_CONFIRM) confirm = true
    else if (arg === FLAG_ALLOW_REMOTE) allowRemote = true
    else if (arg === FLAG_FORCE_DUPLICATE) forceDuplicate = true
    else if (arg === FLAG_COMPANY || arg.startsWith(`${FLAG_COMPANY}=`)) {
      return { error: 'there is one company and one ledger; --company does not exist' }
    } else if (arg.startsWith('--')) return { error: `unknown option ${arg}` }
    else positional.push(arg)
  }
  if (positional.length > 1) return { error: `expected one amount, got ${positional.length}` }
  const amount = validateAmount(positional[0])
  if (amount.error) return { error: amount.error }
  return { amountUsd: amount.amountUsd, confirm, allowRemote, forceDuplicate }
}
