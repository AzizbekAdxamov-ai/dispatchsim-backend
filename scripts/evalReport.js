// A run ID also keys dataset rows, so choose it before the first case.
// Milliseconds make sequential runs readable; the nonce keeps processes
// started in the same millisecond distinct. An existing name gets a suffix.
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function nextEvalRunId(outDir, startedAt, nonce = randomUUID(), exists = existsSync) {
  const stamp = startedAt.toISOString().replace(/[:.T]/g, '-').replace(/Z$/, '')
  const base = `${stamp}-${nonce}`
  let id = base
  let suffix = 2
  while (exists(join(outDir, `run-${id}.md`))) id = `${base}-${suffix++}`
  return id
}

// Exclusive create is the final protection against a concurrent writer
// picking the same path after nextEvalRunId checked it.
export function writeEvalReport(outDir, runId, markdown, write = writeFileSync) {
  const file = join(outDir, `run-${runId}.md`)
  write(file, markdown, { flag: 'wx' })
  return file
}
