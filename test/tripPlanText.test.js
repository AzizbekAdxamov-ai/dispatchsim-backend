// What the Trip plan says, as a person reads it (2026-10-08, load 600010):
// durations, not "1175939 minutes"; company-clock times, not UTC ISO; no
// server command. Each test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dutyDuration } from '../src/constants/hosClock.js'

const here = dirname(fileURLToPath(import.meta.url))
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8')

// Kills: days dropped (19598h) or minutes shown past a day.
test('a duty duration reads in days, hours or minutes', () => {
  assert.equal(dutyDuration(1175939), '816d 14h')
  assert.equal(dutyDuration(605), '10h 05m')
  assert.equal(dutyDuration(45), '45m')
})

// Kills: a limit fact going back to raw minutes.
test('every HOS limit fact states its time through dutyDuration', () => {
  const src = read('src', 'constants', 'hosClock.js')
  assert.doesNotMatch(src, /detail: `[^`]*(minutes used since coming on duty|allowed on-duty minutes|allowed driving minutes)/)
  assert.equal((src.match(/detail: `\$\{(DUTY_WINDOW_HOURS\}-hour duty window elapsed; \$\{)?dutyDuration\(/g) ?? []).length, 5)
})

// Kills: an ISO time or a server command written into a fact again.
test('plan facts carry company-clock times and no server command', () => {
  const plan = read('src', 'modules', 'facilities', 'stopPlan.js')
  const replan = read('src', 'modules', 'hos', 'replan.service.js')
  const dispatch = read('src', 'modules', 'loads', 'dispatch.service.js')
  assert.match(plan, /The HOS-legal arrival \(\$\{clockDateTime\(legalArrivalAt\)\} CT\)/)
  assert.match(replan, /the HOS-legal arrival is \$\{clockDateTime\(plan\.legalArrivalAt\)\} CT\./)
  assert.doesNotMatch(dispatch, /detail: `[^`]*npm run/)
  assert.doesNotMatch(dispatch, /`[^`\n]*simulated days[^`\n]*`/)
})
