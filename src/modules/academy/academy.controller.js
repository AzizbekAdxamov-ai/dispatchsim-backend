// HTTP layer for /academy: parse, call the service, respond. No try/catch
// (Express 5 forwards rejected promises to the error handler).

import {
  lessonNoSchema, idSchema, progressBodySchema, advisorSchema,
  cohortCreateSchema, memberAddSchema, noteCreateSchema,
} from './academy.schemas.js'
import * as service from './academy.service.js'

const actorOf = (req) => ({ userId: req.auth.userId, isAdmin: req.access.isAdmin })

export async function getMe(req, res) {
  res.json(await service.getMe(req.auth.userId))
}

export async function saveProgress(req, res) {
  const lessonNo = lessonNoSchema.parse(req.params.lessonNo)
  const body = progressBodySchema.parse(req.body)
  res.json(await service.saveProgress(req.auth.userId, lessonNo, body))
}

export async function advisor(req, res) {
  advisorSchema.parse(req.body)
  res.json(await service.advisor())
}

export async function listCohorts(req, res) {
  res.json(await service.listCohorts(actorOf(req)))
}

export async function createCohort(req, res) {
  const input = cohortCreateSchema.parse(req.body)
  res.status(201).json(await service.createCohort(actorOf(req), input))
}

export async function addMember(req, res) {
  const cohortId = idSchema.parse(req.params.id)
  const { email } = memberAddSchema.parse(req.body)
  res.status(201).json(await service.addMember(actorOf(req), cohortId, email))
}

export async function getCohortStudents(req, res) {
  const cohortId = idSchema.parse(req.params.id)
  res.json(await service.getCohortStudents(actorOf(req), cohortId))
}

export async function getStudent(req, res) {
  const studentId = idSchema.parse(req.params.id)
  res.json(await service.getStudent(actorOf(req), studentId))
}

export async function addNote(req, res) {
  const studentId = idSchema.parse(req.params.id)
  const input = noteCreateSchema.parse(req.body)
  res.status(201).json(await service.addNote(actorOf(req), studentId, input))
}
