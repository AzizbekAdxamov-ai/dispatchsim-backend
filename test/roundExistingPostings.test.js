import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pool } from '../src/db/pool.js'

// Kills: rounding a negotiated/committed posting, or failing to synchronize an empty conversation.
test('migration rounds safe postings and preserves active quotes', async (t) => {
  let client
  try { client = await pool.connect() } catch { t.skip('PostgreSQL unavailable'); return }
  try {
    await client.query('BEGIN')
    await client.query(`CREATE TEMP TABLE load_postings (id int, status text, rate_usd int, fuel_surcharge_usd int,
      rate_basis text, distance_mi int, updated_at timestamptz) ON COMMIT DROP`)
    await client.query(`CREATE TEMP TABLE broker_conversations (id int, posting_id int, status text, agreed_rate_usd int,
      pending_close_usd int, rate_con_rate_usd int, rate_push_count int, negotiation_stage text,
      broker_offer_usd int, negotiation_revision int, updated_at timestamptz) ON COMMIT DROP`)
    await client.query('CREATE TEMP TABLE broker_messages (conversation_id int) ON COMMIT DROP')
    await client.query(`INSERT INTO load_postings VALUES
      (1,'open',3869,869,'linehaul-plus-fuel',1000,now()),
      (2,'open',3869,869,'linehaul-plus-fuel',1000,now()),
      (3,'booked',3869,869,'linehaul-plus-fuel',1000,now()),
      (4,'open',3869,869,'linehaul-plus-fuel',1000,now())`)
    await client.query(`INSERT INTO broker_conversations VALUES
      (1,1,'open',NULL,NULL,NULL,0,'negotiating',3869,0,now()),
      (2,2,'open',NULL,NULL,NULL,0,'negotiating',3869,0,now()),
      (4,4,'agreed',3869,NULL,3869,0,'paper_pending',3869,0,now())`)
    await client.query('INSERT INTO broker_messages VALUES (2)')
    await client.query(await readFile(new URL('../src/db/migrations/070_round_open_posting_rates.sql', import.meta.url), 'utf8'))
    const rates = (await client.query('SELECT id, rate_usd, fuel_surcharge_usd FROM load_postings ORDER BY id')).rows
    assert.deepEqual(rates.map((r) => [r.id, r.rate_usd, r.fuel_surcharge_usd]),
      [[1,3850,850], [2,3869,869], [3,3869,869], [4,3869,869]])
    const offers = (await client.query('SELECT id, broker_offer_usd, negotiation_revision FROM broker_conversations ORDER BY id')).rows
    assert.deepEqual(offers.map((r) => [r.id, r.broker_offer_usd, r.negotiation_revision]), [[1,3850,1],[2,3869,0],[4,3869,0]])
  } finally {
    await client.query('ROLLBACK')
    client.release()
    await pool.end()
  }
})
