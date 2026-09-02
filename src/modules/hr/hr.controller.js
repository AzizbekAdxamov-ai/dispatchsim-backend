// HTTP layer for /hr. No SQL, no business logic here — that lives in
// hr.service.js and hr.repository.js. Every route is already behind
// requireAuth + requireRole() (see hr.routes.js).

import { listApplicantsSchema, applicantIdSchema } from './hr.schemas.js'
import * as hrService from './hr.service.js'

export async function listApplicants(req, res) {
  const input = listApplicantsSchema.parse(req.query)
  const result = await hrService.listApplicants(input)
  res.status(200).json(result)
}

export async function getApplicant(req, res) {
  const id = applicantIdSchema.parse(req.params.id)
  const applicant = await hrService.getApplicantById(id)
  res.status(200).json(applicant)
}

// POST /hr/applicants/:id/hire — hire an applicant, creating a driver.
// Returns 201 with the created driver and updated applicant.
export async function hireApplicant(req, res, next) {
  try {
    const applicantId = applicantIdSchema.parse(req.params.id)
    const userId = req.auth.userId

    const result = await hrService.hireApplicant({ applicantId, userId })

    res.status(201).json(result)
  } catch (err) {
    next(err)
  }
}
