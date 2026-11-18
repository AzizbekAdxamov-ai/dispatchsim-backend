// Thin data-access functions for the academy. SQL lives in academy.sql.js.
// Every function takes an optional trailing `client` (see users.repository.js).

import { query } from '../../db/pool.js'
import * as sql from './academy.sql.js'

function run(client) {
  return client ? client.query.bind(client) : query
}

export async function upsertProgress({ userId, lessonNo, exitsDone, quiz, mode }, client) {
  const r = await run(client)(sql.UPSERT_PROGRESS_SQL, [
    userId, lessonNo, JSON.stringify(exitsDone), JSON.stringify(quiz), mode ?? null,
  ])
  return r.rows[0]
}

export async function listProgressForUser(userId, client) {
  return (await run(client)(sql.LIST_PROGRESS_FOR_USER_SQL, [userId])).rows
}

export async function findMyCohort(userId, client) {
  return (await run(client)(sql.MY_COHORT_SQL, [userId])).rows[0] ?? null
}

export async function listNotesForStudent(studentId, client) {
  return (await run(client)(sql.NOTES_FOR_STUDENT_SQL, [studentId])).rows
}

export async function createCohort({ name, mentorId, mode, startDate }, client) {
  const r = await run(client)(sql.CREATE_COHORT_SQL, [name, mentorId, mode, startDate ?? null])
  return r.rows[0]
}

export async function listCohorts(actorId, seesAll, client) {
  return (await run(client)(sql.LIST_COHORTS_SQL, [actorId, seesAll])).rows
}

export async function addMember(cohortId, userId, client) {
  await run(client)(sql.ADD_MEMBER_SQL, [cohortId, userId])
}

export async function findCohortInScope(cohortId, actorId, seesAll, client) {
  return (await run(client)(sql.COHORT_BY_ID_SQL, [cohortId, actorId, seesAll])).rows[0] ?? null
}

export async function listCohortStudentRows(cohortId, client) {
  return (await run(client)(sql.COHORT_STUDENTS_WITH_PROGRESS_SQL, [cohortId])).rows
}

export async function findStudentInScope(studentId, actorId, seesAll, client) {
  return (await run(client)(sql.STUDENT_IN_SCOPE_SQL, [studentId, actorId, seesAll])).rows[0] ?? null
}

export async function insertNote({ studentId, authorId, lessonNo, body }, client) {
  const r = await run(client)(sql.INSERT_NOTE_SQL, [studentId, authorId, lessonNo ?? null, body])
  return r.rows[0]
}
