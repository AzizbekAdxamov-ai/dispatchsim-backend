// Which instructions produced an answer: a short hash of the prompt
// builder's own source. Two answers with the same version were given the
// same rules; a different version means the prompt changed in between --
// which is what makes "better or worse after the change" answerable from
// the record (chat_turn_log, reports/eval/dataset.jsonl).

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const cache = new Map()

export function promptVersionOf(path) {
  if (!cache.has(path)) {
    cache.set(path, createHash('sha1').update(readFileSync(path, 'utf8')).digest('hex').slice(0, 10))
  }
  return cache.get(path)
}
