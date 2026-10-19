// What the live chat service does with one reply, as a pure function with
// the model calls injected: check the first reply, regenerate ONCE if the
// check names a problem, check again, then fall back (unusable) or keep the
// reply and say it is still wrong (content problem). chat-eval and
// chat-scenarios use it under --service so a run shows what the user would
// have seen, not only what the model first said.
//
// The checks themselves are NOT here: `problemOf` and `retryPrompt` are the
// shared replyProblem.js functions, passed in, so there is no second copy.
//
//   first()              -> the first reply (already cleaned)
//   again(retryPrompt)   -> the regenerated reply (already cleaned)
//   problemOf(reply)     -> null | { why, hint, unusable }
//   retryPrompt(systemPrompt, problem) -> the system prompt for the retry
//
// Returns { raw, reply, regeneratedBecause, fellBack, stillFailing }.

export async function serviceReply({ first, again, problemOf, retryPrompt, fallback, systemPrompt }) {
  const raw = await first()
  const problem = problemOf(raw)
  if (!problem) {
    return { raw, reply: raw, regeneratedBecause: null, fellBack: false, stillFailing: null }
  }
  const second = await again(retryPrompt(systemPrompt, problem))
  const remaining = problemOf(second)
  if (remaining?.unusable) {
    return { raw, reply: remaining.safeReply ?? fallback, regeneratedBecause: problem.why, fellBack: true, stillFailing: remaining.why }
  }
  return { raw, reply: second, regeneratedBecause: problem.why, fellBack: false, stillFailing: remaining?.why ?? null }
}
