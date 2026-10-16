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
const BROKER_PAYS = /\b(we|us|our|broker|reimburs\w*)\b/i

export function lumperPayerWrong(reply) {
  return asciiPunct(String(reply ?? ''))
    .split(/(?<=[.!?])\s+/)
    .some((sentence) => /lumper/i.test(sentence) && OTHER_PAYS.test(sentence) && !BROKER_PAYS.test(sentence))
}
