-- 035: fuel stops, truck stops, rest areas and repair shops -- the data
-- layer only. WHERE a driver could stop, and what it costs to fuel up
-- there. WHETHER to stop there is a dispatcher decision built on top of
-- this table, for a later task -- this migration does not decide
-- anything, it just gives the decision something to read.
--
-- Rows come from scripts/generate-facilities.js, which walks every cached
-- lane_routes (034) geometry and drops a stop every scripts/seed/
-- facilities.js's SPACING_MI along it (see that file's own header for how
-- SPACING_MI and MERGE_RADIUS_MI are computed -- both come from
-- src/constants/hos.js's REQUIRED_REST_HOURS and the project's existing
-- 55mph highway-speed estimate, not typed-in numbers).

CREATE TABLE IF NOT EXISTS facilities (
  -- Stable, not a random uuid -- derived from the point's own rounded
  -- coordinates (scripts/seed/facilities.js's facilityId()), so running
  -- the generator again over the same cached routes reproduces the SAME
  -- id for the same real-world spot instead of inserting a duplicate row
  -- next to it. That is also why there is no separate UNIQUE(lat, lon)
  -- constraint below: id IS lat/lon (rounded to 4 decimal places, the
  -- same precision scripts/seed/cities.js already uses for its own
  -- coordinates), so two rows can never share an id without sharing a
  -- location, and PRIMARY KEY(id) already forbids that.
  id                 text        PRIMARY KEY,

  kind               text        NOT NULL,

  name               text        NOT NULL,

  -- numeric(7,4): 3 integer digits + 4 decimal digits -- enough for any
  -- CONUS latitude (max |24..49.5|) or longitude (max |66.5..125.5|, the
  -- same facilities_conus box below) at cities.js's own 4-decimal-place
  -- precision, with headroom to spare.
  --
  -- numeric rather than 010_load_postings.sql's `double precision` for
  -- lat/lon: those columns feed road_miles(), a SQL trig function where
  -- double's speed matters. This table never runs road_miles() -- the
  -- proximity queries in facilities.sql.js compute their own haversine
  -- once per request, not per tick -- and numeric stores the generator's
  -- 4-decimal-place values exactly, with no float round-trip surprise
  -- when the API echoes a value back as JSON.
  lat                numeric(7,4) NOT NULL,
  lon                numeric(7,4) NOT NULL,

  -- Nearest scripts/seed/cities.js CITIES entry, by name -- text, not a
  -- foreign key, for the same reason 013_brokers.sql's brokers table has
  -- none: CITIES is a closed code-level list, not a database table (see
  -- this project's CLAUDE.md and cities.js's own header). A facility
  -- between two CITIES entries still needs a human-readable "near" label,
  -- and haversineMi against the closed set is how the generator picks it
  -- (scripts/seed/facilities.js's nearestCity()).
  near_city          text        NOT NULL,
  near_state         text        NOT NULL,

  -- Only fuel-selling kinds have a price -- see facilities_fuel_price
  -- below. Cents, matching every other USD column in this schema
  -- (rate_usd, amount_usd, ...) -- fractions of a cent are not a price
  -- anyone quotes at a pump.
  fuel_price_cents   integer     NULL,

  -- Free descriptive tags (showers, scales, parking, wifi, ...), drawn
  -- from a small fixed list in scripts/seed/facilities.js at generation
  -- time -- not CHECK-constrained here the way `kind` is, because the set
  -- of amenities is flavour (what this stop happens to offer), not a fact
  -- the rest of the schema depends on the way kind's four values are.
  amenities          text[]      NOT NULL DEFAULT '{}',

  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT facilities_kind CHECK (kind IN ('fuel', 'truck_stop', 'rest_area', 'repair')),

  CONSTRAINT facilities_name_len CHECK (char_length(name) BETWEEN 3 AND 80),

  -- Same continental-US envelope as test/tracking.test.js's own CONUS
  -- constant (`{ minLat: 24.0, maxLat: 49.5, minLon: -125.5, maxLon:
  -- -66.5 }`) and, by construction, every lane_routes (034) geometry this
  -- table's rows are placed along -- deliberately the SAME four numbers
  -- rather than a second guess at the same box, so a coordinate that
  -- would fail the map's own test can never pass this one.
  CONSTRAINT facilities_conus CHECK (
    lat BETWEEN 24.0 AND 49.5 AND lon BETWEEN -125.5 AND -66.5
  ),

  CONSTRAINT facilities_near_state_fmt CHECK (near_state ~ '^[A-Z]{2}$'),
  CONSTRAINT facilities_near_city_len CHECK (char_length(near_city) BETWEEN 2 AND 40),

  -- 'fuel' and 'truck_stop' sell fuel and must price it; 'rest_area' and
  -- 'repair' do not sell fuel and must not carry a price nobody quoted.
  -- A NULL price on a fuel stop or a priced rest area are both facts
  -- nobody generated on purpose, so both fail this constraint rather than
  -- reading as a $0.00 fill-up or a free-to-park truck stop.
  CONSTRAINT facilities_fuel_price CHECK (
    (kind IN ('fuel', 'truck_stop') AND fuel_price_cents IS NOT NULL)
    OR (kind NOT IN ('fuel', 'truck_stop') AND fuel_price_cents IS NULL)
  ),

  -- Loose backstop, not the generator's real band. The generator's actual
  -- spread is FUEL_PRICE_PER_GAL (finance.constants.js, $4.05) +/- the
  -- EIA-derived FUEL_PRICE_SPREAD_FRACTION computed in
  -- scripts/seed/facilities.js (roughly $3.66-$4.44) -- this CHECK exists
  -- only to catch a future writer that is NOT that generator (a manual
  -- INSERT, a bug that forgets to multiply by 100) inserting a price that
  -- is not a price at all, so it is deliberately much wider: $1.00-
  -- $10.00/gal covers every plausible US diesel price this project's
  -- compressed timeline could ever reach without being so tight it fights
  -- the actual generator over a market move.
  CONSTRAINT facilities_fuel_price_sane CHECK (
    fuel_price_cents IS NULL OR fuel_price_cents BETWEEN 100 AND 1000
  )
);

-- kind + near-city is the shape both listNear (a bounding radius) and the
-- board's "what's near this city" reads ask for -- near_state included so
-- the same city name in two states (there is more than one Springfield)
-- doesn't share an index entry with the wrong one.
CREATE INDEX IF NOT EXISTS idx_facilities_kind ON facilities(kind);
CREATE INDEX IF NOT EXISTS idx_facilities_near ON facilities(near_state, near_city);
