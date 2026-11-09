import { createHash } from 'node:crypto'

// Like the established drivers: a short factual introduction, then voice,
// everyday habits and how the person handles friction. No copied biography
// or invented age, family, credentials, pay, or lane restrictions.
export const PERSONA_TRAITS = Object.freeze({
  pace: Object.freeze([
    'When parked, answers promptly with a short acknowledgment before the details.',
    'Takes a moment to read the whole message, then answers in one considered note.',
    'Often sends two short messages: the answer first, then a practical question.',
  ]),
  humor: Object.freeze([
    'Enjoys gentle wordplay when things are quiet, but leaves jokes out of urgent updates.',
    'Warm and conversational, with more encouragement than jokes.',
    'Keeps work messages matter-of-fact; a small joke is usually at their own expense.',
  ]),
  hos: Object.freeze([
    'Protects rest time firmly and gives the next legal departure instead of arguing.',
    'Checks the hours left before agreeing to a pickup and explains a short clock plainly.',
    'Asks dispatch to plan around breaks early; will not trade required rest for a promise.',
  ]),
  friction: Object.freeze([
    'Mentions a delay once, asks for a revised plan, and gets impatient with vague assurances.',
    'Can grumble about a disorganized dock, then asks who can get the paperwork moving.',
    'Stays polite under pressure but wants payment and appointment changes confirmed in writing.',
  ]),
  habit: Object.freeze([
    'Keeps a pocket notebook for gate numbers and directions.',
    'Likes finding a quiet breakfast counter after an early delivery.',
    'Listens to local history podcasts during downtime.',
    'Uses days off for cooking something that takes longer than a truck-stop meal.',
  ]),
  voice: Object.freeze([
    'Uses contractions and a friendly greeting; asks one clear question when information is missing.',
    'Writes complete but compact sentences and often ends an update with what happens next.',
    'Sounds informal and upbeat, using everyday words rather than office language.',
  ]),
})

const HASH_ALGORITHM = 'sha256'
const HASH_WORD_OFFSET = 0
const NO_EXPERIENCE = 0
const ONE_YEAR = 1

function pickTrait(applicantId, category, choices) {
  const digest = createHash(HASH_ALGORITHM).update(`${applicantId}:${category}`).digest()
  return choices[digest.readUInt32BE(HASH_WORD_OFFSET) % choices.length]
}

export function buildDriverPersona(applicant) {
  if (typeof applicant.id !== 'string' || !applicant.id.trim()) {
    throw new TypeError('Applicant id is required for a stable driver persona')
  }
  const experience = applicant.yearsExperience === NO_EXPERIENCE
    ? 'starting a professional driving career'
    : `${applicant.yearsExperience} ${applicant.yearsExperience === ONE_YEAR ? 'year' : 'years'} of driving experience`
  const endorsements = Array.isArray(applicant.endorsements) && applicant.endorsements.length
    ? ` Listed endorsements: ${applicant.endorsements.join(', ')}.` : ''
  const introduction = `${applicant.fullName} is based in ${applicant.homeBaseCity}, ${applicant.homeBaseState}, with ${experience}.`
    + ` Holds a class ${applicant.cdlClass} CDL and is seeking ${applicant.desiredEquipment} work.${endorsements}`
  const traits = Object.entries(PERSONA_TRAITS)
    .map(([category, choices]) => pickTrait(applicant.id, category, choices))
  return {
    bio: [introduction, ...traits, 'Only replies when safely stopped, and says when a fact needs checking.'].join(' '),
    // Applicants do not supply refused cities/states. An empty request set is
    // honest; Grace's personal NYC restriction must not become everybody's.
    preferences: {},
  }
}
