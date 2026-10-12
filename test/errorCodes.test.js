// Every error code the source can throw is one the catalog knows.
//
// AppError looks its code up in ERROR_CODES and THROWS if it is not there
// ("Unknown AppError code: ..."). So a code missing from the catalog does
// not produce a worse message -- it produces a different error entirely,
// a 500, in place of the 409 the code was written to send.
//
// That is not hypothetical. truckListings.repository.js has returned
// { error: 'TRUCK_NOT_IDLE' } since the truck market was written, and the
// service wraps it in new AppError(result.error). TRUCK_NOT_IDLE was
// never added to the catalog: assigning a driver to a truck in the shop
// crashed with a stack trace, while AssignDriverPanel.jsx sat there with
// a friendly sentence ready for a code the server could never send.
//
// Found on 2026-09-30 by reading, not by a test -- the fix is this test,
// so the next missing code is found by `npm test` instead.
//
// It reads source text, the way companyTables.test.js reads the WIPE
// lists: a code built at runtime would slip past it, but every code in
// this project is a string literal, and the assertion on the count below
// is what notices if that ever stops being true.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ERROR_CODES } from '../src/lib/errors.js'

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

function jsFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...jsFiles(full))
    else if (name.endsWith('.js')) out.push(full)
  }
  return out
}

// Two shapes a code is thrown in:
//   new AppError('CODE' ...)          -- directly
//   return { error: 'CODE' }          -- a repository answering, and a
//                                        service wrapping it later
const THROWN = [/new AppError\(\s*'([A-Z][A-Z0-9_]+)'/g, /\berror:\s*'([A-Z][A-Z0-9_]+)'/g]

function codesInSource() {
  const found = new Map()
  for (const file of jsFiles(srcDir)) {
    if (file.endsWith(join('lib', 'errors.js'))) continue
    const text = readFileSync(file, 'utf8')
    for (const re of THROWN) {
      for (const m of text.matchAll(re)) {
        if (!found.has(m[1])) found.set(m[1], file.slice(srcDir.length + 1))
      }
    }
  }
  return found
}

// Kills: removing any code from ERROR_CODES that the source still throws
// -- TRUCK_NOT_IDLE first of all.
test('every error code thrown in src/ is in the catalog', () => {
  const found = codesInSource()
  assert.ok(found.size >= 30, `manbada faqat ${found.size} ta xato kodi topildi -- regex eskirgan bo'lishi mumkin`)

  const missing = [...found].filter(([code]) => !ERROR_CODES[code]).map(([code, file]) => `${code} (${file})`)
  assert.deepEqual(missing, [], `katalogda yo'q xato kodlari -- har biri 500 bo'lib chiqadi: ${missing.join(', ')}`)
})

// Kills: the fix itself going missing. Named on its own because it is
// the one that was found broken.
test('TRUCK_NOT_IDLE is a 409 with a sentence, not a crash', () => {
  assert.equal(ERROR_CODES.TRUCK_NOT_IDLE?.status, 409)
  assert.match(ERROR_CODES.TRUCK_NOT_IDLE.message, /not idle/)
})
