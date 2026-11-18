// Zod schemas for /academy. All .strict(): unknown keys are errors.

import { z } from 'zod'
import { ACADEMY_LESSON_COUNT } from '../../constants/academyLessons.js'

export const lessonNoSchema = z.coerce.number().int().min(1).max(ACADEMY_LESSON_COUNT)

export const idSchema = z.string().uuid()

const quizValue = z.number().int().min(0).max(12).nullable().optional()

export const progressBodySchema = z
  .object({
    exitsDone: z
      .record(z.string().max(16), z.boolean())
      .refine((o) => Object.keys(o).length <= 12, 'Too many keys'),
    quiz: z.object({ qz: quizValue, sim: quizValue, exa: quizValue, exb: quizValue }).strict().optional(),
    mode: z.enum(['self', 'teach']).optional(),
  })
  .strict()

export const advisorSchema = z
  .object({
    lessonNo: lessonNoSchema,
    message: z.string().trim().min(1).max(500),
  })
  .strict()

export const cohortCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    mode: z.enum(['online', 'offline']).default('offline'),
    startDate: z.coerce.date().optional(),
  })
  .strict()

export const memberAddSchema = z
  .object({ email: z.string().trim().toLowerCase().email() })
  .strict()

export const noteCreateSchema = z
  .object({
    body: z.string().trim().min(1).max(2000),
    lessonNo: lessonNoSchema.nullable().optional(),
  })
  .strict()
