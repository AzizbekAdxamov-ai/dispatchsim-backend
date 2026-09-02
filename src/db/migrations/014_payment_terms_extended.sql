-- 014: allow net45 and net60 payment terms.
--
-- Booking a load from a poorly-rated broker has to have a consequence the
-- student can feel, and the honest consequence in freight is that the money
-- arrives late. The finance module already ages receivables from
-- loads.payment_terms — it just had no term long enough to express a broker
-- that pays in 60+ days, so every broker looked equally punctual.
--
-- Keys mirror src/constants/paymentTerms.js (TERM_DAYS), which is the source
-- of truth for how many days each term means.

ALTER TABLE loads DROP CONSTRAINT IF EXISTS loads_terms_valid;
ALTER TABLE loads ADD CONSTRAINT loads_terms_valid
  CHECK (payment_terms IN ('net30', 'net15', 'quickpay', 'net45', 'net60'));
