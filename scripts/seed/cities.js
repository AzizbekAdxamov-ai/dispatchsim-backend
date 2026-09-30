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

  // --- 2026-09-23: every lower-48 state plus DC ---
  //
  // The first 61 entries above were the hubs the load board needed to
  // exist; they left 13 states with no pickup or delivery point at all,
  // so a dispatcher in training never saw a load to Vermont, the Dakotas
  // or West Virginia. These fill the gaps and thicken the corridors that
  // were already there.
  //
  // Coordinates: city-center lat/lon from plotly/datasets
  // `us-cities-top-1k.csv` (2026-09-23), rounded to the 4 decimal places
  // the rows above use -- about 30 feet, far finer than the city-center
  // approximation itself. Every one was checked against the Census state
  // boundary it claims (see test/cities.test.js) rather than trusted.

  // Northeast
  { city: 'New York', state: 'NY', lat: 40.7128, lon: -74.0059 },
  { city: 'Syracuse', state: 'NY', lat: 43.0481, lon: -76.1474 },
  { city: 'Albany', state: 'NY', lat: 42.6526, lon: -73.7562 },
  { city: 'Scranton', state: 'PA', lat: 41.4090, lon: -75.6624 },
  { city: 'Erie', state: 'PA', lat: 42.1292, lon: -80.0851 },
  { city: 'Trenton', state: 'NJ', lat: 40.2171, lon: -74.7429 },
  { city: 'Worcester', state: 'MA', lat: 42.2626, lon: -71.8023 },
  { city: 'Providence', state: 'RI', lat: 41.8240, lon: -71.4128 },
  { city: 'Hartford', state: 'CT', lat: 41.7637, lon: -72.6851 },
  { city: 'New Haven', state: 'CT', lat: 41.3083, lon: -72.9279 },
  { city: 'Manchester', state: 'NH', lat: 42.9956, lon: -71.4548 },
  { city: 'Portland', state: 'ME', lat: 43.6615, lon: -70.2553 },
  { city: 'Burlington', state: 'VT', lat: 44.4759, lon: -73.2121 },

  // Mid-Atlantic
  { city: 'Wilmington', state: 'DE', lat: 39.7391, lon: -75.5398 },
  { city: 'Dover', state: 'DE', lat: 39.1582, lon: -75.5244 },
  { city: 'Washington', state: 'DC', lat: 38.9072, lon: -77.0369 },
  { city: 'Hagerstown', state: 'MD', lat: 39.6418, lon: -77.7200 },
  { city: 'Norfolk', state: 'VA', lat: 36.8508, lon: -76.2859 },
  { city: 'Roanoke', state: 'VA', lat: 37.2710, lon: -79.9414 },
  { city: 'Charleston', state: 'WV', lat: 38.3498, lon: -81.6326 },
  { city: 'Huntington', state: 'WV', lat: 38.4192, lon: -82.4452 },

  // Southeast
  { city: 'Raleigh', state: 'NC', lat: 35.7796, lon: -78.6382 },
  { city: 'Winston-Salem', state: 'NC', lat: 36.0999, lon: -80.2442 },
  { city: 'Charleston', state: 'SC', lat: 32.7765, lon: -79.9311 },
  { city: 'Columbia', state: 'SC', lat: 34.0007, lon: -81.0348 },
  { city: 'Greenville', state: 'SC', lat: 34.8526, lon: -82.3940 },
  { city: 'Macon', state: 'GA', lat: 32.8407, lon: -83.6324 },
  { city: 'Augusta', state: 'GA', lat: 33.4735, lon: -82.0105 },
  { city: 'Tampa', state: 'FL', lat: 27.9506, lon: -82.4572 },
  { city: 'Lakeland', state: 'FL', lat: 28.0395, lon: -81.9498 },
  { city: 'Montgomery', state: 'AL', lat: 32.3668, lon: -86.3000 },
  { city: 'Huntsville', state: 'AL', lat: 34.7304, lon: -86.5861 },
  { city: 'Gulfport', state: 'MS', lat: 30.3674, lon: -89.0928 },
  { city: 'Knoxville', state: 'TN', lat: 35.9606, lon: -83.9207 },
  { city: 'Chattanooga', state: 'TN', lat: 35.0456, lon: -85.3097 },
  { city: 'Lexington', state: 'KY', lat: 38.0406, lon: -84.5037 },
  { city: 'Baton Rouge', state: 'LA', lat: 30.4583, lon: -91.1403 },
  { city: 'Shreveport', state: 'LA', lat: 32.5252, lon: -93.7502 },
  { city: 'Fort Smith', state: 'AR', lat: 35.3859, lon: -94.3985 },

  // Midwest
  { city: 'Dayton', state: 'OH', lat: 39.7589, lon: -84.1916 },
  { city: 'Akron', state: 'OH', lat: 41.0814, lon: -81.5190 },
  { city: 'Fort Wayne', state: 'IN', lat: 41.0793, lon: -85.1394 },
  { city: 'Evansville', state: 'IN', lat: 37.9716, lon: -87.5711 },
  { city: 'Grand Rapids', state: 'MI', lat: 42.9634, lon: -85.6681 },
  { city: 'Lansing', state: 'MI', lat: 42.7325, lon: -84.5555 },
  { city: 'Rockford', state: 'IL', lat: 42.2711, lon: -89.0940 },
  { city: 'Peoria', state: 'IL', lat: 40.6936, lon: -89.5890 },
  { city: 'Springfield', state: 'IL', lat: 39.7817, lon: -89.6501 },
  { city: 'Madison', state: 'WI', lat: 43.0731, lon: -89.4012 },
  { city: 'Green Bay', state: 'WI', lat: 44.5192, lon: -88.0198 },
  { city: 'St. Paul', state: 'MN', lat: 44.9537, lon: -93.0900 },
  { city: 'Duluth', state: 'MN', lat: 46.7867, lon: -92.1005 },
  { city: 'Cedar Rapids', state: 'IA', lat: 41.9779, lon: -91.6656 },
  { city: 'Davenport', state: 'IA', lat: 41.5236, lon: -90.5776 },
  { city: 'Springfield', state: 'MO', lat: 37.2090, lon: -93.2923 },

  // Plains and Mountain West
  { city: 'Wichita', state: 'KS', lat: 37.6889, lon: -97.3361 },
  { city: 'Topeka', state: 'KS', lat: 39.0558, lon: -95.6890 },
  { city: 'Lincoln', state: 'NE', lat: 40.8258, lon: -96.6852 },
  { city: 'Sioux Falls', state: 'SD', lat: 43.5446, lon: -96.7311 },
  { city: 'Rapid City', state: 'SD', lat: 44.0805, lon: -103.2310 },
  { city: 'Fargo', state: 'ND', lat: 46.8772, lon: -96.7898 },
  { city: 'Bismarck', state: 'ND', lat: 46.8083, lon: -100.7837 },
  { city: 'Billings', state: 'MT', lat: 45.7833, lon: -108.5007 },
  { city: 'Missoula', state: 'MT', lat: 46.8787, lon: -113.9966 },
  { city: 'Great Falls', state: 'MT', lat: 47.4942, lon: -111.2833 },
  { city: 'Cheyenne', state: 'WY', lat: 41.1400, lon: -104.8202 },
  { city: 'Casper', state: 'WY', lat: 42.8666, lon: -106.3131 },
  { city: 'Colorado Springs', state: 'CO', lat: 38.8339, lon: -104.8214 },
  { city: 'Grand Junction', state: 'CO', lat: 39.0639, lon: -108.5506 },
  { city: 'Ogden', state: 'UT', lat: 41.2230, lon: -111.9738 },
  { city: 'St. George', state: 'UT', lat: 37.0965, lon: -113.5684 },
  { city: 'Idaho Falls', state: 'ID', lat: 43.4917, lon: -112.0340 },

  // Southwest
  { city: 'Flagstaff', state: 'AZ', lat: 35.1983, lon: -111.6513 },
  { city: 'Las Cruces', state: 'NM', lat: 32.3199, lon: -106.7637 },
  { city: 'Fort Worth', state: 'TX', lat: 32.7555, lon: -97.3308 },
  { city: 'Austin', state: 'TX', lat: 30.2672, lon: -97.7431 },
  { city: 'Amarillo', state: 'TX', lat: 35.2220, lon: -101.8313 },
  { city: 'Lubbock', state: 'TX', lat: 33.5779, lon: -101.8552 },

  // West Coast
  { city: 'Sacramento', state: 'CA', lat: 38.5816, lon: -121.4944 },
  { city: 'Bakersfield', state: 'CA', lat: 35.3733, lon: -119.0187 },
  { city: 'Stockton', state: 'CA', lat: 37.9577, lon: -121.2908 },
  { city: 'Tacoma', state: 'WA', lat: 47.2529, lon: -122.4443 },
  { city: 'Yakima', state: 'WA', lat: 46.6021, lon: -120.5059 },
  { city: 'Salem', state: 'OR', lat: 44.9429, lon: -123.0351 },
  { city: 'Eugene', state: 'OR', lat: 44.0521, lon: -123.0868 },
  { city: 'Medford', state: 'OR', lat: 42.3265, lon: -122.8756 },
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
