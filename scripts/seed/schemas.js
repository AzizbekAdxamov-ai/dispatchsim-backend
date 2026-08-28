// Zod validation schemas for AI-generated seed rows. Every object the AI
// returns is parsed against one of these before it can reach render.js --
// `.strict()` so an unexpected extra key from the model fails loudly
// instead of silently riding along into the database.
//
// EQUIPMENT_KEYS is imported, not redeclared: src/constants/equipment.js
// is the backend's single source of truth for those keys (mirrors
// `loads_equipment` CHECK in migration 007), and duplicating the list
// here would just create a second copy that can drift out of sync.
import { z } from 'zod'
import { EQUIPMENT_KEYS } from '../../src/constants/equipment.js'
import { SERVICE_NAMES } from './services.js'

// Brokers the AI is allowed to attribute a load to. Kept as a closed list
// (like EQUIPMENT_KEYS) so the model can't invent a broker name that
// looks real but isn't -- there's no upstream source of truth for this
// one yet, so it's defined here.
export const BROKERS = [
  'XPO Logistics',
  'TQL',
  'Coyote Logistics',
  'Landstar',
  'C.H. Robinson',
  'Echo Global',
  'RXO',
  'Werner',
  'Schneider',
  'J.B. Hunt',
]

const stateCode = z.string().regex(/^[A-Z]{2}$/)

export const LoadItem = z
  .object({
    originCity: z.string(),
    originState: stateCode,
    destinationCity: z.string(),
    destinationState: stateCode,
    broker: z.enum(BROKERS),
    commodity: z.string().min(3).max(60),
    equipmentType: z.enum(EQUIPMENT_KEYS),
    weightLbs: z.number().int().min(1000).max(45000),
    // Market band, not the DB's wider CHECK range -- keeps AI output
    // inside plausible real-world rates so downstream rate*distance
    // math doesn't need to fight the loads_rpm_band constraint.
    ratePerMile: z.number().min(1.2).max(4.0),
  })
  .strict()

export const DriverItem = z
  .object({
    fullName: z.string().min(3).max(120),
    phone: z.string(),
    email: z.string().email(),
    homeBaseCity: z.string(),
    homeBaseState: stateCode,
    // Narrower than the DB's own cdl_class CHECK ('A','B','C'): Class C
    // is a light-vehicle CDL that doesn't fit this project's freight
    // trucks, so the generator is never asked to produce one.
    cdlClass: z.enum(['A', 'B']),
  })
  .strict()

export const TruckItem = z
  .object({
    make: z.string().min(2).max(60),
    model: z.string().min(1).max(60),
    year: z.number().int().min(2015).max(2026),
  })
  .strict()

export const MaintenanceItem = z
  .object({
    service: z.enum(SERVICE_NAMES),
    notes: z.string().min(3).max(120),
  })
  .strict()
