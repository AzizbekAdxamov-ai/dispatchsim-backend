import { asciiPunct } from '../../lib/plainText.js'
import { claimClauses } from '../../lib/claimClauses.js'

export const ONE_CARRIER_RULE = 'This load moves with one carrier of record, the carrier named on the rate confirmation. Refuse proposals to rebroker it or hand it to another carrier; do not collect another carrier’s details or advance booking for that proposal.'
export const ONE_CARRIER_REPLY = 'No rebrokering on this load. It must move with the carrier named on the rate confirmation.'
export const AGREES_REBROKER = /\b(?:sure|yes|yeah|yep|go ahead|no problem)\b[^.!?;]{0,65}\b(?:rebrok\w*|double.?brok\w*|co.?brok\w*|on (?:my|ur) (?:own )?mc)\b/i
const TOPIC = /\b(?:re[- ]?brok\w*|double[- ]?brok\w*|co[- ]?brok\w*|resell|flip)\b/i
const HANDOFF = /\b(?:hand|give|pass|send|ship|put|place|move|haul|run|use|book|assign|subcontract)\w*\b[^.!?;]{0,65}\b(?:another|other|second|different|someone else'?s?)\s+(?:carrier|mc|authority|truck)\b/i
const DENIES = /\b(?:no(?! problem| matter)|not|never|nothing|don'?t|do not|won'?t|will not|can'?t|cannot|isn'?t|is not|aren'?t|are not|refuse|prohibit\w*)\b/i
const clauses = claimClauses

// Only an active proposal blocks booking. Quoted examples, questions about
// the meaning of the term, and a carrier refusing the practice do not.
export function proposesRebroker(value) {
  return clauses(value).some((clause) => {
    const plain = clause.replace(/"[^"\n]*"/g, '')
    if (!TOPIC.test(plain) && !HANDOFF.test(plain)) return false
    if (/\b(?:what (?:is|does)|define|meaning of)\b/i.test(plain)) return false
    const verb = TOPIC.exec(plain) ?? HANDOFF.exec(plain)
    // A truck denial earlier in the sentence is not a denial of the
    // handoff verb ("no truck so I will rebroker"). Bind to this action.
    if (/\b(?:don'?t|do not|won'?t|will not|can'?t|cannot|never|not)\s+(?:(?:want|intend|plan|agree|allow|propose|going)\s+to\s+|interested in\s+|do\s+)?(?:ever\s+)?$/i.test(plain.slice(0, verb.index))) return false
    return /\b(?:i|we|my|our|can|could|will|would|let'?s|another|other|resell|flip|hand)\b/i.test(plain)
  })
}

export function agreesRebroker(value) {
  return clauses(value).some((clause) => {
    if (!clause.trim() || clause.trim().endsWith('?')) return false
    // "your MC" alone is the caller's own MC being confirmed (live #229:
    // "Yep, your MC is good" read as agreeing to rebroker); only "own MC" /
    // "other MC" names a different authority, hence {1,2} and not {0,2}.
    const relay = /\b(?:okay|ok|fine|sure|yeah|yep|go ahead|up to you)\b[^.!?;]{0,35}\b(?:my|your|their)\s+(?:(?:own|other)\s+){1,2}mc\b|\bno matter who\s+[a-z]+|\bwhoever\s+[a-z]+\b[^.!?;]{0,30}\b(?:fine|ok(?:ay)?|good|works)\b|\b(?:put|place|send|ship|stick)\w*\s+(?:it|this|that)\s+(?:on|under|with)\s+(?:my|your|their|his|her|another|any)\s*(?:(?:other|own)\s+)?(?:mc|authority|carrier)\b|\b(?:my|your|their)\s+(?:(?:other|own)\s+){1,2}mc\b[^.!?;]{0,35}\b(?:ok(?:ay)?|fine|good|works)\b/i.test(clause)
    if (!/^\s*(?:go ahead (?:and )?)?(?:rebroker|double[- ]?broker)\b/i.test(clause) && !AGREES_REBROKER.test(clause) && !relay && !(HANDOFF.test(clause) && /\b(?:sure|yes|fine|okay|go ahead)\b/i.test(clause))) return false
    // Scope denial to this clause, never let an earlier refusal hide a
    // later permission. "No problem" is permission, not a refusal.
    return !DENIES.test(clause)
  })
}

export function refusesRebroker(value) {
  return !agreesRebroker(value) && clauses(value).some((clause) => {
    const one = /\b(?:one|single) carrier(?: of record| only)?\b/i.exec(clause)
    const positiveOne = one && !/\b(?:not|no|isn'?t|aren'?t|more than)(?: just)?\s*$/i.test(clause.slice(0, one.index))
      && !/^\s*(?:is |are )?not\b/i.test(clause.slice(one.index + one[0].length))
    return positiveOne || (TOPIC.test(clause) && /\b(?:no\s+re[- ]?brok|not\s+re[- ]?brok|don'?t\s+re[- ]?brok|do not\s+re[- ]?brok|won'?t\s+re[- ]?brok|cannot\s+re[- ]?brok|refuse|prohibit\w*)\b/i.test(clause))
  })
}
