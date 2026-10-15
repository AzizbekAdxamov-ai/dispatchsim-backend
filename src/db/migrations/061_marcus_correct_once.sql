-- 061: Marcus no longer ends every reply with "correct?".
--
-- Eval 2026-10-15: gpt-oss-120b read 052's "end with "correct?"" as a rule
-- for every message, so every reply ended with it -- even right after a
-- question, and with nothing to read back. 052 is already applied and
-- stays as it was.
--
-- The read-back stays his habit, but it is now tied to a moment (the
-- carrier pinned the plan down), capped at once per chat, and barred after
-- a sentence that already asks something. Every other reply ends normally.
--
-- Matched on the old phrase, so a persona edited by hand since is left
-- alone, and running this twice changes nothing. Character only: no
-- facts and nothing the prompt forbids.

UPDATE brokers SET persona = replace(persona, 'before you move on you read what they told you back in your own words and end with "correct?".', 'when they tell you something that pins the plan down, you read it back in your own words and close that read-back with "correct?" -- at most once in the whole chat, only on a read-back, and never after a sentence that already asks a question. Every other reply ends like a normal sentence.')
 WHERE name = 'Cedar Ridge Transport Services' AND persona LIKE '%end with "correct?"%';
