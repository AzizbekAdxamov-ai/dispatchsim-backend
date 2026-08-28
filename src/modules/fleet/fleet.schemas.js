// Zod validation schemas for the /fleet/* endpoints.

import { z } from 'zod'

// Matches migration 006's `trucks_plate_format` CHECK.
export const truckIdSchema = z.string().regex(/^[A-Z]{2}-[0-9]{4}-[A-Z]{2}$/)

// Neither /fleet/trucks nor /fleet/maintenance is paginated (see the
// plan's Endpointlar §"Sahifalash") — `limit` exists only as a
// forward-compatible ceiling the frontend never sends today.
export const trucksQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).strict()
export const maintenanceQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(200) }).strict()
