// One writing style per broker, for good. The same broker writing "u" on one
// load and a full formal sentence on the next reads as a machine, so the style
// comes from the broker's id and nothing else (hash01, like the ceiling).
import { hash01 } from '../../lib/stableHash.js'

export const BROKER_STYLES = Object.freeze(['casual', 'neutral', 'formal'])
const STYLE_HASH_SALT = 'writing-style'

export function brokerStyle(brokerId) {
  return BROKER_STYLES[Math.floor(hash01(`${STYLE_HASH_SALT}:${brokerId}`) * BROKER_STYLES.length)]
}

// Prompt text for each style. Figures, cities and times stay exact in all three.
export const STYLE_INSTRUCTION = Object.freeze({
  casual: 'YOUR WRITING STYLE (casual): short, quick sentences, sometimes all lowercase, shorthand like "u", "r", "thx", "lmk" and "rn" now and then. Numbers, cities and times stay exact and complete.',
  neutral: 'YOUR WRITING STYLE (neutral): plain, direct desk English in short sentences, contractions, no slang and no ceremony.',
  formal: 'YOUR WRITING STYLE (formal): complete, courteous sentences with proper capitalization and punctuation. No shorthand or slang.',
})

// Same broker, same conversation, same turn: same wording. A new turn picks anew.
export const voiceKey = ({ brokerId, conversationId, revision }) => `${brokerId}:${conversationId}:${revision}`

export const pickVariant = (list, key) => list[Math.floor(hash01(key) * list.length)]
