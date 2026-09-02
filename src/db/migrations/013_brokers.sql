-- 013: brokers — invented companies, not real ones.
--
-- Every broker name in this project is fictional. That is a deliberate
-- product decision (2026-08-31), not a placeholder: the app attaches an MC
-- number, a credit rating and a payment history to each broker, and doing
-- that to a real company would mean stating false, damaging facts about a
-- real business that a student could carry away as true.
--
-- Because the names are invented, the ratings and payment behaviour below
-- are free to model whatever teaches best.

CREATE TABLE IF NOT EXISTS brokers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL UNIQUE,
  mc_number      text NOT NULL UNIQUE,
  credit_rating  text NOT NULL,
  days_to_pay    integer NOT NULL,
  contact_name   text NOT NULL,
  -- One line of character, fed to the broker chat prompt later. Kept here
  -- rather than in the prompt file so each broker stays consistent across
  -- every conversation.
  persona        text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT brokers_rating   CHECK (credit_rating IN ('A','B','C','D')),
  CONSTRAINT brokers_days     CHECK (days_to_pay BETWEEN 10 AND 120),
  CONSTRAINT brokers_mc_fmt   CHECK (mc_number ~ '^MC-[0-9]{6}$'),
  CONSTRAINT brokers_name_len CHECK (char_length(name) BETWEEN 3 AND 120)
);

-- Postings link to a broker. NULL is allowed on purpose: postings generated
-- before this migration keep working and expire within a day, and the next
-- generation fills the column in. The text `broker` column stays as the
-- display name so nothing that reads it breaks.
ALTER TABLE load_postings ADD COLUMN IF NOT EXISTS broker_id uuid NULL REFERENCES brokers(id);
CREATE INDEX IF NOT EXISTS idx_load_postings_broker_id ON load_postings(broker_id);

-- Reference data, not generated content: the roster is fixed, so it lives
-- with the schema. ON CONFLICT keeps the migration re-runnable.
--
-- Rating spread is deliberate — roughly 40% A, 33% B, 17% C, 8% D. The D
-- broker has to appear often enough that a student meets one regularly;
-- learning to read a broker's credit is the point.
INSERT INTO brokers (name, mc_number, credit_rating, days_to_pay, contact_name, persona) VALUES
  ('Harbor Line Freight Exchange', 'MC-482170', 'A', 15, 'Dana Whitfield',
   'Warm but brisk. Knows the lane, quotes fairly, will not move more than 3% on rate.'),
  ('Cedar Ridge Transport Services', 'MC-517634', 'A', 18, 'Marcus Oyelaran',
   'Methodical. Asks for paperwork up front and will not talk rate until it is in hand.'),
  ('Ironwood Freight Partners', 'MC-390812', 'A', 20, 'Renata Kovac',
   'Blunt and fast. Short sentences, no small talk, respects a carrier who is equally direct.'),
  ('Northgate Cargo Solutions', 'MC-624905', 'A', 16, 'Thomas Beckley',
   'Friendly and chatty, but slips in questions about equipment and insurance while chatting.'),
  ('Blue Meridian Logistics Group', 'MC-458293', 'A', 21, 'Priyanka Raman',
   'Precise. Quotes numbers to the cent and expects the same back.'),
  ('Stonebridge Carrier Network', 'MC-731046', 'B', 30, 'Alan Deschamps',
   'Easygoing, flexible on pickup windows, slower to answer when the load is not urgent.'),
  ('Sunbelt Freight Alliance', 'MC-295718', 'B', 32, 'Carmen Ortiz',
   'Pushes hard on rate, opens low, expects to be negotiated up and enjoys it.'),
  ('Pioneer Valley Transport Co', 'MC-806341', 'B', 28, 'Gregory Nash',
   'Cautious. Asks a lot of safety questions and checks the answers against what you said earlier.'),
  ('Redstone Logistics Partners', 'MC-143967', 'B', 35, 'Yuki Tanabe',
   'Efficient and impersonal. Answers only what was asked, never volunteers extra detail.'),
  ('Copperfield Freight Group', 'MC-570284', 'C', 45, 'Devin Marlowe',
   'Overly agreeable. Promises quickly, vague about paperwork, changes details between messages.'),
  ('Marshfield Cargo Brokers', 'MC-918452', 'C', 48, 'Sandra Ilves',
   'Apologetic and slow. Frequently mentions being short-staffed when asked about paperwork.'),
  ('Tidewater Merchant Freight', 'MC-207863', 'D', 68, 'Roy Pendleton',
   'Charming and evasive. Great rates, keeps steering away from questions about payment terms.')
ON CONFLICT (name) DO NOTHING;
