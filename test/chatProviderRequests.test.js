// 055: the daily chat budget is a count of provider requests, not of
// dispatcher messages. One message can cost a second try, a regeneration
// and backoff retries; on 2026-10-06 the scenario script counted 20 and
// sent 21.
//
// Pure, no database. Each test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DAILY_USAGE_SQL } from '../src/modules/chat/chatBudget.sql.js'
import { seatsCounting } from '../src/modules/chat/chatBudget.service.js'
import { sendMessage } from '../src/modules/brokerChat/brokerChat.service.js'
import { makeFakeBrokerRepo, FAKE_IDS } from './helpers/fakeBrokerRepo.js'

const here = dirname(fileURLToPath(import.meta.url))
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8')

// Kills: a column that is nullable, defaults to 0 (every old turn would
// stop counting), or accepts a negative cost.
test('055 adds a non-negative request count that defaults to one, on both tables', () => {
  const sql = read('src', 'db', 'migrations', '055_chat_provider_requests.sql')
  for (const t of ['broker_messages', 'driver_messages']) {
    assert.match(sql, new RegExp(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS provider_requests smallint NOT NULL DEFAULT 1;`))
    assert.match(sql, new RegExp(`ALTER TABLE ${t} ADD CONSTRAINT \\w+ CHECK \\(provider_requests >= 0\\);`))
  }
})

// Kills: the budget still counting rows.
test('the daily usage sums the requests, for this dispatcher and for the wallet', () => {
  assert.match(DAILY_USAGE_SQL, /coalesce\(sum\(n\) FILTER \(WHERE user_id = \$1\), 0\)::int AS used/)
  assert.match(DAILY_USAGE_SQL, /coalesce\(sum\(n\), 0\)::int\s+AS account_used/)
  assert.equal((DAILY_USAGE_SQL.match(/provider_requests/g) ?? []).length, 2)
})

// Kills: deciding "already seated" by requests. A turn whose call never
// left costs 0 requests but the person is already in `seats`; adding them
// again would shrink everyone's share.
test('a dispatcher is seated by turns, not by requests', () => {
  assert.equal(seatsCounting(3, 0), 4)
  assert.equal(seatsCounting(3, 2), 3)
})

// Kills: a model call in either chat that is not counted, or a cost that
// is written only when the reply succeeded.
for (const [chat, file] of [['broker', 'brokerChat'], ['driver', 'driverChat']]) {
  test(`the ${chat} chat counts every model call and writes the cost in finally`, () => {
    const src = read('src', 'modules', file, `${file}.service.js`)
    const calls = (src.match(/await (?:deps\.)?chatText\(\{/g) ?? []).length
    assert.ok(calls >= 2)
    assert.equal((src.match(/^\s+onRequest,$/gm) ?? []).length, calls)
    assert.match(src, /\} finally \{[\s\S]*?await (?:deps\.)?repo\.setProviderRequests\(dispatcherMessage\.id, spent\)/)
  })
}

test('live broker retry, fallback and failed calls preserve request cost and turn log in finally', async () => {
  for (const fail of [false, true]) {
    const fake = makeFakeBrokerRepo({ lines: ['MC-741309'] })
    const costs = []
    const logs = []
    const calls = []
    fake.repo.setProviderRequests = async (id, spent) => costs.push({ id, spent })
    const deps = {
      repo: fake.repo, getCarrier: async () => ({ name: 'Carrier', mcNumber: 'MC-741309' }),
      findById: async () => ({ email: 'user@example.com' }), assertCanSend: async () => {},
      chatConfigFor: () => ({ model: 'primary' }), logTurn: async (row) => logs.push(row),
      chatText: async (args) => {
        calls.push(args)
        args.onRequest()
        args.onAttempt({ n: 1, model: 'primary', cause: args.cause ?? 'first', outcome: 'rate_limited', status: 429 })
        args.onRequest()
        args.onAttempt({ n: 2, model: 'backup', cause: 'fallback', outcome: fail ? 'http_error' : 'ok', status: fail ? 503 : 200 })
        args.onModel('backup')
        if (fail) throw new Error('provider failed after two requests')
        return 'x'.repeat(2000) // First and retry are unusable; the saved reply must be safe.
      },
    }
    const run = () => sendMessage({ conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user, text: 'Is it available?' }, { deps })
    if (fail) await assert.rejects(run, { code: 'CHAT_UNAVAILABLE' })
    else await run()
    assert.equal(calls.length, fail ? 1 : 2)
    if (!fail) assert.equal(calls[1].cause, 'regenerate')
    assert.equal(costs.length, 1)
    assert.equal(costs[0].spent, fail ? 2 : 4)
    assert.equal(logs.length, 1)
    assert.equal(logs[0][4], 'backup')
    assert.equal(logs[0][14], fail ? 2 : 4)
    assert.deepEqual(JSON.parse(logs[0][16]).map((a) => a.n), fail ? [1, 2] : [1, 2, 3, 4])
    if (fail) assert.equal(logs[0][13], 'provider failed after two requests')
    else {
      assert.equal(logs[0][12], true)
      assert.ok(fake.state.messages.filter((m) => m.role === 'broker').every((m) => m.content.length < 2000))
    }
  }
})
