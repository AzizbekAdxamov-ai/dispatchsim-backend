-- Azizbek qarori 2026-11-06: round uncommitted board rates.  Conversations
-- may already contain a quoted price; leave those postings and all booked
-- freight untouched so a previous quote or rate confirmation remains valid.
-- Empty open conversations have not quoted anything and can be synchronized.
WITH candidates AS (
  SELECT p.id, p.rate_usd, p.fuel_surcharge_usd, p.rate_basis,
         greatest(100, p.distance_mi) AS lower_bound,
         least(20000, p.distance_mi * 5) AS upper_bound,
         CASE WHEN p.rate_usd >= 1000 THEN 50 ELSE 25 END AS step
  FROM load_postings p
  WHERE p.status = 'open'
    AND NOT EXISTS (
      SELECT 1 FROM broker_conversations c WHERE c.posting_id = p.id AND (
        c.status <> 'open' OR c.agreed_rate_usd IS NOT NULL
        OR c.pending_close_usd IS NOT NULL OR c.rate_con_rate_usd IS NOT NULL
        OR c.rate_push_count <> 0 OR c.negotiation_stage <> 'negotiating'
        OR (c.broker_offer_usd IS NOT NULL AND c.broker_offer_usd <> p.rate_usd)
        OR EXISTS (SELECT 1 FROM broker_messages m WHERE m.conversation_id = c.id)
      )
    )
), rounded AS (
  SELECT *, greatest(ceil(lower_bound::numeric / step) * step,
           least(floor(upper_bound::numeric / step) * step,
                 round(rate_usd::numeric / step) * step))::integer AS total
  FROM candidates
  WHERE ceil(lower_bound::numeric / step) <= floor(upper_bound::numeric / step)
), updated AS (
  UPDATE load_postings p
  SET rate_usd = r.total,
    fuel_surcharge_usd = CASE WHEN r.rate_basis = 'all-in' THEN 0 ELSE
      greatest(r.step, least(r.total - r.step,
        round(r.fuel_surcharge_usd::numeric / r.step)::integer * r.step)) END,
    updated_at = now()
  FROM rounded r WHERE p.id = r.id
  RETURNING p.id, p.rate_usd
)
UPDATE broker_conversations c
SET broker_offer_usd = u.rate_usd, negotiation_revision = negotiation_revision + 1,
    updated_at = now()
FROM updated u WHERE c.posting_id = u.id;
