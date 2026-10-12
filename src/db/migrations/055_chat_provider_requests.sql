-- 055: what each dispatcher turn cost at the provider, in requests.
--
-- The daily chat budget (src/constants/chatBudget.js) is the provider's
-- request limit less 10% headroom, and it was counted as one per
-- dispatcher message. One message is not always one request: a reply the
-- model ran out of room for is tried a second time (aiClient.chatText,
-- 2026-10-06), an unusable reply is regenerated, and either can back off
-- and retry. On the 2026-10-06 scenario run the script counted 20 and sent
-- 21; in the app a single turn can send four. The headroom was never meant
-- to absorb that.
--
-- Written on the dispatcher's row after the reply, success or failure, by
-- the chat services. The default is 1 so every row written before this
-- migration -- and any turn whose count could not be written -- still
-- counts as what it was counted as before. Only dispatcher rows are read
-- (DAILY_USAGE_SQL); on the broker's and the driver's rows the column is
-- unused.

ALTER TABLE broker_messages ADD COLUMN IF NOT EXISTS provider_requests smallint NOT NULL DEFAULT 1;
ALTER TABLE driver_messages ADD COLUMN IF NOT EXISTS provider_requests smallint NOT NULL DEFAULT 1;

ALTER TABLE broker_messages DROP CONSTRAINT IF EXISTS broker_messages_provider_requests_nonneg;
ALTER TABLE broker_messages ADD CONSTRAINT broker_messages_provider_requests_nonneg CHECK (provider_requests >= 0);
ALTER TABLE driver_messages DROP CONSTRAINT IF EXISTS driver_messages_provider_requests_nonneg;
ALTER TABLE driver_messages ADD CONSTRAINT driver_messages_provider_requests_nonneg CHECK (provider_requests >= 0);
