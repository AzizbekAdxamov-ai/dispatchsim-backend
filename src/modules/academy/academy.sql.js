// Every statement the academy runs. Exported as strings so scripts/sql-check.js
// parses each against the real schema. No SELECT *; all values via $n.

// Progress merges monotonically: exits are OR-ed in (a later save can never
// undo an earlier EXIT) and quiz counters keep the best value per key (a lower later result never replaces a higher one). completed_at is
// set once, the first time seven exits are done. The service only sends exits
// that are true, so counting keys counts done exits.
// $1 user, $2 lesson, $3 exits_done jsonb, $4 quiz jsonb, $5 mode (null keeps the stored one).
export const UPSERT_PROGRESS_SQL = `
  INSERT INTO academy_progress AS p (user_id, lesson_no, exits_done, quiz, mode, completed_at, updated_at)
  VALUES ($1, $2, $3::jsonb, $4::jsonb, COALESCE($5::text, 'self'),
          CASE WHEN (SELECT count(*) FROM jsonb_object_keys($3::jsonb)) >= 7 THEN now() END,
          now())
  ON CONFLICT (user_id, lesson_no) DO UPDATE SET
    exits_done = p.exits_done || EXCLUDED.exits_done,
    quiz = (
      SELECT COALESCE(jsonb_object_agg(
               k.key,
               GREATEST(COALESCE((p.quiz ->> k.key)::int, 0), COALESCE((EXCLUDED.quiz ->> k.key)::int, 0))
             ), '{}'::jsonb)
        FROM jsonb_object_keys(p.quiz || EXCLUDED.quiz) AS k(key)
    ),
    mode = COALESCE($5::text, p.mode),
    completed_at = COALESCE(
      p.completed_at,
      CASE WHEN (SELECT count(*) FROM jsonb_object_keys(p.exits_done || EXCLUDED.exits_done)) >= 7 THEN now() END
    ),
    updated_at = now()
  RETURNING p.lesson_no AS "lessonNo", p.exits_done AS "exitsDone", p.quiz,
            p.mode, p.completed_at AS "completedAt", p.updated_at AS "updatedAt"`

export const LIST_PROGRESS_FOR_USER_SQL = `
  SELECT lesson_no AS "lessonNo", exits_done AS "exitsDone", quiz, mode,
         completed_at AS "completedAt", updated_at AS "updatedAt"
    FROM academy_progress
   WHERE user_id = $1
   ORDER BY lesson_no`

export const MY_COHORT_SQL = `
  SELECT c.id, c.name, c.mode, m.name AS "mentorName", m.email AS "mentorEmail"
    FROM academy_cohort_members cm
    JOIN academy_cohorts c ON c.id = cm.cohort_id
    LEFT JOIN users m ON m.id = c.mentor_id
   WHERE cm.user_id = $1
   ORDER BY cm.joined_at DESC
   LIMIT 1`

export const NOTES_FOR_STUDENT_SQL = `
  SELECT n.id, n.lesson_no AS "lessonNo", n.body, n.created_at AS "createdAt",
         a.name AS "authorName"
    FROM academy_notes n
    LEFT JOIN users a ON a.id = n.author_id
   WHERE n.student_id = $1
   ORDER BY n.created_at DESC
   LIMIT 200`

export const CREATE_COHORT_SQL = `
  INSERT INTO academy_cohorts (name, mentor_id, mode, start_date)
  VALUES ($1, $2, $3, $4)
  RETURNING id, name, mode, start_date AS "startDate"`

// $1 actor, $2 sees-all (admin). Mentors see only their own cohorts.
export const LIST_COHORTS_SQL = `
  SELECT c.id, c.name, c.mode, c.start_date AS "startDate",
         (SELECT count(*)::int FROM academy_cohort_members cm WHERE cm.cohort_id = c.id) AS "studentCount"
    FROM academy_cohorts c
   WHERE ($2::boolean OR c.mentor_id = $1)
   ORDER BY c.created_at DESC`

export const ADD_MEMBER_SQL = `
  INSERT INTO academy_cohort_members (cohort_id, user_id)
  VALUES ($1, $2)
  ON CONFLICT DO NOTHING`

// $1 cohort, $2 actor, $3 sees-all. A cohort outside the actor's scope
// returns no row.
export const COHORT_BY_ID_SQL = `
  SELECT c.id, c.name, c.mode, c.start_date AS "startDate"
    FROM academy_cohorts c
   WHERE c.id = $1 AND ($3::boolean OR c.mentor_id = $2)`

// One row per student x progressed lesson (lesson columns null when the
// student has no progress at all). Grouped into students in the service.
export const COHORT_STUDENTS_WITH_PROGRESS_SQL = `
  SELECT u.id, u.name, u.email,
         p.lesson_no AS "lessonNo",
         (SELECT count(*)::int FROM jsonb_each(p.exits_done) e WHERE e.value = 'true'::jsonb) AS "exitsCount",
         p.quiz, p.completed_at AS "completedAt", p.updated_at AS "updatedAt"
    FROM academy_cohort_members cm
    JOIN users u ON u.id = cm.user_id
    LEFT JOIN academy_progress p ON p.user_id = u.id
   WHERE cm.cohort_id = $1
   ORDER BY u.name, u.id, p.lesson_no`

// Is $1 a student the actor ($2, $3 sees-all) may see?
export const STUDENT_IN_SCOPE_SQL = `
  SELECT u.id, u.name, u.email
    FROM users u
   WHERE u.id = $1
     AND ($3::boolean OR EXISTS (
           SELECT 1 FROM academy_cohort_members cm
             JOIN academy_cohorts c ON c.id = cm.cohort_id
            WHERE cm.user_id = u.id AND c.mentor_id = $2))`

export const INSERT_NOTE_SQL = `
  INSERT INTO academy_notes (student_id, author_id, lesson_no, body)
  VALUES ($1, $2, $3, $4)
  RETURNING id, lesson_no AS "lessonNo", body, created_at AS "createdAt"`
