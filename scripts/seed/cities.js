// Real US freight hubs with real coordinates, used as the closed set the
// AI seed generator picks origins/destinations from. This is why it's a
// hand-checked data file instead of something the AI invents on the fly:
// a wrong latitude here produces a plausible-looking but wrong mileage
// that nobody downstream would ever catch.
//
// Coordinates are city-center lat/lon to 4 decimal places (standard
// public reference values), not exact freight-terminal addresses --
// good enough for great-circle distance estimates, not for routing.
export const CITIES = [
  // Texas
  { city: 'Dallas', state: 'TX', lat: 32.7767, lon: -96.7970 },
  { city: 'Houston', state: 'TX', lat: 29.7604, lon: -95.3698 },
  { city: 'San Antonio', state: 'TX', lat: 29.4241, lon: -98.4936 },
  { city: 'El Paso', state: 'TX', lat: 31.7619, lon: -106.4850 },
  { city: 'Laredo', state: 'TX', lat: 27.5306, lon: -99.4803 },

  // California
  { city: 'Los Angeles', state: 'CA', lat: 34.0522, lon: -118.2437 },
  { city: 'Oakland', state: 'CA', lat: 37.8044, lon: -122.2712 },
  { city: 'Fresno', state: 'CA', lat: 36.7378, lon: -119.7871 },
  { city: 'Ontario', state: 'CA', lat: 34.0633, lon: -117.6509 },
  { city: 'San Diego', state: 'CA', lat: 32.7157, lon: -117.1611 },

  // Midwest
  { city: 'Chicago', state: 'IL', lat: 41.8781, lon: -87.6298 },
  { city: 'Joliet', state: 'IL', lat: 41.5250, lon: -88.0817 },
  { city: 'Columbus', state: 'OH', lat: 39.9612, lon: -82.9988 },
  { city: 'Indianapolis', state: 'IN', lat: 39.7684, lon: -86.1581 },
  { city: 'Detroit', state: 'MI', lat: 42.3314, lon: -83.0458 },
  { city: 'Kansas City', state: 'MO', lat: 39.0997, lon: -94.5786 },
  { city: 'St. Louis', state: 'MO', lat: 38.6270, lon: -90.1994 },
  { city: 'Minneapolis', state: 'MN', lat: 44.9778, lon: -93.2650 },
  { city: 'Milwaukee', state: 'WI', lat: 43.0389, lon: -87.9065 },

  // Southeast
  { city: 'Atlanta', state: 'GA', lat: 33.7490, lon: -84.3880 },
  { city: 'Memphis', state: 'TN', lat: 35.1495, lon: -90.0490 },
  { city: 'Nashville', state: 'TN', lat: 36.1627, lon: -86.7816 },
  { city: 'Charlotte', state: 'NC', lat: 35.2271, lon: -80.8431 },
  { city: 'Jacksonville', state: 'FL', lat: 30.3322, lon: -81.6557 },
  { city: 'Miami', state: 'FL', lat: 25.7617, lon: -80.1918 },
  { city: 'Orlando', state: 'FL', lat: 28.5383, lon: -81.3792 },
  { city: 'Savannah', state: 'GA', lat: 32.0809, lon: -81.0912 },
  { city: 'Birmingham', state: 'AL', lat: 33.5186, lon: -86.8104 },

  // Northeast
  { city: 'Newark', state: 'NJ', lat: 40.7357, lon: -74.1724 },
  { city: 'Allentown', state: 'PA', lat: 40.6084, lon: -75.4902 },
  { city: 'Harrisburg', state: 'PA', lat: 40.2732, lon: -76.8867 },
  { city: 'Boston', state: 'MA', lat: 42.3601, lon: -71.0589 },
  { city: 'Philadelphia', state: 'PA', lat: 39.9526, lon: -75.1652 },
  { city: 'Baltimore', state: 'MD', lat: 39.2904, lon: -76.6122 },

  // Mountain West
  { city: 'Denver', state: 'CO', lat: 39.7392, lon: -104.9903 },
  { city: 'Salt Lake City', state: 'UT', lat: 40.7608, lon: -111.8910 },
  { city: 'Phoenix', state: 'AZ', lat: 33.4484, lon: -112.0740 },
  { city: 'Albuquerque', state: 'NM', lat: 35.0844, lon: -106.6504 },
  { city: 'Las Vegas', state: 'NV', lat: 36.1699, lon: -115.1398 },

  // Northwest
  { city: 'Seattle', state: 'WA', lat: 47.6062, lon: -122.3321 },
  { city: 'Portland', state: 'OR', lat: 45.5152, lon: -122.6784 },
  { city: 'Spokane', state: 'WA', lat: 47.6588, lon: -117.4260 },

  // Remaining regional hubs
  { city: 'Oklahoma City', state: 'OK', lat: 35.4676, lon: -97.5164 },
  { city: 'Little Rock', state: 'AR', lat: 34.7465, lon: -92.2896 },
  { city: 'New Orleans', state: 'LA', lat: 29.9511, lon: -90.0715 },
  { city: 'Louisville', state: 'KY', lat: 38.2527, lon: -85.7585 },
  { city: 'Cincinnati', state: 'OH', lat: 39.1031, lon: -84.5120 },
  { city: 'Cleveland', state: 'OH', lat: 41.4993, lon: -81.6944 },
  { city: 'Pittsburgh', state: 'PA', lat: 40.4406, lon: -79.9959 },
  { city: 'Buffalo', state: 'NY', lat: 42.8864, lon: -78.8784 },
  { city: 'Richmond', state: 'VA', lat: 37.5407, lon: -77.4360 },
  { city: 'Greensboro', state: 'NC', lat: 36.0726, lon: -79.7920 },
  { city: 'Tulsa', state: 'OK', lat: 36.1540, lon: -95.9928 },
  { city: 'Omaha', state: 'NE', lat: 41.2565, lon: -95.9345 },
  { city: 'Des Moines', state: 'IA', lat: 41.5868, lon: -93.6250 },
  { city: 'Toledo', state: 'OH', lat: 41.6528, lon: -83.5379 },
  { city: 'Reno', state: 'NV', lat: 39.5296, lon: -119.8138 },
  { city: 'Boise', state: 'ID', lat: 43.6150, lon: -116.2023 },
  { city: 'Tucson', state: 'AZ', lat: 32.2226, lon: -110.9747 },
  { city: 'Jackson', state: 'MS', lat: 32.2988, lon: -90.1848 },
  { city: 'Mobile', state: 'AL', lat: 30.6954, lon: -88.0399 },
]

export const CITY_KEYS = new Set(CITIES.map((c) => `${c.city}, ${c.state}`))

// Exact match on (city, state) -- the AI is expected to echo back one of
// CITIES verbatim, not invent a new place, so no fuzzy matching here.
export function findCity(city, state) {
  return CITIES.find((c) => c.city === city && c.state === state) || null
}

// Great-circle distance in miles between two {lat, lon} points (haversine
// formula). This is a straight-line lower bound, not a road distance --
// see roadMiles() for the number that actually gets stored.
const EARTH_RADIUS_MI = 3958.8

function toRadians(deg) {
  return (deg * Math.PI) / 180
}

export function haversineMi(a, b) {
  const dLat = toRadians(b.lat - a.lat)
  const dLon = toRadians(b.lon - a.lon)
  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)))
  return EARTH_RADIUS_MI * c
}

// Straight-line distance undercounts actual highway miles (roads aren't
// great circles). 1.18 is a commonly used rule-of-thumb road/great-circle
// ratio for US interstate freight lanes -- rough, but far closer to a
// real dispatcher's mileage than the raw haversine number would be.
export function roadMiles(a, b) {
  return Math.round(haversineMi(a, b) * 1.18)
}
