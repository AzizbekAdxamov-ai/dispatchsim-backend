-- 057: Grace's bio no longer says she "looks" when she does not know.
--
-- 051 wrote that she says "let me look" when she does not know yet. The
-- driver prompt now forbids every promise to look, check or get back (she
-- cannot act later; the dispatcher is left waiting), and a bio line that
-- says the opposite is the likeliest source of the "Let me look." replies
-- on 2026-10-12 (ED02, ED10). One row, one phrase; 051 is already applied
-- and stays as it was.
--
-- Matched on the old phrase, so a bio that was edited by hand since is
-- left alone, and running this twice changes nothing. No other driver's
-- bio or seed text carries a promise phrase.

UPDATE drivers
   SET bio = replace(bio, '"let me look" when she does not
  know yet', '"no idea" when she does not know')
 WHERE name = 'Grace Lindqvist' AND bio LIKE '%"let me look" when she does not%';
