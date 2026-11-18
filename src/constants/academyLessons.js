// Single source of truth for the academy's 12 lessons on the server side:
// which EXIT keys each lesson has and which quiz counters it may report.
// The lessons themselves are course/week-0W/lesson-NN/interactive.html;
// keep this in step with them (test/academyProgress.test.js checks the shape).

export const ACADEMY_LESSON_COUNT = 12

// Seven EXIT checkpoints per lesson. A lesson is complete when all seven are done.
export const EXITS_PER_LESSON = 7

export const LESSON_EXITS = Object.freeze({
  1:  Object.freeze(['story', 'roles', 'life', 'case', 'talk', 'quiz', 'app']),
  2:  Object.freeze(['story', 'types', 'weight', 'haul', 'talk', 'quiz', 'app']),
  3:  Object.freeze(['story', 'hos', 'eld', 'plan', 'insp', 'talk', 'app']),
  4:  Object.freeze(['story', 'pm', 'break', 'fuel', 'insp', 'talk', 'app']),
  5:  Object.freeze(['story', 'spot', 'lane', 'broker', 'price', 'talk', 'app']),
  6:  Object.freeze(['story', 'board', 'rate', 'search', 'safe', 'talk', 'app']),
  7:  Object.freeze(['story', 'cost', 'load', 'week', 'floor', 'talk', 'app']),
  8:  Object.freeze(['story', 'nums', 'lang', 'sim', 'pos', 'talk', 'app']),
  9:  Object.freeze(['story', 'flow', 'rc', 'day', 'pay', 'talk', 'app']),
  10: Object.freeze(['story', 'trip', 'chain', 'zone', 'hos', 'talk', 'app']),
  11: Object.freeze(['story', 'break', 'late', 'cancel', 'hard', 'talk', 'app']),
  12: Object.freeze(['story', 'sim', 'exa', 'exb', 'calc', 'talk', 'app']),
})

// Quiz counters a lesson may report. Lesson 12 also has three final parts.
export const QUIZ_KEYS = Object.freeze({
  default: Object.freeze(['qz']),
  12: Object.freeze(['qz', 'sim', 'exa', 'exb']),
})

export const QUIZ_MAX = Object.freeze({ qz: 8, sim: 12, exa: 10, exb: 10 })

export function quizKeysFor(lessonNo) {
  return QUIZ_KEYS[lessonNo] ?? QUIZ_KEYS.default
}
