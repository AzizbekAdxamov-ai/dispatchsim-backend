-- 062: Marcus no longer says "correct?" at all.
--
-- 061 limited the read-back to once per chat, but gpt-oss-120b still closed
-- replies with "correct?" after a price or a rate (S4, 2026-10-16: "The posted
-- rate is $5,002 ... Correct?"). The read-back stays his habit, as a plain
-- sentence; the word goes. 052 and 061 are already applied and stay as they
-- were.
--
-- Two statements, for the two states a database can be in: (a) 061 applied,
-- (b) 061 changed nothing (the persona still has 052's wording). Each is
-- matched on the old text, so a persona edited by hand since is left alone,
-- and running this twice changes nothing (after it no "correct?" is left).
-- Character only: no facts and nothing the prompt forbids.

UPDATE brokers SET persona = replace(persona, 'when they tell you something that pins the plan down, you read it back in your own words and close that read-back with "correct?" -- at most once in the whole chat, only on a read-back, and never after a sentence that already asks a question. Every other reply ends like a normal sentence.', 'when they tell you something that pins the plan down, you read it back once in your own words, as a plain sentence. Every reply ends like a normal sentence.')
 WHERE name = 'Cedar Ridge Transport Services' AND persona LIKE '%correct?%';

UPDATE brokers SET persona = replace(persona, 'before you move on you read what they told you back in your own words and end with "correct?".', 'when they tell you something that pins the plan down, you read it back once in your own words, as a plain sentence. Every reply ends like a normal sentence.')
 WHERE name = 'Cedar Ridge Transport Services' AND persona LIKE '%correct?%';
