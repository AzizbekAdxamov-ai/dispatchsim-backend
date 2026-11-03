import { claimClauses } from '../../lib/claimClauses.js'
// What a reply says about the broker's accessorial terms, checked against
// the terms themselves (src/constants/accessorials.js).
//
// Lumper: the broker pays it against a receipt. A broker who says the
// shipper, the receiver or the carrier pays has quoted a term nobody wrote
// (Saturday 2026-10-17 morning: "The shipper will cover any lumper fees
// with a receipt"). A pattern, not a parser: it reads one sentence at a
// time and trusts a "we" / "broker" / "reimburse" in it to mean the
// broker is the payer.

import { asciiPunct } from '../../lib/plainText.js'

export const NO_STOP_PAY_LINE = 'There is no separate stop-pay term on this load; the listed stops and appointments stay as posted.'
export function stopPayInvented(reply) {
  return claimClauses(reply).some((clause) => {
    if (clause.trim().endsWith('?')) return false
    if (!/\bstop[- ]?(?:pay|fee|charge|rate)|\bper (?:extra )?stop\b|\b(?:pay|cover|offer)\b[^.!?;]{0,35}\bstops?\b/i.test(clause)) return false
    const assertion = clause.split(/\$\s*\d/)[0]
    if (/\b(?:no(?!t? (?:a )?problem)|not(?! (?:a )?problem)|don'?t|do not|can'?t|cannot|won'?t|will not|unapproved|not agreed)\b/i.test(assertion)) return false
    if (/\byou (?:asked|requested|want)|\byour (?:request|ask)/i.test(clause)
      && !/\b(?:we|i)\s+(?:can |will |do )?(?:pay|offer|cover|agree)|\b(?:works|approved|agreed|confirmed)\b/i.test(clause)) return false
    return /\$\s*\d|\b\d+(?:\.\d+)?\s*(?:dollars?|per stop)|\b(?:we|i)\s+(?:can |will |do )?(?:pay|offer|cover)|\bstop[- ]?pay\s+(?:is|will be|at)\b/i.test(clause)
  })
}

const OTHER_PAYS = /\b(shipper|receiver|consignee|you|your driver|carrier)\b[^.!?]{0,30}\b(pay|pays|cover|covers|handles?|is on)\b|\b(paid|covered) by (the )?(shipper|receiver|consignee|you|carrier)\b/i
const BROKER_PAYS = /\b(we|us|our|I|I'll|I'd|me|broker|reimburs\w*|repay\w*|pay you back)\b/i

export function lumperPayerWrong(reply) {
  return asciiPunct(String(reply ?? ''))
    .split(/(?<=[.!?])\s+/)
    .some((sentence) => /lumper/i.test(sentence) && OTHER_PAYS.test(sentence) && !BROKER_PAYS.test(sentence))
}

// -- Payment terms ------------------------------------------------------------

// Payment days or a quick-pay fee: the broker has no such terms (that is
// accounting's), so naming any is invented. (Moved here from
// scripts/scenarioChecks.js, which re-exports it.)
export const PAYMENT_INVENTED_RE = /\bnet ?\d{1,2}\b|\b\d{1,2} days? (to pay|pay)\b|quick ?pay[^.?!]{0,30}\d+(\.\d+)?\s?%/i

// What the broker says when payment terms come up and it has none to give.
export const PAYMENT_TERMS_LINE = "Payment terms are on accounting's side — they'll be on the rate con."

// The live check is stricter than the script's paymentInvented (which looks
// for invented figures only): ANY talk of payment terms must be a deferral.
// "We do quick pay" names a term as much as "net 30" does (EB15,
// 2026-10-14: "we do quick pay... the fee's just our standard accounting
// charge").
const PAY_TOPIC = new RegExp([
  PAYMENT_INVENTED_RE.source,
  String.raw`\bquick ?pay\b`,
  String.raw`\bfactor(?:ing|ed)?\b`,
  String.raw`\bpayment(?:s| terms)?\b`,
  String.raw`\bpay(?:s|ing)? (?:out|fast|quick)\b`,
  String.raw`\b(?:pay|paid)\b[^.!?]{0,15}\b(?:in|within|after)\s+\d{1,3}\s*(?:business\s+)?days?\b`,
  String.raw`\b\d{1,3}\s*(?:business\s+)?days?\s+(?:to\s+)?pay\b`,
].join('|'), 'i')
// A fee, a charge or a percentage is payment talk only beside payment words:
// "no fee for the tarp" and "100% on time" are not.
const FEE_WORDS = /\b(?:fee|charge|percent)\b|%/i
const PAYING = /\b(?:accounting|quick ?pay|factor(?:ing|ed)?|pay(?:s|ing)?|paid|payments?)\b/i
const DEFERS = /\baccounting\b|\brate ?con\b|can'?t speak to|not my (?:side|department|call)/i
// Accessorials have their own terms and their own check (lumperPayerWrong).
const ACCESSORIAL = /\b(?:lumper|detention|tonu|layover)\b/i
const SENTENCES = /(?<=[.!?])\s+/
const PAY_CLAUSES = /[,;]|\bbut\b/i
const PERCENT = /%/
// "No fee on our side, ask accounting": a fee word that only denies one, in a
// sentence that sends the carrier to accounting, names no term. A topic word
// still counts ("Payment is net 30 and no fee" is flagged).
const NO_FEE = /\bno (?:\w+ )?(?:fee|charge)s?\b/i
// Separate a statement that quick pay exists from a referral for its details.
// The latter cannot undo the former in the same clause.
const QUICK_PAY_ASSERTIONS = [
  /\b(?:we|i)\s+(?:do|don'?t do|offer|have|provide|can (?:do|offer|provide|get you)|will get you)\s+(?:(?:a|an)\s+)?quick ?pay\b/i,
  /\bquick ?pay\s+(?:option|program)?\s*(?:is|comes)\s+(?:available|offered|something we (?:do|offer|provide))\b/i,
]
const CANNOT_CONFIRM_AVAILABILITY = /\b(?:can'?t|cannot|don'?t|do not|not able to)\s+(?:say|tell|confirm|verify|know)\s+(?:whether|if)\b/i

// True when the reply talks about payment terms other than by sending them
// to accounting: a topic clause must defer, repeat only numbers the
// dispatcher typed (`said`, a text or a list of texts) and name no percentage.
// A fee word is a topic only in a sentence that also talks payment.
export function paymentTermsClaimed(reply, said = []) {
  const theirs = new Set(asciiPunct([said].flat().join(' ')).match(/\d+(?:\.\d+)?/g) ?? [])
  return asciiPunct(String(reply ?? '')).split(SENTENCES).some((sentence) => {
    const paying = PAYING.test(sentence)
    return sentence.split(PAY_CLAUSES).some((clause) => {
      if (ACCESSORIAL.test(clause)) return false
      if (!PAY_TOPIC.test(clause) && !(paying && FEE_WORDS.test(clause))) return false
      if (!PAY_TOPIC.test(clause) && NO_FEE.test(clause) && DEFERS.test(sentence) && !PERCENT.test(clause)) return false
      if (QUICK_PAY_ASSERTIONS[0].test(clause)) return true
      if (CANNOT_CONFIRM_AVAILABILITY.test(clause)) return false
      if (QUICK_PAY_ASSERTIONS[1].test(clause)) return true
      if (!DEFERS.test(clause) || PERCENT.test(clause)) return true
      return (clause.match(/\d+(?:\.\d+)?/g) ?? []).some((n) => !theirs.has(n))
    })
  })
}
