// Zod validation schemas for HR endpoints. `.strict()` throughout
// — an unknown query/body key is a validation error, never silently ignored.

import { z } from 'zod'
import { EQUIPMENT_KEYS } from '../../constants/equipment.js'

const SORT_OPTIONS = ['newest', 'experience', 'expiring']

export const listApplicantsSchema = z
  .object({
    cdlClass: z.enum(['A', 'B']).optional(),
    homeBaseState: z.string().regex(/^[A-Z]{2}$/).optional(),
    minYearsExperience: z.coerce.number().int().min(0).max(45).optional(),
    desiredEquipment: z.enum(EQUIPMENT_KEYS).optional(),
    sort: z.enum(SORT_OPTIONS).default('newest'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()

// Route param for GET /hr/applicants/:id and POST /hr/applicants/:id/hire
export const applicantIdSchema = z.string().regex(/^a[0-9]{1,6}$/)

// POST /hr/applicants/:id/hire — no body required
export const hireApplicantSchema = z.object({}).strict()
