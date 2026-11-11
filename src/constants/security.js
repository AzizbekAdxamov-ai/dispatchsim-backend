// Numbers that decide how much abuse the API tolerates. One place, named,
// so a limit is never a bare literal inside a router.

export const ONE_MINUTE_MS = 60 * 1000

// /ops/* is called by a scheduler about once a day. 30/minute per IP leaves
// room for retries and manual checks and still makes guessing the secret
// pointless.
export const OPS_LIMIT_PER_MINUTE = 30

// Every route except /health and /ops. A whole classroom can share one NAT
// address, so this is generous; it exists to stop floods, not to meter use.
export const GLOBAL_LIMIT_PER_MINUTE = 600

// PDF routes build a document in memory on every request.
export const PDF_LIMIT_PER_MINUTE = 20

// Largest page a list endpoint may be asked for (truck listings).
export const MAX_PAGE = 100

// A prompt line this long, repeated verbatim in a reply, is the model
// reading its instructions aloud; shorter lines ("Keep it short.") can
// appear in ordinary speech by chance.
export const PROMPT_LEAK_MIN_CHARS = 50
