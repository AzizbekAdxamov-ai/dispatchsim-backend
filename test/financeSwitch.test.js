// The money model's one switch: FINANCE.
//
// This exists because a session left open collects interest and insurance
// for every simulated day it stayed open. One overnight run finished at
// -$208,266, which made the company insolvent, and an insolvent company is
// refused every new load, hire and truck -- so the money model had quietly
// become a wall across the rest of the app while it is being built.
//
// FINANCE=off removes three things and nothing else: the two recurring
// charges, and every refusal that comes from the balance. The ledger is not
// touched, no row is deleted, and switching it back on resumes against the
// account as it stands.
//
// Every test below names the mutation it kills. None of them needs a
// database: the whole point of the switch is that with it off, no query is
// made at all, and that is exactly what is asserted.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chargeInterest, chargeInsurance } from '../src/modules/loads/dispatch.service.js'
import { assertCanSpend, assertCanCommit } from '../src/modules/cash/cash.service.js'
import { cashAlert } from '../src/modules/alerts/alerts.service.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// config.js is read in a child process, because it is evaluated once at
// import and reads process.env then. Hermetic on purpose: DOTENV_CONFIG_PATH
// points at a file that does not exist, so the developer's own .env cannot
// decide the outcome of a test about defaults.
function financeEnabledWith(value) {
  const env = { ...process.env }
  delete env.FINANCE
  if (value !== undefined) env.FINANCE = value
  env.DOTENV_CONFIG_PATH = join(root, '.env.does-not-exist')
  env.DATABASE_URL = 'postgresql://u:p@localhost:5432/x'
  env.JWT_SECRET = 'x'.repeat(48)
  delete env.DEFAULT_ROLE
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', "import c from './src/config.js'; process.stdout.write(String(c.financeEnabled))"],
    { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return out.trim()
}

// Kills: flipping the default to off. The money model is the product; a
// deployment that says nothing gets it.
test('FINANCE unset means the money model is on', () => {
  assert.equal(financeEnabledWith(undefined), 'true')
  assert.equal(financeEnabledWith(''), 'true')
})

// Kills: ignoring the variable altogether (the switch that does nothing).
test("FINANCE=off turns the money model off", () => {
  assert.equal(financeEnabledWith('off'), 'false')
  assert.equal(financeEnabledWith('on'), 'true')
})

// Kills: dropping .trim() or .toLowerCase(). A value typed into a .env
// arrives with whatever case and spacing the person used, and 'OFF ' that
// silently means on is the worst of both readings.
test('FINANCE is read case- and whitespace-insensitively', () => {
  assert.equal(financeEnabledWith(' OFF '), 'false')
  assert.equal(financeEnabledWith('On'), 'true')
})

// Kills: `financeEnabled = process.env.FINANCE !== 'off'` and its mirror
// `=== 'on'`. Either one turns a typo into a silent decision -- FINANCE=of
// would leave interest running while the operator believed it stopped, or
// disable the entire money model on FINANCE=yes. It is a startup error.
test('a FINANCE value that is neither on nor off refuses to start', () => {
  let err = null
  try {
    financeEnabledWith('of')
  } catch (e) {
    err = e
  }
  assert.ok(err, 'expected the process to exit non-zero')
  assert.equal(err.status, 1)
  assert.match(err.stderr, /FINANCE must be 'on' or 'off'/)
  assert.match(err.stderr, /got: of/)
})

// A transaction runner that fails the test if the code ever opens one.
// Stronger than checking the return value: the assertion is that the
// database is not consulted, which holds on a machine with a database
// behind it exactly as it does on one without.
function neverRuns(label) {
  return () => {
    throw new Error(`${label} opened a transaction with the money model off`)
  }
}

// Kills: removing the guard in chargeInterest.
test('interest does not accrue, and no transaction is opened, with finance off', async () => {
  assert.equal(await chargeInterest({ enabled: false, run: neverRuns('chargeInterest') }), null)
})

// Kills: removing the guard in chargeInsurance. Separate from interest
// because they were separate bugs once already: the insurance premium was
// charged for two months while only interest reached the log.
test('the insurance premium does not accrue, and no transaction is opened, with finance off', async () => {
  assert.equal(await chargeInsurance({ enabled: false, run: neverRuns('chargeInsurance') }), null)
})

// A client that fails the test if any SQL is sent through it.
const neverQueries = {
  query() {
    throw new Error('the balance was read with the money model off')
  },
}

// Kills: removing the guard in assertCanSpend, and also the weaker version
// that reads the balance first and then decides to ignore it. The amount
// here is far past the $50,000 credit line, so a guard placed after the
// read would still throw INSUFFICIENT_FUNDS.
test('a spend past the credit line is not refused with finance off', async () => {
  assert.equal(await assertCanSpend(neverQueries, 900000, { enabled: false }), null)
})

// Kills: removing the guard in assertCanCommit. This is the one that had
// become a wall: booking a load, hiring a driver and buying a truck all go
// through it, and all three were refused by an insolvent company.
test('booking, hiring and buying are not refused with finance off', async () => {
  assert.equal(await assertCanCommit(neverQueries, 'booking a load', { enabled: false }), null)
})

// Kills: leaving the alert board out of the switch. A board that says
// "insolvent" while nothing is accruing and nothing is being refused is
// reporting a consequence that is not coming.
test('no cash alert is raised with finance off', () => {
  const insolvent = { state: 'insolvent', assetsUsd: 1, liabilitiesUsd: 2, netWorthUsd: -1, balanceUsd: -208266, receivablesUsd: 0, fleetValueUsd: 0, unpaidWagesUsd: 0 }
  assert.equal(cashAlert({ standing: insolvent, balanceUsd: -208266, enabled: false }), null)
})

// The other half of the same switch: with finance ON the board must still
// say all three things. Kills: `return null` unconditionally, which would
// make the test above pass while the money model was silently muted.
test('with finance on, each of the three states still raises its own alert', () => {
  const enabled = true
  const standing = (state) => ({
    state, assetsUsd: 10, liabilitiesUsd: 20, netWorthUsd: -10,
    balanceUsd: -60000, creditLimitUsd: 50000, overLimitUsd: 10000,
    receivablesUsd: 0, fleetValueUsd: 0, unpaidWagesUsd: 0,
  })
  assert.equal(cashAlert({ standing: standing('insolvent'), balanceUsd: -60000, enabled }).family, 'cash.insolvent')
  assert.equal(cashAlert({ standing: standing('over_limit'), balanceUsd: -60000, enabled }).family, 'cash.limit-reached')
  assert.equal(cashAlert({ standing: standing('ok'), balanceUsd: -1, enabled }).family, 'cash.negative')
  assert.equal(cashAlert({ standing: standing('ok'), balanceUsd: 0, enabled }), null)
})
