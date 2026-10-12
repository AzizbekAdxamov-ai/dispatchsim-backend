// One shape for every answered turn, wherever it came from -- the live
// chats (chat_turn_log, 056) or an evaluation run (reports/eval/
// dataset.jsonl) -- with its grade joined in. Pure, so a test holds it.
//
// Grades live in reports/training/grades.jsonl, one line per grade:
//   {"id":"live:1234","grade":"no","note":"quoted $350 TONU, its terms say $225","by":"nova","at":"..."}
// A file, not only the database, so a grade can be written by whoever
// reads the export -- Azizbek, or Nova from the shared folder -- and the
// newest grade for an id wins.

export function liveRow(r) {
  return {
    id: `live:${r.id}`,
    source: 'live',
    chat: r.chat,
    at: new Date(r.created_at).toISOString(),
    model: r.model,
    promptVersion: r.prompt_version,
    history: r.history ?? [],
    line: r.dispatcher_text,
    imageCount: r.image_count ?? 0,
    systemPrompt: r.system_prompt,
    reply: r.reply,
    error: r.error,
    regeneratedBecause: r.regenerated_because,
    fellBack: r.fell_back,
    providerRequests: r.provider_requests,
    findings: r.findings ?? [],
    human: r.human_grade ? { grade: r.human_grade, note: r.human_note ?? '', by: 'database' } : null,
  }
}

export function readJsonl(text) {
  return String(text ?? '').split('\n').filter((l) => l.trim() !== '').map((l, i) => {
    try { return JSON.parse(l) } catch { throw new Error(`line ${i + 1} is not JSON`) }
  })
}

// The newest grade per id (by `at`, then by file order) replaces `human`.
export function withGrades(rows, grades) {
  const latest = new Map()
  for (const g of grades) {
    if (!g?.id || !['yes', 'partly', 'no'].includes(g.grade)) continue
    const prev = latest.get(g.id)
    if (!prev || String(g.at ?? '') >= String(prev.at ?? '')) latest.set(g.id, g)
  }
  return rows.map((r) => {
    const g = latest.get(r.id)
    return g ? { ...r, human: { grade: g.grade, note: g.note ?? '', by: g.by ?? null, at: g.at ?? null } } : r
  })
}

export function summary(rows) {
  const by = (pred) => rows.filter(pred).length
  return {
    total: rows.length,
    live: by((r) => r.source === 'live'),
    eval: by((r) => r.source === 'eval'),
    graded: by((r) => r.human),
    ungraded: by((r) => !r.human),
    flagged: by((r) => (r.findings ?? []).length > 0),
    failed: by((r) => r.reply == null),
  }
}
