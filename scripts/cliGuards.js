// Guards shared by the scripts that can write (owner-capital, raise-event).
// Pure: the scripts read DATABASE_URL and argv, this decides.
//
// reset-company.js has the same host check written inline; these scripts
// share one copy so the two cannot drift apart.

export const LOCAL_HOSTS = Object.freeze(['localhost', '127.0.0.1'])

// The host of a database URL, or null when it cannot be read. An unreadable
// URL is treated as remote by remoteRefusal: not knowing where a write goes
// is the case that must not pass.
export function hostOf(url) {
  try { return new URL(url).hostname } catch { return null }
}

// The refusal message, or null when the write may go ahead.
export function remoteRefusal(host, allowRemote) {
  if (host !== null && LOCAL_HOSTS.includes(host)) return null
  if (allowRemote) return null
  return `refuses to write to ${host ?? '(unreadable host)'} without --allow-remote`
}
