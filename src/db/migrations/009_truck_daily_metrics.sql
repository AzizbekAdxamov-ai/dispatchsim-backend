-- Kunlik telemetriya. TruckDetail.jsx ning yarmi shu yerdan oziqlanadi:
-- weeklyDistance, mpg, idleHours, fuelTrend[], weeklyDistanceTrend[],
-- costBreakdown[] va ularning deltaPct/up koʻrsatkichlari — hammasi
-- shu jadval ustidagi agregatsiya. Dashboard'ning utilizationTrend[] ham.
--
-- mpg ATAYLAB saqlanmaydi: u distance/gallons dan chiqadi va alohida
-- saqlansa ikkisi bir-biriga zid boʻlib qolishi mumkin.
CREATE TABLE IF NOT EXISTS truck_daily_metrics (
  truck_id     text     NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
  day          date     NOT NULL,
  distance_mi  integer  NOT NULL DEFAULT 0,
  fuel_gallons integer  NOT NULL DEFAULT 0,
  idle_minutes integer  NOT NULL DEFAULT 0,
  fuel_pct_end smallint NOT NULL,

  PRIMARY KEY (truck_id, day),

  CONSTRAINT tdm_distance CHECK (distance_mi  BETWEEN 0 AND 900),
  CONSTRAINT tdm_gallons  CHECK (fuel_gallons BETWEEN 0 AND 250),
  CONSTRAINT tdm_idle     CHECK (idle_minutes BETWEEN 0 AND 1440),
  CONSTRAINT tdm_fuel_pct CHECK (fuel_pct_end BETWEEN 0 AND 100),
  -- Yoqilgʻi sarflanmasdan yurib boʻlmaydi (mpg cheksizga ketmasin).
  CONSTRAINT tdm_mpg_sane CHECK (distance_mi = 0 OR fuel_gallons > 0)
);

CREATE INDEX IF NOT EXISTS tdm_day_idx ON truck_daily_metrics (day DESC);
