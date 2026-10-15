// A database that has not had migration 060 yet.
//
// 060 added `attempts` to chat_turn_log and chat_script_requests, and the
// INSERTs name it. On a database without the migration they fail with
// 42703 (undefined_column), and the row -- a turn's record, or a script's
// request that the daily budget counts -- was lost. Both writers now retry
// without the column and say so once.

export const UNDEFINED_COLUMN = '42703'

const warned = new Set()

// One line per kind of problem per process, so a busy server logs it once.
export function warnOnce(key, message, log = console.warn) {
  if (warned.has(key)) return
  warned.add(key)
  log(message)
}

export function resetWarnings() {
  warned.clear()
}
