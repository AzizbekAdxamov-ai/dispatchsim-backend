import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeProgress } from '../src/modules/academy/academy.service.js'
import { LESSON_EXITS, ACADEMY_LESSON_COUNT } from '../src/constants/academyLessons.js'

test('every lesson has exactly 7 distinct EXIT keys', () => {
  for (let no = 1; no <= ACADEMY_LESSON_COUNT; no++) {
    assert.equal(LESSON_EXITS[no].length, 7, `lesson ${no}`)
    assert.equal(new Set(LESSON_EXITS[no]).size, 7, `lesson ${no} duplicates`)
  }
})

test('foreign and false EXIT keys are dropped', () => {
  const r = normalizeProgress(1, { exitsDone: { story: true, roles: false, nope: true, sim: true } })
  assert.deepEqual(r.exitsDone, { story: true })
})

test('quiz keeps allowed keys within their maximum and drops null', () => {
  const r = normalizeProgress(1, { exitsDone: {}, quiz: { qz: 8, sim: 5, exa: 3 } })
  assert.deepEqual(r.quiz, { qz: 8 })
  assert.deepEqual(normalizeProgress(1, { exitsDone: {}, quiz: { qz: 9 } }).quiz, {})
  assert.deepEqual(normalizeProgress(1, { exitsDone: {}, quiz: { qz: null } }).quiz, {})
})

test('lesson 12 accepts sim, exa and exb counters', () => {
  const r = normalizeProgress(12, { exitsDone: {}, quiz: { qz: 1, sim: 12, exa: 10, exb: 11 } })
  assert.deepEqual(r.quiz, { qz: 1, sim: 12, exa: 10 })
})

test('mode is passed through, absent mode stays null', () => {
  assert.equal(normalizeProgress(1, { exitsDone: {}, mode: 'teach' }).mode, 'teach')
  assert.equal(normalizeProgress(1, { exitsDone: {} }).mode, null)
})
