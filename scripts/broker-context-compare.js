// Read-only replay: three isolated cases, one actual HTTP request per case.
// No chat writes, transport retry, fallback model or regeneration. Dry-run by
// default; --execute explicitly spends requests. Run low and medium separately.
import 'dotenv/config'
import { pool } from '../src/db/pool.js'
import { chatConfigFor } from '../src/modules/chat/chatProvider.js'
import { buildBrokerContext } from '../src/modules/brokerChat/brokerContext.js'
import { buildMessages, FALLBACK_REPLY } from '../src/modules/brokerChat/brokerChat.prompt.js'
import { negotiate } from '../src/modules/brokerChat/negotiation.js'
import { bookingFacts } from '../src/modules/brokerChat/bookingTalk.js'
import { truckFacts } from '../src/modules/brokerChat/truckTalk.js'
import { brokerReplyProblem } from '../src/modules/brokerChat/replyProblem.js'
import { stripSpeakerLabel } from '../src/lib/speakerLabel.js'
import { completionBody } from './seed/aiClient.js'
import { chatMaxTokens, dailyTokenStatus, groqReasoningParams } from '../src/constants/chatBudget.js'
import { DAILY_TOKENS_SQL, DAILY_USAGE_SQL } from '../src/modules/chat/chatBudget.sql.js'

const args = process.argv.slice(2)
const option = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback
const execute = args.includes('--execute')
const effort = option('effort', 'low')
const turnId = Number(option('turn', '90'))
const unrecordedTokens = Number(option('unrecorded-tokens', '18648'))
const unrecordedRequests = Number(option('unrecorded-requests', '5'))
const unrecordedDay = option('unrecorded-day', '2026-10-20')
if (!['low', 'medium'].includes(effort) || !Number.isSafeInteger(turnId) || turnId < 1
  || !Number.isSafeInteger(unrecordedTokens) || unrecordedTokens < 18648
  || !Number.isSafeInteger(unrecordedRequests) || unrecordedRequests < 5) throw new Error('Invalid comparison arguments')

const cases = [
  { name: 'greeting', text: 'wassap brother', pushes: 0 },
  { name: 'offer', text: 'brother can you 9000$', pushes: 0 },
  { name: 'objection', text: '8100 to low brother can u add litle bit or what is your best', pushes: 1 },
]
const config = chatConfigFor('broker')
if (!/api\.groq\.com/.test(config.baseUrl) || config.model !== 'openai/gpt-oss-120b') throw new Error('Comparison requires the current primary Groq GPT-OSS model')
const maxTokens = chatMaxTokens()
const client = await pool.connect()
try {
  await client.query('BEGIN READ ONLY')
  const { rows: [source] } = await client.query(`SELECT l.created_at, l.conversation_id, c.posting_id
    FROM chat_turn_log l JOIN broker_conversations c ON c.id = l.conversation_id
    WHERE l.id = $1 AND l.chat = 'broker'`, [turnId])
  if (!source) throw new Error('Source broker turn not found')
  const { rows: [row] } = await client.query(`SELECT p.*, b.name, b.contact_name, b.persona
    FROM load_postings p JOIN brokers b ON b.id = p.broker_id WHERE p.id = $1`, [source.posting_id])
  if (!row) throw new Error('Source posting not found')
  const posting = {
    id: row.id, originCity: row.origin_city, originState: row.origin_state,
    destinationCity: row.destination_city, destinationState: row.destination_state,
    commodity: row.commodity, rateUsd: row.rate_usd, distanceMi: row.distance_mi, rateHidden: row.rate_hidden,
    weightLbs: row.weight_lbs, equipmentType: row.equipment_type, equipmentLengthFt: row.equipment_length_ft,
    pickupAt: row.pickup_at, deliveryAt: row.delivery_at, postedAt: row.posted_at, expiresAt: row.expires_at,
  }
  const { rows: prior } = await client.query(`SELECT role, kind, content FROM broker_messages
    WHERE conversation_id = $1 AND created_at <= $2 ORDER BY created_at, id`, [source.conversation_id, source.created_at])
  const { rows: [{ day: databaseDay }] } = await client.query("SELECT to_char(current_date, 'YYYY-MM-DD') AS day")
  const { rows: tokens } = await client.query(DAILY_TOKENS_SQL)
  const { rows: [usage] } = await client.query(DAILY_USAGE_SQL, [null, 'both'])
  await client.query('ROLLBACK')
  const recordedTokens = tokens.find((r) => r.model === config.model)?.total ?? 0
  const status = dailyTokenStatus(config.baseUrl, config.model, recordedTokens + unrecordedTokens)
  const broker = { name: row.name, contactName: row.contact_name, persona: row.persona }
  const now = new Date(source.created_at)
  const prepared = cases.map((item) => {
    const thread = [...prior, { role: 'dispatcher', kind: 'text', content: item.text }]
    const said = thread.filter((m) => m.role === 'dispatcher' && m.kind !== 'rate_con').map((m) => m.content)
    // An unprovided MC stays unverified; carrier profile is not disclosed or guessed.
    const booking = bookingFacts({ texts: said, carrier: null, posting, now })
    const truck = truckFacts({ texts: said, posting, now })
    const decision = negotiate({ conversation: { status: 'open', negotiationStage: 'negotiating',
      brokerOfferUsd: posting.rateUsd, ratePushCount: item.pushes }, posting, text: item.text, booking, truck, now, offerVisible: true })
    const paper = { status: 'open', delivered: false, stage: decision.state.stage }
    const context = buildBrokerContext({ broker, posting, now, thread, said, booking, paper, negotiation: decision })
    const messages = buildMessages({ ...context, newMessage: item.text, negotiation: decision })
    return { ...item, decision, messages, checkFacts: { posting, booking, truck, said, now, text: item.text,
      paper, negotiation: decision, brokerSaid: prior.filter((m) => m.role === 'broker' && m.kind !== 'rate_con').map((m) => m.content) } }
  })
  // Conservative input estimate; actual usage is printed per request. The
  // floor omits unknown external spend, so this is not provider quota truth.
  const estimatedTokens = prepared.reduce((sum, item) => sum + Math.ceil(JSON.stringify(item.messages).length / 3) + maxTokens, 0)
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'dry-run', model: config.model, effort, sourceTurn: turnId,
    cases: 3, databaseDay, recordedTokens, unrecordedTokens, unrecordedRequests, unrecordedDay,
    priorSpendChargedConservativelyEvenAcrossDayBoundary: unrecordedDay !== databaseDay, recordedRequests: usage.account_used,
    estimatedTokens, dailyTokenLimit: status.limit, limitIsLocalPublishedEstimate: true }))
  if (status.limit && recordedTokens + unrecordedTokens + estimatedTokens > status.limit) throw new Error('Insufficient estimated daily token headroom')
  let actualTokens = 0
  for (const [index, item] of prepared.entries()) {
    if (!execute) { console.log(JSON.stringify({ case: item.name, promptChars: JSON.stringify(item.messages).length, authorizedOffer: item.decision.state.offer })); continue }
    if (index) await new Promise((resolve) => setTimeout(resolve, 35000))
    const started = Date.now()
    let response
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(completionBody({ model: config.model, messages: item.messages, temperature: 0.9, maxTokens,
          providerParams: { ...groqReasoningParams(config.baseUrl, config.model, 'broker'), reasoning_effort: effort } })),
        signal: AbortSignal.timeout(60000),
      })
      const body = await response.json()
      const raw = body.choices?.[0]?.message?.content ?? ''
      const cleaned = stripSpeakerLabel(raw, broker.contactName)
      const problem = brokerReplyProblem(cleaned, item.checkFacts)
      const fallback = Boolean(problem?.unusable)
      const guardedPreview = fallback ? problem.safeReply ?? item.decision.line ?? FALLBACK_REPLY : cleaned
      actualTokens += body.usage?.total_tokens ?? 0
      console.log(JSON.stringify({ case: item.name, effort, model: body.model ?? config.model, status: response.status,
        latencyMs: Date.now() - started, raw, guardedPreview, guard: problem?.why ?? null, fallbackWouldBeNeeded: fallback,
        noRegenerationPerformed: true,
        usage: body.usage ?? null, cumulativeActualTokens: actualTokens, requestCount: index + 1,
        errorCode: body.error?.code ?? null, finishReason: body.choices?.[0]?.finish_reason ?? null }))
      if (!response.ok || !raw.trim()) break
    } catch (error) {
      console.log(JSON.stringify({ case: item.name, effort, status: response?.status ?? null, latencyMs: Date.now() - started,
        error: error.name, requestCount: index + 1, cumulativeActualTokens: actualTokens }))
      break
    }
  }
} finally {
  client.release()
  await pool.end()
}
