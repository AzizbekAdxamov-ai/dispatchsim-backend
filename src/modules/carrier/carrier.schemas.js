// What may be changed about the company, and by whom (the router says
// admin). `.strict()` throughout, like every schema here: an unknown key
// is a mistake worth hearing about, not a field to drop quietly.
import { z } from 'zod'

// Every field optional -- a form that edits the phone number sends the
// phone number. The SQL coalesces the rest, so nothing else is blanked.
// The formats match 048's CHECKs exactly: the database is the wall, this
// is the sentence that explains it before anyone hits the wall.
export const updateCarrierSchema = z
  .object({
    name: z.string().trim().min(3).max(160).optional(),
    mcNumber: z.string().trim().regex(/^MC-[0-9]{6}$/, 'MC number looks like MC-123456').optional(),
    dotNumber: z.string().trim().regex(/^[0-9]{6,8}$/, 'A USDOT number is 6 to 8 digits').optional(),
    phone: z.string().trim().min(7).max(32).optional(),
    addressLine: z.string().trim().min(3).max(160).optional(),
    city: z.string().trim().min(2).max(80).optional(),
    state: z.string().trim().regex(/^[A-Z]{2}$/, 'Two capital letters, like TX').optional(),
    postalCode: z.string().trim().regex(/^[0-9]{5}$/, 'Five digits').optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' })
