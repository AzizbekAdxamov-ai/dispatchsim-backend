-- Academy (course) v1: mentor access, cohorts, lesson progress, mentor notes.
--
-- Mentor access is a separate `is_mentor` boolean, like `is_admin` (002),
-- and is deliberately NOT added to ROLE_KEYS / user_roles. A role is a WORK
-- AREA inside the app (dispatcher / hr / ...); mentoring is a PERMISSION to
-- see other students' course progress, independent of work area. A person
-- can be a dispatcher AND a mentor, and a mentor with no work area at all
-- must not get a fake role string just to be let in.
--
-- Every FK to users is ON DELETE CASCADE or SET NULL because admin.service
-- deletes users outright; course data must never block that.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_mentor boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS users_is_mentor_idx ON users (is_mentor) WHERE is_mentor;

CREATE TABLE IF NOT EXISTS academy_cohorts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  mentor_id   uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  mode        text NOT NULL DEFAULT 'offline' CHECK (mode IN ('online', 'offline')),
  start_date  date NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_cohorts_mentor_idx ON academy_cohorts (mentor_id);

CREATE TABLE IF NOT EXISTS academy_cohort_members (
  cohort_id  uuid NOT NULL REFERENCES academy_cohorts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cohort_id, user_id)
);
CREATE INDEX IF NOT EXISTS academy_cohort_members_user_idx ON academy_cohort_members (user_id);

CREATE TABLE IF NOT EXISTS academy_progress (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_no    smallint NOT NULL CHECK (lesson_no BETWEEN 1 AND 12),
  exits_done   jsonb NOT NULL DEFAULT '{}'::jsonb,
  quiz         jsonb NOT NULL DEFAULT '{}'::jsonb,
  mode         text NOT NULL DEFAULT 'self' CHECK (mode IN ('self', 'teach')),
  completed_at timestamptz NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lesson_no)
);

CREATE TABLE IF NOT EXISTS academy_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id   uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  lesson_no   smallint NULL CHECK (lesson_no BETWEEN 1 AND 12),
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_notes_student_idx ON academy_notes (student_id, created_at DESC);
