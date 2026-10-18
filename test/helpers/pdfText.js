// Reads the text back out of a PDF buffer. Shared by the tests that check
// what a generated document says (see rateConfirmation.test.js for why).
import { inflateSync } from 'node:zlib'

// Every FlateDecode stream in the file, inflated and concatenated. A
// stream that will not inflate (an embedded font, say) is skipped rather
// than failing the read -- the text is in the ones that do.
export function pdfText(buffer) {
  const out = []
  let from = 0
  for (;;) {
    const start = buffer.indexOf('stream', from)
    if (start === -1) break
    let body = start + 'stream'.length
    if (buffer[body] === 0x0d) body += 1
    if (buffer[body] === 0x0a) body += 1
    const end = buffer.indexOf('endstream', body)
    if (end === -1) break
    try {
      const ops = inflateSync(buffer.subarray(body, end)).toString('latin1')
      // Each TJ array is one line, its hex runs split by kerning -- join
      // the runs inside a line, and put a newline between lines, so a
      // kerned word is still one word and two lines never run together.
      for (const line of ops.split('\n')) {
        const runs = line.match(/<([0-9A-Fa-f]+)>/g)
        if (!runs) continue
        out.push(runs.map((r) => Buffer.from(r.slice(1, -1), 'hex').toString('latin1')).join(''))
      }
    } catch {
      // not a deflate stream (an embedded font, say); no text to read
    }
    from = end + 'endstream'.length
  }
  return out.join('\n')
}
