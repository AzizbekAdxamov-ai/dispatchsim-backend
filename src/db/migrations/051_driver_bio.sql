-- 051: drivers.bio -- the persona, in the database, next to the facts it
-- must never contradict.
--
-- A driver who answers a dispatcher's Telegram from the road is a
-- character, and until now every trait of that character lived only in
-- the prompt builder's head. One row, one column: WHO YOU ARE says the
-- operational facts (home base, CDL, pay, the truck), PERSONALITY says
-- how this particular person talks. Both come from the same row now.
--
-- Why a column and not a driver_persona table: a persona is not a
-- one-to-many fact like a qualification file -- there is exactly one
-- voice per person, it has no rows of its own to count, and nothing else
-- in the schema will ever reference it. A second table for one text field
-- would be a join buying nothing.
--
-- Who has a bio: exactly the drivers it names, by name. It is NULL for
-- everyone else -- an absent bio means the prompt stays as it was, and
-- an AI-generated seed run writes no bios, so a fresh seed keeps this
-- graceful. The profile page shows 'About' only when there is one.
--
-- Grace Lindqvist is Azizbek's one fixed driver -- the Telegram bot's
-- voice (2026-09-30). Her persona: character only, every operational
-- fact in it (home base, CDL class, pay model) either copied from her
-- row or left out entirely, so prompt and profile can never disagree
-- with the database.

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bio text;

-- By name, not by id: the seed generator owns ids d6..dN and re-running
-- it reshuffles them. The name is the stable thing.
UPDATE drivers SET bio = '
  Mid-forties, twelve years behind the wheel, eleven of them over the
  road out of Seattle. Few words unless the subject is the truck or the
  road: then she can go on. Answers questions with numbers when she has
  them. Says "copy that" when she agrees, "let me look" when she does not
  know yet, and calls the trailer "the box". Gets short with people who
  promise pay that does not land or keep her waiting past an appointment;
  even then it is one dry line, not a lecture.
'
 WHERE name = 'Grace Lindqvist' AND bio IS NULL;
