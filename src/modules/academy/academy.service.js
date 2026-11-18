// Academy business logic. Response shapes are the contract the frontend
// relies on; see the lesson row builder below.

import { AppError } from '../../lib/errors.js'
import * as usersRepo from '../auth/users.repository.js'
import * as repo from './academy.repository.js'
import {
  ACADEMY_LESSON_COUNT, LESSON_EXITS, QUIZ_MAX, quizKeysFor,
} from '../../constants/academyLessons.js'

const LESSON_NUMBERS = Array.from({ length: ACADEMY_LESSON_COUNT }, (_, i) => i + 1)

// Keeps only what the lesson really has: known EXIT keys that are true, and
// quiz counters allowed for this lesson, as integers within their maximum.
// null/undefined/out-of-range values are dropped (never stored, never erase).
export function normalizeProgress(lessonNo, body) {
  const allowedExits = new Set(LESSON_EXITS[lessonNo] ?? [])
  const exitsDone = {}
  for (const [key, value] of Object.entries(body?.exitsDone ?? {})) {
    if (value === true && allowedExits.has(key)) exitsDone[key] = true
  }
  const quiz = {}
  const allowedQuiz = new Set(quizKeysFor(lessonNo))
  for (const [key, value] of Object.entries(body?.quiz ?? {})) {
    if (!allowedQuiz.has(key)) continue
    if (Number.isInteger(value) && value >= 0 && value <= QUIZ_MAX[key]) quiz[key] = value
  }
  return { exitsDone, quiz, mode: body?.mode ?? null }
}

function countTrue(obj) {
  return Object.values(obj ?? {}).filter((v) => v === true).length
}

function lessonRow(lessonNo, row) {
  return {
    lessonNo,
    exitsDone: row?.exitsDone ?? {},
    exitsCount: countTrue(row?.exitsDone),
    quiz: row?.quiz ?? {},
    mode: row?.mode ?? 'self',
    completedAt: row?.completedAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  }
}

function twelveLessons(rows) {
  const byNo = new Map(rows.map((r) => [r.lessonNo, r]))
  return LESSON_NUMBERS.map((no) => lessonRow(no, byNo.get(no)))
}

export async function getMe(userId, client) {
  const [rows, cohortRow, notes] = await Promise.all([
    repo.listProgressForUser(userId, client),
    repo.findMyCohort(userId, client),
    repo.listNotesForStudent(userId, client),
  ])
  return {
    lessons: twelveLessons(rows),
    cohort: cohortRow ? { id: cohortRow.id, name: cohortRow.name, mode: cohortRow.mode } : null,
    mentor: cohortRow && cohortRow.mentorName
      ? { name: cohortRow.mentorName, email: cohortRow.mentorEmail }
      : null,
    notes,
  }
}

export async function saveProgress(userId, lessonNo, body, client) {
  const { exitsDone, quiz, mode } = normalizeProgress(lessonNo, body)
  const row = await repo.upsertProgress({ userId, lessonNo, exitsDone, quiz, mode }, client)
  return lessonRow(lessonNo, row)
}

// v1 skeleton: validated by the controller, always "not available yet".
// TODO v2: answer through the LLM provider once the shared daily budget
// (chatBudget) counts advisor requests separately from broker/driver chat.
export async function advisor() {
  return { available: false, reply: null }
}

// ---- mentor side ----------------------------------------------------------

async function requireCohort(cohortId, actor, client) {
  const cohort = await repo.findCohortInScope(cohortId, actor.userId, actor.isAdmin, client)
  if (!cohort) throw new AppError('COHORT_NOT_FOUND')
  return cohort
}

export async function listCohorts(actor, client) {
  return repo.listCohorts(actor.userId, actor.isAdmin, client)
}

export async function createCohort(actor, input, client) {
  const startDate = input.startDate ? input.startDate.toISOString().slice(0, 10) : null
  return repo.createCohort(
    { name: input.name, mentorId: actor.userId, mode: input.mode, startDate },
    client,
  )
}

export async function addMember(actor, cohortId, email, client) {
  await requireCohort(cohortId, actor, client)
  const student = await usersRepo.findPublicIdByEmail(email, client)
  if (!student) throw new AppError('ACADEMY_EMAIL_NOT_FOUND')
  await repo.addMember(cohortId, student.id, client)
  return { student: { id: student.id, name: student.name, email: student.email } }
}

export async function getCohortStudents(actor, cohortId, client) {
  const cohort = await requireCohort(cohortId, actor, client)
  const rows = await repo.listCohortStudentRows(cohortId, client)
  const students = new Map()
  for (const r of rows) {
    let s = students.get(r.id)
    if (!s) {
      s = { id: r.id, name: r.name, email: r.email, lastActivity: null, byNo: new Map() }
      students.set(r.id, s)
    }
    if (r.lessonNo != null) {
      s.byNo.set(r.lessonNo, r)
      if (!s.lastActivity || r.updatedAt > s.lastActivity) s.lastActivity = r.updatedAt
    }
  }
  return {
    cohort: { id: cohort.id, name: cohort.name, mode: cohort.mode },
    students: [...students.values()].map((s) => ({
      id: s.id,
      name: s.name,
      email: s.email,
      lastActivity: s.lastActivity,
      lessons: LESSON_NUMBERS.map((no) => {
        const r = s.byNo.get(no)
        return {
          lessonNo: no,
          exitsCount: r ? r.exitsCount : 0,
          quiz: r ? r.quiz : {},
          completedAt: r ? r.completedAt : null,
        }
      }),
    })),
  }
}

export async function getStudent(actor, studentId, client) {
  const student = await repo.findStudentInScope(studentId, actor.userId, actor.isAdmin, client)
  if (!student) throw new AppError('STUDENT_NOT_FOUND')
  const [rows, notes] = await Promise.all([
    repo.listProgressForUser(studentId, client),
    repo.listNotesForStudent(studentId, client),
  ])
  return {
    student: { id: student.id, name: student.name, email: student.email },
    lessons: twelveLessons(rows),
    notes,
  }
}

export async function addNote(actor, studentId, input, client) {
  const student = await repo.findStudentInScope(studentId, actor.userId, actor.isAdmin, client)
  if (!student) throw new AppError('STUDENT_NOT_FOUND')
  const note = await repo.insertNote(
    { studentId, authorId: actor.userId, lessonNo: input.lessonNo ?? null, body: input.body },
    client,
  )
  return { note: { ...note, authorName: null } }
}
