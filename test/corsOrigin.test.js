// Which origins the API answers, and which it refuses.
//
// This exists because of a bug that cost an hour and pointed at the wrong
// thing: Vite took port 5174 when 5173 was busy, the hardcoded CORS origin
// refused every request from it, the browser hid the refusal (that is what
// a CORS refusal IS), and the login page said "Cannot reach the server. Is
// the API running?" -- while /health answered fine. The message named a
// cause that was not the cause.
//
// The regex is tested rather than the middleware: cors() is a dependency,
// the decision is ours. Each test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// Read the pattern out of app.js rather than restating it -- a copy here
// would pass while the shipped one drifted.
function localhostPattern() {
  const src = readFileSync(join(here, '../src/app.js'), 'utf8')
  const m = src.match(/const LOCALHOST_ORIGIN = (\/.*\/)\n/)
  assert.ok(m, 'expected LOCALHOST_ORIGIN in app.js')
  // eslint-disable-next-line no-eval
  return eval(m[1])
}

test('any localhost port is allowed in development', () => {
  const re = localhostPattern()
  // Kills: the pattern pinned to one port again -- the bug itself.
  for (const origin of [
    'http://localhost:5173', 'http://localhost:5174', 'http://localhost:4173',
    'http://127.0.0.1:5173', 'http://localhost',
  ]) {
    assert.ok(re.test(origin), `${origin} should be allowed in dev`)
  }
})

test('a host that merely contains "localhost" is refused', () => {
  const re = localhostPattern()
  // Kills: an unanchored pattern, or one built with .includes() -- the
  // classic way a dev convenience becomes a hole. `localhost.evil.com`
  // resolves wherever its owner points it.
  for (const origin of [
    'http://localhost.evil.com', 'http://evil.com:5173', 'https://evil.com',
    'http://notlocalhost', 'http://localhost@evil.com', 'http://evil.com/localhost',
  ]) {
    assert.ok(!re.test(origin), `${origin} must be refused`)
  }
})

test('production does not use the localhost pattern at all', () => {
  const src = readFileSync(join(here, '../src/app.js'), 'utf8')
  // Kills: the widened origin leaking into production, where an attacker
  // is not on the developer's own machine and localhost means nothing.
  assert.match(src, /config\.isProd[\s\S]{0,80}config\.corsOrigin/,
    'production must take config.corsOrigin, not the pattern')
})
