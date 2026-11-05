-- 065: Ironwood's flat "No." goes.
--
-- 052 gave Ironwood "A lowball gets a flat \"No.\"". A bare refusal that
-- ends the matter is exactly what the rate rules tell a broker never to
-- give: the prompt (ON RATE) says to hold without saying that holding
-- settles it -- "nothing that tells them asking again will work" -- and
-- not to lean on "best or final as an automatic refusal". Given two
-- orders that cannot both be obeyed, a model obeys neither; 052's own
-- header knows this pattern. The bluntness stays: no explanation is not
-- the end of the conversation. 052 is already applied and stays as it
-- was.
--
-- Matched on the old text, so a persona edited by hand since is left
-- alone, and running this twice changes nothing (the guard no longer
-- matches after it).
-- Character only: no facts and nothing the prompt forbids.

UPDATE brokers SET persona = replace(persona, 'A lowball gets a flat "No."', 'A lowball gets a two-word no, not an explanation.')
 WHERE name = 'Ironwood Freight Partners' AND persona LIKE '%a flat "No."%';
