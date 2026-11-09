import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDriverPersona } from '../src/modules/hr/driverPersona.js'

const APPLICANT = Object.freeze({
  id: 'a910001', fullName: 'Morgan Rivera', homeBaseCity: 'Dallas', homeBaseState: 'TX',
  yearsExperience: 7, cdlClass: 'A', desiredEquipment: 'reefer', endorsements: ['N'],
})
const MIN_BIO_WORDS = 70
const MAX_BIO_WORDS = 200

test('persona contains applicant facts and a substantial conversational voice', () => {
  // Kills: empty bio or omission of the applicant introduction.
  const { bio, preferences } = buildDriverPersona(APPLICANT)
  const words = bio.split(/\s+/).length
  assert.ok(words >= MIN_BIO_WORDS && words <= MAX_BIO_WORDS)
  for (const fact of ['Morgan Rivera', 'Dallas, TX', '7 years', 'class A', 'reefer', 'N']) {
    assert.ok(bio.includes(fact), fact)
  }
  assert.deepEqual(preferences, {}, 'no applicant lane restrictions were supplied')
})

test('the same applicant has the same persona on repeated calls', () => {
  // Kills: adding randomness or a changing counter to the bio.
  const first = buildDriverPersona(APPLICANT)
  assert.deepEqual(buildDriverPersona({ ...APPLICANT }), first)
})

test('different applicant IDs change the voice even with identical factual fields', () => {
  // Kills: ignoring the applicant id when selecting personality traits.
  const first = buildDriverPersona(APPLICANT)
  const second = buildDriverPersona({ ...APPLICANT, id: 'a910002' })
  assert.notEqual(first.bio, second.bio)
})

test('persona does not reuse Grace or Ethan biography or signature habits', () => {
  // Kills: replacing generated content with either established driver biography.
  const { bio } = buildDriverPersona(APPLICANT)
  for (const copied of ['Grace', 'Ethan', 'Mid-forties, twelve years', 'native English speaker from the American Midwest',
    'copy that', 'the box', 'fixing old radios', 'baseball']) assert.ok(!bio.includes(copied), copied)
})

test('new applicants are not assigned invented experience or undefined endorsements', () => {
  // Kills: substituting a default veteran history for zero experience.
  const { bio } = buildDriverPersona({ ...APPLICANT, yearsExperience: 0, endorsements: [] })
  assert.match(bio, /starting a professional driving career/)
  assert.doesNotMatch(bio, /undefined|Listed endorsements|7 years/)
})

test('a stable applicant identifier is required', () => {
  // Kills: silently sharing one default seed among applicants without ids.
  assert.throws(() => buildDriverPersona({ ...APPLICANT, id: '' }), /Applicant id/)
})
