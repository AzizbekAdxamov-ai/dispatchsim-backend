-- Loads posted without a price.
--
-- Real load boards are full of them: "call for rate". The broker has a
-- number in mind and does not publish it, because the first person to
-- pick up the phone is usually the one who gets the load, and because a
-- posted number is a ceiling the carrier will never bid above.
--
-- For a training simulator this is the most useful posting there is. A
-- board where every rate is printed lets a student sort by dollars and
-- never speak to anyone. A load with no number can only be worked by
-- opening the chat, asking, and negotiating -- which is the job.
--
-- rate_usd is NOT removed and stays NOT NULL. The broker knows what the
-- load is worth; the board simply does not say. brokerChat's ceilingFor()
-- already derives the negotiating room from that number, so a hidden-rate
-- load negotiates exactly like any other -- the student just has to ask
-- first.
ALTER TABLE load_postings
  ADD COLUMN IF NOT EXISTS rate_hidden boolean NOT NULL DEFAULT false;

-- The board filters and sorts on rate. A partial index on the visible
-- ones keeps those queries off the hidden rows.
CREATE INDEX IF NOT EXISTS load_postings_rate_visible_idx
  ON load_postings (rate_usd) WHERE status = 'open' AND rate_hidden = false;
