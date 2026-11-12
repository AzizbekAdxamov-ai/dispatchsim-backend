// Sending an invoice and chasing an overdue one. The marks are records only:
// payment timing (invoice_due_at / invoice_paid_at) must stay untouched.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { reminderText } from '../src/modules/finance/invoiceReminder.js'
import { reminderBlock, sendInvoiceReminder } from '../src/modules/finance/finance.service.js'
import { INVOICE_REMINDER_COOLDOWN_SIM_DAYS } from '../src/modules/finance/finance.constants.js'
import { FINANCE_REAL_MS_PER_SIM_DAY } from '../src/constants/simClock.js'

const { hasDb } = await import('./helpers/db.js')

const SENT_AT = new Date('2026-11-01T00:00:00Z')
const COOLDOWN_MS = INVOICE_REMINDER_COOLDOWN_SIM_DAYS * FINANCE_REAL_MS_PER_SIM_DAY
const COOLDOWNS_AFTER_SENT = 10
const DAYS_PAST_DUE = 3
const SOME_LOAD_ID = '4471'
const SOME_INVOICE_ID = `INV-2026-${SOME_LOAD_ID}`
const DISPATCHER_ID = 'user-1'

const overdueRow = (extra = {}) => ({
  loadId: SOME_LOAD_ID,
  status: 'overdue',
  rateUsd: 1000,
  accessorials: [],
  bookedAt: SENT_AT,
  deliveredAt: SENT_AT,
  invoiceSentAt: SENT_AT,
  invoiceRemindedAt: null,
  daysPastDue: DAYS_PAST_DUE,
  ...extra,
})

function fakeDeps(row, { conversation = { id: 'conv-1' } } = {}) {
  const calls = { added: [], marked: 0 }
  return {
    calls,
    deps: {
      getRow: async () => row,
      openConversation: async () => conversation,
      addMessage: async (conversationId, role, text) => { calls.added.push({ conversationId, role, text }) },
      markReminded: async () => { calls.marked += 1 },
    },
  }
}

// Kills: letting a reminder go out for a paid or not-yet-due invoice.
test('a reminder is refused unless the invoice is overdue', () => {
  assert.equal(reminderBlock(overdueRow({ status: 'paid' })), 'INVOICE_NOT_OVERDUE')
  assert.equal(reminderBlock(overdueRow({ status: 'open' })), 'INVOICE_NOT_OVERDUE')
  assert.equal(reminderBlock(overdueRow({ status: 'draft' })), 'INVOICE_NOT_OVERDUE')
  assert.equal(reminderBlock(overdueRow()), null)
})

// Kills: chasing an invoice that was never sent.
test('a reminder needs the invoice to have been sent', () => {
  assert.equal(reminderBlock(overdueRow({ invoiceSentAt: null })), 'INVOICE_NOT_SENT')
})

// Kills: removing the cooldown (a reminder on every click).
test('a second reminder inside the cooldown is refused', () => {
  const now = SENT_AT.getTime() + COOLDOWN_MS * COOLDOWNS_AFTER_SENT
  const recent = new Date(now - COOLDOWN_MS + 1)
  const old = new Date(now - COOLDOWN_MS)
  assert.equal(reminderBlock(overdueRow({ invoiceRemindedAt: recent }), now), 'INVOICE_REMINDED_RECENTLY')
  assert.equal(reminderBlock(overdueRow({ invoiceRemindedAt: old }), now), null)
})

// Kills: routing the reminder through brokerChat.service.sendMessage (which schedules an AI reply), or posting more than one line.
test('a reminder adds exactly one dispatcher message and nothing else', async () => {
  const { calls, deps } = fakeDeps(overdueRow())
  await sendInvoiceReminder(SOME_INVOICE_ID, DISPATCHER_ID, { deps })
  assert.equal(calls.added.length, 1)
  assert.equal(calls.added[0].role, 'dispatcher')
  assert.equal(calls.added[0].conversationId, 'conv-1')
  assert.equal(calls.marked, 1)
  const source = readFileSync(new URL('../src/modules/finance/finance.service.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from '[^']*brokerChat\.service/)
})

// Kills: posting a message (or marking) when the reminder was refused.
test('a refused reminder posts nothing', async () => {
  const { calls, deps } = fakeDeps(overdueRow({ status: 'paid' }))
  await assert.rejects(sendInvoiceReminder(SOME_INVOICE_ID, DISPATCHER_ID, { deps }), (e) => e.code === 'INVOICE_NOT_OVERDUE')
  assert.equal(calls.added.length, 0)
  assert.equal(calls.marked, 0)
})

// Kills: a reminder for a load whose broker thread belongs to another dispatcher.
test('a reminder without a broker thread is refused', async () => {
  const { calls, deps } = fakeDeps(overdueRow(), { conversation: null })
  await assert.rejects(sendInvoiceReminder(SOME_INVOICE_ID, DISPATCHER_ID, { deps }), (e) => e.code === 'LOAD_HAS_NO_BROKER_THREAD')
  assert.equal(calls.added.length, 0)
})

// Kills: money talk, a rate, or a cancel threat in the chase message.
test('the reminder text has no dollar sign, rate or cancel wording', () => {
  const text = reminderText({ invoiceId: SOME_INVOICE_ID, loadId: SOME_LOAD_ID, daysPastDue: DAYS_PAST_DUE })
  assert.doesNotMatch(text, /\$/)
  assert.doesNotMatch(text, /rate/i)
  assert.doesNotMatch(text, /cancel/i)
  assert.match(text, new RegExp(SOME_INVOICE_ID))
  assert.match(text, new RegExp(`#${SOME_LOAD_ID}`))
})

async function withLoad(fn, { delivered = true } = {}) {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const { makeCheckFixture } = await import('./helpers/dispatchFixture.js')
  await inRollback(pool, async (client) => {
    const fx = await makeCheckFixture(client)
    if (delivered) {
      await client.query(
        `UPDATE loads SET delivered_at = now(), invoice_due_at = now() + interval '1 hour', status = 'done'
          WHERE id = $1`,
        [fx.loadId],
      )
    }
    await fn({ client, fx })
  })
}

const dueAndPaid = async (client, loadId) =>
  (await client.query('SELECT invoice_due_at, invoice_paid_at FROM loads WHERE id = $1', [loadId])).rows[0]

// Kills: markInvoiceSent / markInvoiceReminded writing invoice_due_at or invoice_paid_at (payment timing).
test('sending and reminding never change due or paid dates', { skip: !hasDb }, async () => {
  const loadsRepo = await import('../src/modules/loads/loads.repository.js')
  await withLoad(async ({ client, fx }) => {
    const before = await dueAndPaid(client, fx.loadId)
    assert.ok(await loadsRepo.markInvoiceSent(fx.loadId, client))
    assert.ok(await loadsRepo.markInvoiceReminded(fx.loadId, client))
    assert.deepEqual(await dueAndPaid(client, fx.loadId), before)
  })
})

// Kills: sending a draft invoice (a load that has not been delivered).
test('a load that is not delivered cannot be marked sent', { skip: !hasDb }, async () => {
  const loadsRepo = await import('../src/modules/loads/loads.repository.js')
  await withLoad(async ({ client, fx }) => {
    assert.equal(await loadsRepo.markInvoiceSent(fx.loadId, client), null)
  }, { delivered: false })
})

// Kills: marking an invoice sent twice (moving the sent date), or reminding an unsent invoice.
test('sent is set once and a reminder needs sent', { skip: !hasDb }, async () => {
  const loadsRepo = await import('../src/modules/loads/loads.repository.js')
  await withLoad(async ({ client, fx }) => {
    assert.equal(await loadsRepo.markInvoiceReminded(fx.loadId, client), null)
    assert.ok(await loadsRepo.markInvoiceSent(fx.loadId, client))
    assert.equal(await loadsRepo.markInvoiceSent(fx.loadId, client), null)
  })
})
