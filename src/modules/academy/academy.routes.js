// /academy -- the course. Student routes need access = cohort membership,
// is_mentor or is_admin; /academy/mentor/* needs is_mentor or is_admin. All
// flags are re-read from the database on every request.

import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireMentor } from '../../middleware/requireMentor.js'
import { AppError } from '../../lib/errors.js'
import * as usersRepo from '../auth/users.repository.js'
import * as controller from './academy.controller.js'

async function requireAcademyAccess(req, res, next) {
  try {
    const flags = await usersRepo.findAccessFlagsById(req.auth.userId)
    if (!flags) return next(new AppError('USER_NOT_FOUND'))
    const isAdmin = flags.isAdmin === true
    const isMentor = flags.isMentor === true
    if (!(flags.isCohortMember === true || isMentor || isAdmin)) return next(new AppError('FORBIDDEN'))
    req.access = { isAdmin, isMentor }
    next()
  } catch (err) {
    next(err)
  }
}

const router = Router()
router.use(requireAuth)

const mentor = Router()
mentor.use(requireMentor)
mentor.get('/cohorts', controller.listCohorts)
mentor.post('/cohorts', controller.createCohort)
mentor.post('/cohorts/:id/members', controller.addMember)
mentor.get('/cohorts/:id/students', controller.getCohortStudents)
mentor.get('/students/:id', controller.getStudent)
mentor.post('/students/:id/notes', controller.addNote)
// Registered before the student routes so requireAcademyAccess never runs for it.
router.use('/mentor', mentor)

router.use(requireAcademyAccess)
router.get('/me', controller.getMe)
router.put('/progress/:lessonNo', controller.saveProgress)
router.post('/advisor', controller.advisor)

export default router
