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
import { RATE_ABSOLUTE_MAX } from './validate.js'

// Brokers the AI is allowed to attribute a load to. Closed list (like
// EQUIPMENT_KEYS) so the model can't invent one.
//
// Every name here is INVENTED. That is deliberate, not a placeholder: the
// app attaches an MC number, a credit rating and payment behaviour to each
// broker, and doing that to a real company would mean stating false,
// damaging facts about a real business. These names must stay in sync with
// migration 013_brokers.sql, which is the source of truth for their MC
// numbers and ratings.
export const BROKERS = [
  'Harbor Line Freight Exchange',
  'Cedar Ridge Transport Services',
  'Ironwood Freight Partners',
  'Northgate Cargo Solutions',
  'Blue Meridian Logistics Group',
  'Stonebridge Carrier Network',
  'Sunbelt Freight Alliance',
  'Pioneer Valley Transport Co',
  'Redstone Logistics Partners',
  'Copperfield Freight Group',
  'Marshfield Cargo Brokers',
  'Tidewater Merchant Freight',
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
    // Bounds taken from validate.js's own multipliers, not typed here.
    //
    // These used to read .min(1.2).max(4.0) while rateBandFor() could
    // return 4.375 for a short-haul tanker -- a rate the pricing model
    // considers correct and this schema rejected. The AI path never hit it
    // because it parses BEFORE the clamp: the model was told 1.2-4.0,
    // obeyed, and the clamp raised the value afterwards. Generating from
    // the band directly walked straight into it, 18 times in 50,000.
    //
    // The floor stays below the band's own minimum on purpose: a model
    // proposing a cheap rate should be clamped up, not dropped.
    ratePerMile: z.number().min(1.2).max(RATE_ABSOLUTE_MAX),
    // Whether the board prints the rate. Optional so the AI path -- which
    // never produced this field -- still parses; absent means shown.
    rateHidden: z.boolean().optional(),
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

export const ENDORSEMENTS = ['hazmat', 'tanker', 'doubles']

export const ApplicantItem = z
  .object({
    fullName:            z.string().min(2).max(120),
    email:               z.string().email(),
    phone:               z.string().min(7).max(24),
    cdlClass:            z.enum(['A', 'B']),
    cdlState:            z.string().length(2),
    yearsExperience:     z.number().int().min(0).max(45),
    homeBaseCity:        z.string().min(2),
    homeBaseState:       z.string().length(2),
    endorsements:        z.array(z.enum(ENDORSEMENTS)),
    desiredEquipment:    z.enum(EQUIPMENT_KEYS),
    mvrViolations:       z.number().int().min(0).max(20),
    preventableAccidents: z.number().int().min(0).max(10),
    employmentGapMonths: z.number().int().min(0).max(240),
    desiredPayModel:     z.enum(['percent', 'permile']),
    desiredPayValue:     z.number(),   // percent → 1000-5000 bp; permile → 30-120 sent
  })
  .strict()

export const MaintenanceItem = z
  .object({
    service: z.enum(SERVICE_NAMES),
    notes: z.string().min(3).max(120),
  })
  .strict()

export const TRAILER_TYPES = ['dry-van', 'reefer', 'flatbed', 'step-deck', 'tanker', 'power-only']

export const TruckListingItem = z
  .object({
    make:            z.string().min(2).max(60),
    model:           z.string().min(1).max(60),
    year:            z.number().int().min(1995).max(2030),
    odometerMi:      z.number().int().min(0).max(2000000),
    trailerType:     z.enum(TRAILER_TYPES),
    tireFrontPct:    z.number().int().min(0).max(100),
    tireRearPct:     z.number().int().min(0).max(100),
    serviceNotes:    z.string().min(3).max(200),
    seller:          z.string().min(3).max(80),
  })
  .strict()
