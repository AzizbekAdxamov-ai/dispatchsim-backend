-- 054: drivers.preferences -- the runs a driver has asked not to be given.
--
-- The concept document (Dispatch_Simulator_Toliq_Konsepsiya, sections 24-25)
-- and Azizbek (2026-10-02): a dispatcher manages a person, not a truck.
-- A driver who will not go into New York City is a fact the dispatcher
-- is supposed to know -- and the highest rate on the board is not the
-- right load if it ends in the one place she will not drive.
--
-- A jsonb object, not columns, because the kinds of request grow (places
-- now; home time and night driving are next in the concept) and each is
-- read by one function, src/constants/driverPreferences.js, which takes
-- what it understands and ignores the rest. The CHECK only insists on an
-- object, so a malformed value is refused rather than half-read.
--
-- Nothing is enforced. A request is shown to the dispatcher before
-- dispatch (dispatch-check, as a warning line) and the driver knows her
-- own: dispatch her there anyway and she says what she thinks. The
-- decision stays with the student, and so does the consequence.

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE drivers DROP CONSTRAINT IF EXISTS drivers_preferences_object;
ALTER TABLE drivers ADD CONSTRAINT drivers_preferences_object CHECK (jsonb_typeof(preferences) = 'object');

-- Grace Lindqvist, Azizbek's one fixed driver (051). One request, the
-- most common one a dispatcher hears, in her own reason. By name, like
-- 051: the seed owns the ids.
UPDATE drivers
   SET preferences = '{
     "avoidCities": [{ "city": "New York", "state": "NY" }],
     "why": "She will not take the truck into New York City: no room to turn, nowhere legal to park, and a ticket every time."
   }'::jsonb
 WHERE name = 'Grace Lindqvist' AND preferences = '{}'::jsonb;
