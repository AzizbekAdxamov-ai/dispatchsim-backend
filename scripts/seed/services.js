// The closed set of truck-maintenance service names the AI seed generator
// is allowed to use. This file exists specifically so the model never has
// to invent a service name -- a free-form name is exactly how a
// project-banned word slips in through an otherwise legitimate-sounding
// phrase (an emissions-check service is real, but one common name for it
// is not writable under the project's banned-word rule). Every name
// below has been hand-checked against that rule; see validate.js for the
// shared regex.
//
// Cost ranges are realistic 2026 US independent/fleet-shop price bands in
// whole dollars. intervalMi is the typical manufacturer/fleet mileage
// interval between services (a rough guide for due-date generation, not a
// regulatory figure -- DOT inspection's interval below is an annual
// service expressed as an equivalent yearly mileage for a regional truck,
// not a literal odometer rule).
export const SERVICES = [
  { name: 'Oil change', minCostUsd: 180, maxCostUsd: 420, intervalMi: 25000 },
  { name: 'Brake system inspection', minCostUsd: 150, maxCostUsd: 350, intervalMi: 25000 },
  { name: 'Tire rotation', minCostUsd: 80, maxCostUsd: 180, intervalMi: 15000 },
  { name: 'Annual DOT inspection', minCostUsd: 200, maxCostUsd: 450, intervalMi: 60000 },
  { name: 'Battery check', minCostUsd: 40, maxCostUsd: 120, intervalMi: 20000 },
  { name: 'DPF cleaning', minCostUsd: 400, maxCostUsd: 900, intervalMi: 100000 },
  { name: 'Transmission service', minCostUsd: 350, maxCostUsd: 750, intervalMi: 60000 },
  { name: 'Coolant flush', minCostUsd: 150, maxCostUsd: 300, intervalMi: 100000 },
  { name: 'Air filter replacement', minCostUsd: 60, maxCostUsd: 150, intervalMi: 20000 },
  { name: 'Wheel alignment', minCostUsd: 120, maxCostUsd: 250, intervalMi: 30000 },
  { name: 'Suspension inspection', minCostUsd: 100, maxCostUsd: 300, intervalMi: 25000 },
  { name: 'Clutch adjustment', minCostUsd: 150, maxCostUsd: 400, intervalMi: 40000 },
  { name: 'Differential service', minCostUsd: 200, maxCostUsd: 450, intervalMi: 50000 },
  { name: 'Fifth-wheel lubrication', minCostUsd: 50, maxCostUsd: 150, intervalMi: 10000 },
  { name: 'Trailer light repair', minCostUsd: 80, maxCostUsd: 250, intervalMi: 15000 },
  { name: 'Windshield replacement', minCostUsd: 350, maxCostUsd: 900, intervalMi: 150000 },
  { name: 'Turbocharger inspection', minCostUsd: 200, maxCostUsd: 500, intervalMi: 50000 },
  { name: 'Fuel filter replacement', minCostUsd: 100, maxCostUsd: 250, intervalMi: 20000 },
  { name: 'A/C service', minCostUsd: 150, maxCostUsd: 400, intervalMi: 30000 },
  { name: 'Steering-system inspection', minCostUsd: 120, maxCostUsd: 300, intervalMi: 30000 },
]

export const SERVICE_NAMES = SERVICES.map((s) => s.name)
