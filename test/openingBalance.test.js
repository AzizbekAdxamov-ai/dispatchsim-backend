// The opening balance is written in two languages, and they must agree.
//
// src/constants/simClock.js holds it for the app. A migration cannot
// import that file -- SQL has no access to JavaScript -- so the number
// also appears in SQL, and two copies of one number are two numbers that
// disagree the first time somebody changes one of them.
//
// That nearly happened on 2026-09-14: OPENING_BALANCE_USD moved from
// 200000 to 250000 and migration 021 still said 200000, so a fresh
// database would have opened at a different figure than a reset one.
//
// This test does not ask the two to be equal by magic. It asks that the
// LAST migration which sets an opening balance sets the same number the
// constant holds.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { OPENING_BALANCE_USD, CREDIT_LIMIT_USD } from '../src/constants/simClock.js'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', 'src', 'db', 'migrations')

// Every migration that writes an opening-balance amount, in order.
function openingBalanceMigrations() {
  const found = []
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    // Comments stripped: these files explain their own history, and the
    // old figure appears in that prose on purpose.
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    if (!/cash_ledger/i.test(code) || !/opening/i.test(code)) continue
    const amounts = [...code.matchAll(/\b(\d{5,9})\b/g)].map((m) => Number(m[1]))
    if (amounts.length > 0) found.push({ file, amounts })
  }
  return found
}

test('the last migration to set an opening balance matches the constant', () => {
  const migrations = openingBalanceMigrations()
  assert.ok(migrations.length > 0, 'ochilish balansini yozadigan migratsiya topilmadi')

  const last = migrations[migrations.length - 1]
  assert.ok(last.amounts.includes(OPENING_BALANCE_USD),
    `${last.file} ${last.amounts.join(', ')} yozadi, konstanta esa ${OPENING_BALANCE_USD}`)
})

test('reset writes the constant, not a number of its own', () => {
  // A reset that spelled the figure out again would be a third copy.
  const reset = readFileSync(join(here, '..', 'scripts', 'reset-company.js'), 'utf8')
  assert.match(reset, /OPENING_BALANCE_USD/, 'reset konstantani ishlatmayapti')
  const code = reset.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.doesNotMatch(code, new RegExp(`\\b${OPENING_BALANCE_USD}\\b`),
    'reset ichida qo\'lda yozilgan summa bor')
})

test('the opening balance leaves room for the credit line to matter', () => {
  // Not a style check. The whole cash model -- interest, the over-limit
  // margin, the insolvency test -- only teaches anything if the student
  // can reach the line. An opening balance far larger than the facility
  // makes every one of those rules unreachable in a session.
  assert.ok(OPENING_BALANCE_USD > CREDIT_LIMIT_USD,
    'ochilish balansi kredit liniyasidan katta bo\'lishi kerak')
  assert.ok(OPENING_BALANCE_USD <= CREDIT_LIMIT_USD * 10,
    `ochilish balansi kredit liniyasidan ${Math.round(OPENING_BALANCE_USD / CREDIT_LIMIT_USD)}x katta — `
    + 'kredit qoidalari talaba uchun yetib bo\'lmas bo\'lib qoladi')
})
