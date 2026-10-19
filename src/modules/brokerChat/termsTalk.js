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
  String.raw`\b(?:fee|charge|percent)\b`,
  '%',
].join('|'), 'i')
const DEFERS = /\baccounting\b|\brate ?con\b|can'?t speak to|not my (?:side|department|call)/i
// Accessorials have their own terms and their own check (lumperPayerWrong).
const ACCESSORIAL = /\b(?:lumper|detention|tonu|layover)\b/i
const PAY_CLAUSES = /(?<=[.!?])\s+|[,;]|\bbut\b/i
const PERCENT = /%/

// True when the reply talks about payment terms other than by sending them
// to accounting: a topic clause must defer, repeat only numbers the
// dispatcher typed (`said`, a text or a list of texts) and name no percentage.
export function paymentTermsClaimed(reply, said = []) {
  const theirs = new Set(asciiPunct([said].flat().join(' ')).match(/\d+(?:\.\d+)?/g) ?? [])
  return asciiPunct(String(reply ?? '')).split(PAY_CLAUSES).some((clause) => {
    if (ACCESSORIAL.test(clause) || !PAY_TOPIC.test(clause)) return false
    if (!DEFERS.test(clause) || PERCENT.test(clause)) return true
    return (clause.match(/\d+(?:\.\d+)?/g) ?? []).some((n) => !theirs.has(n))
  })
}
