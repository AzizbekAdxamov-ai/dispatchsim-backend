-- 068: retain rate-con messages when a carrier cancels; mark the document void.
ALTER TABLE broker_messages ADD COLUMN IF NOT EXISTS voided_at timestamptz NULL;
ALTER TABLE broker_messages ADD COLUMN IF NOT EXISTS void_reason text NULL;
