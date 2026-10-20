-- Chat handshakes, not typed form amounts, authorize a rate confirmation.
ALTER TABLE carrier ADD COLUMN IF NOT EXISTS email text NULL;
ALTER TABLE carrier ADD CONSTRAINT carrier_email_format CHECK
  (email IS NULL OR (length(email) <= 254 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'));

ALTER TABLE broker_conversations
  ADD COLUMN negotiation_stage text NOT NULL DEFAULT 'negotiating',
  ADD COLUMN broker_offer_usd integer NULL,
  ADD COLUMN recipient_email text NULL,
  ADD COLUMN rate_push_count integer NOT NULL DEFAULT 0,
  ADD COLUMN best_counter_used boolean NOT NULL DEFAULT false,
  ADD COLUMN negotiation_revision integer NOT NULL DEFAULT 0;

-- Existing documents remain readable. No new paper or email is created by migration.
UPDATE broker_conversations c SET
  negotiation_stage = CASE WHEN c.status = 'booked' THEN 'booked'
    WHEN c.status = 'agreed' AND EXISTS (SELECT 1 FROM broker_messages m WHERE m.conversation_id = c.id AND m.kind = 'rate_con' AND m.deliver_at <= now()) THEN 'paper_delivered'
    WHEN c.status = 'agreed' THEN 'paper_pending' ELSE 'negotiating' END,
  broker_offer_usd = coalesce(c.agreed_rate_usd, p.rate_usd)
FROM load_postings p WHERE p.id = c.posting_id;

ALTER TABLE broker_conversations ADD CONSTRAINT conversations_negotiation_stage CHECK
  (negotiation_stage IN ('negotiating', 'awaiting_email', 'paper_pending', 'paper_delivered', 'held', 'booked'));
ALTER TABLE broker_conversations ADD CONSTRAINT conversations_negotiation_counts CHECK
  (rate_push_count >= 0 AND negotiation_revision >= 0);
