// The daily vehicle inspection report (DVIR), as vocabulary and rule --
// 49 CFR 396.11 (the report) and 396.13 (the next driver's
// certification).
//
// The law's list is long (brakes, coupling devices, fire extinguishers,
// ...); what belongs in code is the CLOSED vocabulary those items are
// named by, the seed that turns a finished run into a report, and the
// certification rule the next driver's sign-off answers to. Nothing here
// touches the database -- the delivery transaction calls seedReport and
// writes what it returns, the same way repositioning.js's block is
// computed pure and written inside the transaction.

// The checklist, in the order the report lists it. `key` is the column
// suffix on dvir_reports (brakes_ok, lights_ok, ...); `label` is the
// frontend's vocabulary -- the backend never ships display text (qoida:
// hardcoded UI matni yoʻq), the page maps key -> label exactly like
// equipmentType does.
export const DVIR_ITEMS = [
  { key: 'brakes', label: 'Brakes', cfr: '49 CFR 393.40' },
  { key: 'lights', label: 'Lights and reflectors', cfr: '49 CFR 393.9' },
  { key: 'tires', label: 'Tires', cfr: '49 CFR 393.75' },
  { key: 'steering', label: 'Steering', cfr: '49 CFR 393.209' },
  { key: 'coupling', label: 'Coupling devices', cfr: '49 CFR 393.70' },
  { key: 'horn', label: 'Horn', cfr: '49 CFR 393.81' },
  { key: 'wipers', label: 'Windshield wipers', cfr: '49 CFR 393.78' },
  { key: 'mirrors', label: 'Mirrors', cfr: '49 CFR 393.80' },
  { key: 'emergencyEq', label: 'Emergency equipment', cfr: '49 CFR 393.95' },
]

export const DVIR_ITEM_KEYS = DVIR_ITEMS.map((i) => i.key)

// Wear writes a DEFECT, not an opinion. Two rules, both from numbers the
// truck already carries:
//
//   Tires: the inspection finds what a tread gauge finds. A steer tire
//   below 4/32" is out of service on a bus and below 2/32" on a truck
//   (393.75(c)); the sim's percentage-of-tread model maps to that at
//   25% of a 125,000 mi / 100,000 mi life -- the same boundary
//   truckWear.js's own constants define. Below it, the report records a
//   defect; between it and 35%, the report records the wear so the next
//   service decision sees it coming.
//
//   The coupling/lights/horn rule the same shape follows: nothing is
//   invented -- a run ending with the truck OUT of fuel, a load lost, or
//   a breakdown wait is where a real driver writes something down.
export const TIRE_DEFECT_THRESHOLD_PCT = 25
export const TIRE_WEAR_NOTE_THRESHOLD_PCT = 35

// The seeded report for one finished run. `truck` is the post-delivery
// row (odometer, tire gauges), `rng` decides which of the INDEPENDENT
// small items -- horn, wipers, mirrors, emergency equipment -- failed
// this time, at the rate real roadside inspections find them: rarely,
// and never all at once. Brakes, lights, tires, steering and coupling
// are never randomly failed: they are either below a threshold the
// gauges prove, or they are fine -- a random brake failure would be a
// die roll wearing a regulation's clothes.
export function seedReport({ rng, truck, hadBreakdown = false }) {
  // Two lists, and the difference between them is the whole rule: a DEFECT
  // is a failed item -- it creates the correction duty and holds the truck;
  // a NOTE is an observation the gauges or the road produced -- it travels
  // with the report for the next service decision and holds nothing.
  // Writing notes into the defect list made the database hold a legal
  // truck on paperwork (and, with the CHECK that pairs corrected=true with
  // a non-empty list, turned every defect-bearing delivery into a
  // constraint violation -- found live in the tick log, 2026-09-25).
  const defects = []
  const notes = []

  const items = {}
  for (const item of DVIR_ITEM_KEYS) items[item] = true

  // Tires, read off the gauges the delivery just wrote.
  if (truck.tireFrontPct < TIRE_DEFECT_THRESHOLD_PCT || truck.tireRearPct < TIRE_DEFECT_THRESHOLD_PCT) {
    items.tires = false
    defects.push({
      item: 'tires',
      detail: truck.tireFrontPct < truck.tireRearPct
        ? `Steer tread below ${TIRE_DEFECT_THRESHOLD_PCT}%`
        : `Drive tread below ${TIRE_DEFECT_THRESHOLD_PCT}%`,
    })
  } else if (truck.tireFrontPct < TIRE_WEAR_NOTE_THRESHOLD_PCT || truck.tireRearPct < TIRE_WEAR_NOTE_THRESHOLD_PCT) {
    notes.push({
      item: 'tires',
      detail: `Tread below ${TIRE_WEAR_NOTE_THRESHOLD_PCT}% -- schedule replacement`,
    })
  }

  // The independent small items: the only dice the report rolls, and
  // loaded the way inspections actually land -- mostly nothing.
  const SMALL_FAILURE_RATE = 0.03
  for (const key of ['horn', 'wipers', 'mirrors', 'emergencyEq']) {
    if (rng() < SMALL_FAILURE_RATE) {
      items[key] = false
      defects.push({ item: key, detail: 'Not working at the post-trip walk-around' })
    }
  }

  // A breakdown the run actually met is a note the driver would write --
  // a fact that happened, never a new failure invented at inspection.
  if (hadBreakdown) {
    notes.push({ item: 'steering', detail: 'Steering felt stiff after the roadside repair -- watched' })
  }

  // 396.11(a): a report with DEFECTS stays with the vehicle until they
  // are fixed. A FAILED item creates the correction duty; a wear NOTE
  // (tread between the note and defect thresholds) rides in its own list
  // so the next service decision sees it coming, but it neither holds the
  // truck nor counts toward the certification pair.
  const hasDefects = Object.values(items).some((ok) => !ok)

  return { items, defects, notes, hasDefects }
}

// 396.13(b)(2): the next driver reviews the last report. If it lists
// defects and they are certified as fixed, the certification is recorded
// and the report's correction flag clears; if they are NOT fixed, the
// driver refuses the certification -- which in this program is the
// refusal endpoint's job to carry. This function is only the DECISION:
// can this report be certified by this driver, yes or no, with the rule
// named.
export function certificationDecision(report) {
  if (!report) return { allowed: true, reason: null, cfr: null }
  if (report.defects.length === 0) return { allowed: true, reason: null, cfr: null }
  if (report.defectsCorrected) return { allowed: true, reason: null, cfr: null }
  return {
    allowed: false,
    reason: 'The last report lists defects nobody has certified as fixed',
    cfr: '49 CFR 396.13(b)(2)',
  }
}
