-- A trailer's size is a truck fact, not a guess from its equipment type.
-- Existing records deliberately remain unknown until a size is verified.
ALTER TABLE trucks ADD COLUMN trailer_length_ft smallint NULL;
ALTER TABLE trucks ADD CONSTRAINT trucks_trailer_length
  CHECK (trailer_length_ft IS NULL OR trailer_length_ft BETWEEN 1 AND 60);
