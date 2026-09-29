-- 048: the carrier -- this company's own identity.
--
-- Until now the company had no name of its own. The rate confirmation
-- read it off `users.company`, a free-text field each person types at
-- registration, so two dispatchers registering with two different
-- spellings put two different carriers on paper for one fleet. The
-- authority number was worse: there was none anywhere in the program, and
-- rateConfirmation.js printed a sentence saying so where every real rate
-- confirmation prints an MC number. A broker who cannot check your
-- authority does not send you a load.
--
-- One row, because the project is one company in one database (the live
-- system's first decision). `id boolean PRIMARY KEY DEFAULT true` with a
-- CHECK that it IS true is the single-row idiom: a second INSERT collides
-- with the primary key instead of quietly creating a second carrier.
--
-- INVENTED, like the brokers in 013 and for the same reason: attaching
-- this simulator's behaviour to a real carrier would mean stating false
-- things about a real company. The name, the MC and the DOT below belong
-- to nobody. They are shaped like the real thing because a dispatcher
-- has to learn to read the real thing -- not so that anything printed
-- here can be passed off as a real authority.

CREATE TABLE IF NOT EXISTS carrier (
  id            boolean     PRIMARY KEY DEFAULT true,
  name          text        NOT NULL,
  -- The authority. Format matches brokers.mc_number so the two read the
  -- same way on the paper that names them both.
  mc_number     text        NOT NULL,
  dot_number    text        NOT NULL,
  phone         text        NOT NULL,
  address_line  text        NOT NULL,
  city          text        NOT NULL,
  state         text        NOT NULL,
  postal_code   text        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT carrier_single_row CHECK (id),
  CONSTRAINT carrier_name_len   CHECK (char_length(name) BETWEEN 3 AND 160),
  CONSTRAINT carrier_mc_fmt     CHECK (mc_number ~ '^MC-[0-9]{6}$'),
  CONSTRAINT carrier_dot_fmt    CHECK (dot_number ~ '^[0-9]{6,8}$'),
  CONSTRAINT carrier_state_fmt  CHECK (state ~ '^[A-Z]{2}$'),
  CONSTRAINT carrier_zip_fmt    CHECK (postal_code ~ '^[0-9]{5}$')
);

-- The company this simulator runs. Dallas because that is where most of
-- the fleet is based in the seed -- a carrier's address is where its
-- trucks sleep, not a random city.
INSERT INTO carrier (id, name, mc_number, dot_number, phone, address_line, city, state, postal_code)
VALUES (true, 'Keystone Line Haul', 'MC-741309', '3947182', '214-555-0110',
        '4120 Empire Central Drive', 'Dallas', 'TX', '75247')
ON CONFLICT (id) DO NOTHING;
