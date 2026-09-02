-- road_miles: add NULL and coordinate range guards
-- Before: NULL/invalid coords produced ~14,675 mi (antipodal distance)
-- After: NULL/invalid coords return NULL, display as "—" on board

CREATE OR REPLACE FUNCTION road_miles(
  lat1 double precision, lon1 double precision,
  lat2 double precision, lon2 double precision
) RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN lat1 IS NULL OR lon1 IS NULL OR lat2 IS NULL OR lon2 IS NULL THEN NULL
    WHEN lat1 NOT BETWEEN  -90 AND  90 OR lat2 NOT BETWEEN  -90 AND  90 THEN NULL
    WHEN lon1 NOT BETWEEN -180 AND 180 OR lon2 NOT BETWEEN -180 AND 180 THEN NULL
    ELSE 3958.8 * 1.18 * 2 * asin(least(1.0, sqrt(
      sin(radians(lat2 - lat1) / 2.0) ^ 2
      + cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lon2 - lon1) / 2.0) ^ 2
    )))
  END
$$;
