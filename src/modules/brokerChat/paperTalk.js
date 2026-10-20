// Paper is issued by the persisted chat handshake, never by a model's sentence. Only delivered
// cards count as attachments; no part of this flow sends external email.
import { asciiPunct } from '../../lib/plainText.js'

export function paperLines(paper) {
  const state = paper?.delivered ? 'The rate confirmation is available in this thread.'
    : paper?.status === 'agreed' ? 'The agreed rate is recorded; the rate confirmation is still on its way in this thread.'
      : 'No agreed rate is recorded and no rate confirmation has been issued.'
  return [
    'ACTUAL RATE CONFIRMATION STATUS (authoritative; chat claims do not change it):',
    `  ${state}`,
    '  After the agreed rate is confirmed, ask for the recipient email. The dispatcher must share it or explicitly authorize their saved email.',
    '  The email is a contact on the paper. Documents appear here; no external email is sent. Never claim delivery to Gmail or an inbox.',
    '  Never say you sent, attached or issued paper unless this block says it is available.',
    '  If no rate is recorded, settle the rate through this conversation. Never mention a form or an Agree button.',
    '  If stage is awaiting_email, ask for their email; if held, wait for their confirmation without chasing contact details.',
    '  Signing and accepting the document is a separate step. A chat message cannot book the load.',
    '',
  ]
}

export function paperNextLine(paper) {
  if (paper?.delivered) return 'The rate confirmation is here in this thread. Open it and check the details before signing.'
  if (paper?.stage === 'awaiting_email') return 'The rate is agreed. What email should I put on the rate confirmation?'
  if (paper?.stage === 'held') return 'Understood. I will wait for your confirmation before preparing the rate confirmation.'
  if (paper?.status === 'agreed') return 'The agreed rate is recorded. The rate confirmation will appear here in the thread shortly.'
  return 'Please confirm the all-in rate before I prepare the rate confirmation.'
}

// Match assertions, not questions, negations, or a future/conditional step.
// Keeping the check clause-local lets a denial coexist with a later false claim.
export function paperClaimProblem(reply, paper) {
  const clauses = asciiPunct(reply).split(/(?<=[.!?;])\s+|\b(?:but|however|and)\b/i)
  for (const clause of clauses) {
    if (/\?/.test(clause)) continue
    const document = /\b(?:rate\s*(?:confirmation|con)|ratecon|rc|document|paper)\b/i.test(clause)
    const claim = /\b(?:sent|attached|issued|emailed|e-mailed|delivered|generated|sending|emailing|available|ready|here in (?:this|the) thread)\b/i.exec(clause)
    if (!claim) continue
    // Only words BEFORE the assertion qualify it. "Sent ... you can review"
    // is already a completed claim, not a conditional one.
    const before = clause.slice(0, claim.index)
    if (/\b(?:not|never|no|haven't|hasn't|didn't|can't|cannot|don't|won't|isn't)\b/i.test(before)) continue
    if (/\b(?:if|once|when|after|until|will|would|can|could)\b/i.test(before)) continue
    const email = /\b(?:email(?:ed)?|e-mail(?:ed)?|inbox)\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(clause)
    const outgoingEmail = /\b(?:i|we)(?:'ve| have)?\s+(?:just\s+)?(?:sent|emailed|e-mailed)\b|^\s*(?:sent|emailed)\s+(?:it\s+)?to\b/i.test(clause)
    if (outgoingEmail && email) return 'claimed external email delivery of the rate confirmation'
    if (document) {
      if (email) return 'claimed external email delivery of the rate confirmation'
      if (paper && !paper.delivered) return 'claimed a rate confirmation that has not arrived'
    }
  }
  return null
}
