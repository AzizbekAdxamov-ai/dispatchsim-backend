// Shared manual harness for the four bounded workflows, not a background job.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readTurnLog, renderLiveReport, reportTotals, turnIssues } from './brokerLiveReport.js'

export const liveLoads = [
  { name: 'Blue Meridian Logistics Group', contactName: 'Priyanka Raman', persona: 'Formal, precise, courteous.',
    originCity: 'Toledo', originState: 'OH', destinationCity: 'Yakima', destinationState: 'WA', rateUsd: 8153, distanceMi: 2180, weightLbs: 26200 },
  { name: 'Ironwood Freight Brokerage', contactName: 'Marcus Hale', persona: 'Gruff but fair: quick answers, pain talk, swears softly.',
    originCity: 'Dallas', originState: 'TX', destinationCity: 'Chicago', destinationState: 'IL', rateUsd: 3000, distanceMi: 970, weightLbs: 38000 },
  { name: 'Cedar Ridge Transport Services', contactName: 'Devin Moss', persona: 'Easy going, one-take spot prices, jokes often.',
    originCity: 'Atlanta', originState: 'GA', destinationCity: 'Denver', destinationState: 'CO', rateUsd: 2195, distanceMi: 1400, weightLbs: 33400 },
]
const usd = (n) => `$${Number(n).toLocaleString('en-US')}`
const amounts = (s) => [...String(s).matchAll(/\$\s*([\d,]+)/g)].map((m) => Number(m[1].replaceAll(',', '')))

export function liveScript(mode, load, offer = load.rateUsd) {
  if (mode === 'chat') return ['wassap brother',
    `look bro ${load.originCity}, ${load.originState} to ${load.destinationCity}, ${load.destinationState} load stil avaivable?`,
    'okay how much u asking', `brother can u ${load.rateUsd === 8153 ? 9000 : load.rateUsd + 850}$`,
    `${load.rateUsd} kinda low bro can u meet me at ${load.rateUsd === 8153 ? 8700 : load.rateUsd + 550}?`,
    'hold up bro dont book nothing yet, gotta check with my driver']
  const intro = `Morning! Aziz with Example Freight, MC-741309. Still covering ${load.originCity} to ${load.destinationCity}?`
  if (mode === 'push') return [intro, 'What rate is on that one?', "That's too low for me, can you do better?",
    "Come on, I need more money for this one. Add a little bit and I'll bring the truck.",
    'bro can u add a little bit again?', 'So what rate are we at now?']
  const deal = [intro, 'What rate is on that one?', `${usd(offer)} all-in works for me.`,
    'Put it on dispatch@example.com please.']
  return mode === 'walkaway' ? [...deal, "I'll pass on it, found a better one my driver can run."] : deal
}

export function liveTurnFlags(mode, i, turn, load) {
  const flags = []
  const state = turn.trace
  if (!state) return flags
  if (['chat', 'push'].includes(mode)) {
    if (state.agreed !== null) flags.push('agreed without dispatcher acceptance')
    if (state.paperCount) flags.push('issued paper before agreement')
    if (/\bMC\b|company name|what(?:'s| is) your email/i.test(turn.reply ?? '')) flags.push('identity gate before agreement')
  }
  if (mode === 'chat' && i === 0 && !/\b(?:hi|hey|hello|good|morning|afternoon|wass?up|yo)\b/i.test(turn.reply ?? '')) flags.push('greeting not returned')
  if (mode === 'chat' && i === 1 && !/\b(?:available|open|still got|still have|yes|yep|yeah)\b/i.test(turn.reply ?? '')) flags.push('availability not answered')
  if (mode === 'chat' && i === 5 && (state.stage !== 'held' || state.recipientPresent)) flags.push('hold did not clear agreement/recipient')
  if (mode === 'push' && i === 2 && state.offer !== load.rateUsd) flags.push('offer moved on first push')
  if (mode === 'push' && i === 3 && !(state.offer > load.rateUsd)) flags.push('no bounded counter after second push')
  if (state.offer > state.ceiling) flags.push('offer exceeds authoritative ceiling')
  if (mode === 'push' && i >= 3 && !amounts(turn.reply).includes(state.offer)) flags.push('quoted offer differs from authoritative figure')
  if (['ratecon', 'walkaway'].includes(mode) && i === 2 && state.agreed !== load.rateUsd) flags.push('acceptance did not record expected rate')
  if (['ratecon', 'walkaway'].includes(mode) && i === 3 && (state.paperCount !== 1 || state.paperRate !== state.agreed)) flags.push('paper missing or rate differs from agreement')
  if (mode === 'walkaway' && i === 4 && (state.agreed !== null || state.paperCount || state.recipientPresent)) flags.push('withdrawal retained agreement, paper or recipient')
  return flags
}

export async function runLive(mode) {
  if (process.env.NODE_TEST_CONTEXT || !process.argv.includes('--execute')) throw new Error('Manual use only: pass --execute outside node --test; a real provider is contacted.')
  const reportPath = process.env.REPORT_PATH
  if (!reportPath) throw new Error('REPORT_PATH is required')
  // Load provider/service dependencies only after the explicit manual gate.
  const [{ chatConfigFor }, { chatText }, { sendMessage }, { makeFakeBrokerRepo, fakePosting, FAKE_IDS }, { ceilingFor }] = await Promise.all([
    import('../src/modules/chat/chatProvider.js'), import('./seed/aiClient.js'),
    import('../src/modules/brokerChat/brokerChat.service.js'), import('../test/helpers/fakeBrokerRepo.js'),
    import('../src/modules/brokerChat/ratePolicy.js'),
  ])
  const config = chatConfigFor('broker')
  const startedAt = new Date().toISOString()
  const results = []
  let failed = false
  const save = () => {
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, renderLiveReport(mode, results, config, { startedAt,
      finishedAt: new Date().toISOString(), plannedLoads: liveLoads.length }), 'utf8')
  }
  for (const fixture of liveLoads) {
    const posting = fakePosting(fixture)
    const fake = makeFakeBrokerRepo({ posting })
    const out = { ...fixture, lane: `${fixture.originCity}, ${fixture.originState} → ${fixture.destinationCity}, ${fixture.destinationState}`,
      pickupAt: posting.pickupAt, deliveryAt: posting.deliveryAt, turns: [], flowFlags: [] }
    results.push(out)
    for (let i = 0; i < liveScript(mode, fixture).length; i += 1) {
      const turn = { asked: liveScript(mode, fixture, fake.state.conversation.brokerOfferUsd ?? fixture.rateUsd)[i],
        reply: null, rawReplies: [], flags: [], startedAt: new Date().toISOString() }
      out.turns.push(turn)
      let capturedDecision = null
      const deps = { repo: { ...fake.repo, completeChatTurn: async (payload) => {
        capturedDecision = payload.decision
        return fake.repo.completeChatTurn(payload)
      } }, getCarrier: async () => ({ name: 'Example Freight', mcNumber: 'MC-741309', email: null }),
      findById: async () => ({ email: 'login@example.com' }), assertCanSend: async () => {}, chatConfigFor,
      logTurn: async (row) => Object.assign(turn, readTurnLog(row)),
      chatText: async (args) => {
        const raw = await chatText(args)
        turn.rawReplies.push(raw)
        return raw
      } }
      try {
        // Never repeat a whole conversation (or dispatcher turn) after 429.
        // The service already counts its own provider retry/regeneration attempts.
        await sendMessage({ conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user, text: turn.asked }, { deps })
        fake.deliverAll()
      } catch (error) {
        turn.error = `${error.code ?? error.name}: ${error.message}${turn.error ? `; provider: ${turn.error}` : ''}`
        out.error = turn.error
        failed = true
      }
      const state = fake.state.conversation
      turn.trace = { intent: capturedDecision?.intent ?? null, offer: state.brokerOfferUsd ?? posting.rateUsd,
        agreed: state.agreedRateUsd, stage: state.negotiationStage, recipientPresent: state.recipientEmail !== null,
        paperCount: fake.state.messages.filter((m) => m.kind === 'rate_con').length,
        paperRate: state.rateConRateUsd, revision: state.negotiationRevision,
        bestCounterUsed: state.bestCounterUsed, ceiling: ceilingFor(posting),
        issuePaper: capturedDecision?.issuePaper ?? false }
      turn.finishedAt = new Date().toISOString()
      turn.flags = liveTurnFlags(mode, i, turn, fixture)
      save()
      if (failed) break
      // Keep provider load low and match the requested twenty-second spacing.
      if (i + 1 < liveScript(mode, fixture).length) await new Promise((resolve) => setTimeout(resolve, 20_000))
    }
    if (failed) break
    if (fixture !== liveLoads.at(-1)) await new Promise((resolve) => setTimeout(resolve, 20_000))
  }
  save()
  const totals = reportTotals(results)
  console.log(JSON.stringify({ reportPath, ...totals }))
  if (failed) process.exitCode = 1
  else if (results.some((load) => load.turns.some((turn) => turnIssues(turn).length) || load.flowFlags.length)) process.exitCode = 2
}

export function launchLive(mode, url) {
  if (process.argv[1] && pathToFileURL(process.argv[1]).href === url && !process.env.NODE_TEST_CONTEXT) {
    runLive(mode).catch((error) => { console.error(error.message); process.exitCode = 1 })
  }
}
