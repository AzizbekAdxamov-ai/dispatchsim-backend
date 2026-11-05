import { asciiPunct } from '../../lib/plainText.js'

const WORK = /\b(?:truck|trailer|hours?|hrs|hos|eld|fuel|pay|settlement|pickup|delivery|eta|miles?|load|location|driv\w*|rest)\b/i
const HEALTH = /\b(?:drugs?|alcoh\w*|alcahol|addict\w*|adicted|sober|sobriety|substance)\b/i
const HELP = /\b(?:help|advice|assistance|medical|emergency|overdos\w*|withdrawal|drunk|impaired|intoxicat\w*)\b/i
const STYLE_FEEDBACK = /\b(?:stop repeating|keep (?:saying|repeating) (?:the )?same|talk (?:normal|normally|natural)|sound (?:like a )?(?:robot|bot|script)|stop (?:saying|talking about) coffee)\b/i

// A short conversational preference survives the acknowledgment, without
// promoting the dispatcher's prose into a persistent system instruction.
export function driverPlainSpeechRequested(history = []) {
  return history.filter((m) => m.role === 'dispatcher').slice(-8)
    .some((m) => STYLE_FEEDBACK.test(String(m.content ?? '')))
}

// Generic check-ins need tone, not a list of interests to turn into scenery.
// Any other content leaves the profile available, including explicit hobbies.
export function driverIsSimpleCheckIn({ text = '', name = '' } = {}) {
  if (!String(text).trim()) return false
  const nameWords = new Set(String(name).toLowerCase().match(/[a-z]+/g) ?? [])
  const words = asciiPunct(text).toLowerCase().replaceAll("'", '').match(/[a-z0-9]+/g) ?? []
  let line = words.filter((word) => !nameWords.has(word) && !['bro', 'brother', 'sir', 'man'].includes(word)).join(' ')
  line = line.replace(/^(?:(?:hi|hey|hello|yo|wassap|wassup|good (?:morning|moring|afternoon|evening)|morning)\s*)+/, '').trim()
  return line === '' || /^(?:how(?:s| is) (?:your|ur) (?:morning|day|afternoon|evening|night)|how (?:are|r) (?:you|u)(?: doing)?|hows it going|whats up)$/.test(line)
}

// Only bounded task names leave this classifier. User prose is never promoted
// into system instructions, and a stale truck topic cannot override a new quiz.
export function driverReplyTask({ text = '', history = [] } = {}) {
  const line = asciiPunct(text)
  const previous = [...history].reverse().find((m) => m.role === 'dispatcher')?.content ?? ''
  const personalCleanFollowup = /\b(?:are\s+you|r\s*u)\s+clean\s*[?.!]*\s*$/i.test(line)
    && !/\b(?:shower|bath|hands?|truck|trailer|record|shaven)\b/i.test(line)
  const health = HEALTH.test(line) || ((/^\s*(?:what\s+(?:about|abiy)\s+(?:you|u)|and\s+(?:you|u))[?.!\s]*$/i.test(line)
    || personalCleanFollowup) && HEALTH.test(previous))
  if ((health && HELP.test(line)) || /\b(?:medical|emergency|overdose|withdrawal|impaired|drunk)\b/i.test(line)) return 'health-help'
  if (WORK.test(line)) return 'work'
  if (health) return 'personal-health'
  if (STYLE_FEEDBACK.test(line)) return 'style-feedback'
  if (/^\s*what\s+is\s+\d+\s*[?!.]*\s*$/i.test(line)
    || (/^\s*[\d\s,+*/().=?-]+(?:\s*(?:can\s+(?:you|u)\s+gues\w*|what\s+is\s+it))?\s*[?!.]*\s*$/i.test(line) && /\d\s*[-+*/]\s*\d/.test(line))) return 'number-banter'
  return 'conversation'
}

const INSTRUCTIONS = Object.freeze({
  'style-feedback': 'They are asking you to change how you talk. Acknowledge briefly, then drop the repeated bit. Do not defend your wording, recap the old topic, or add a stock work question. Use plain everyday words; a short acknowledgment is enough.',
  work: 'Answer the operational question using verified facts. HOS, payroll, rest and appointment constraints take priority over banter.',
  'health-help': 'This is a serious health or impairment question, not a joke. Address the requested help briefly; do not invent your own medical or substance-use history or agree to impaired driving.',
  'personal-health': 'This is personal substance-related conversation, not a counseling request. Do not claim you are clean, sober, a non-user, or have never used drugs or alcohol unless your own profile explicitly records that fact. Prefer keeping personal history private; do not replace it with an unverified claim that you stay clean on the job. An operational commitment not to drive impaired is different from asserting your medical condition. No lecture or automatic work redirect.',
  'number-banter': 'This turn is unrelated number banter. Stay a colleague texting, not a calculator or textbook. Do not define the number or guess a precise result; a brief personal reaction or asking what the quiz is about fits. Old operational history does not change this turn into a work question.',
  conversation: 'Give a plain, brief personal response to what they just said, then let it end. A greeting or how-are-you is enough on its own; do not reopen an earlier hobby or coffee bit unless they ask about it again. Do not add an offer to help, a load question or an invitation to send work. No imagined scene or trucking metaphor is needed.',
})

export function driverTaskInstruction(task) {
  return Object.hasOwn(INSTRUCTIONS, task) ? INSTRUCTIONS[task] : INSTRUCTIONS.conversation
}

// A bare numeral asks what it refers to; only an expression suggests a sum.
// The detail is another closed enum, never user text interpolated as policy.
export function driverNumberBanterKind(text = '') {
  return /^\s*what\s+is\s+\d+\s*[?!.]*\s*$/i.test(asciiPunct(text)) ? 'reference' : 'arithmetic'
}

export function driverCurrentTaskInstruction({ text = '', history = [] } = {}) {
  const task = driverReplyTask({ text, history })
  if (task !== 'number-banter') {
    const plain = task === 'conversation' && driverPlainSpeechRequested(history)
      ? ' They recently asked for plain conversation: keep that preference on this reply too. Give a simple personal answer and let it end. A directly requested topic can still be answered normally.'
      : ''
    return driverTaskInstruction(task) + plain
  }
  return driverNumberBanterKind(text) === 'reference'
    ? 'The latest message is an ambiguous numeral question, not arithmetic. Ask briefly what the number refers to, in your own conversational words. Do not describe its mathematical properties or define it. Do not say you need a calculator: there is no calculation here. This specific clarification takes priority over generic answer-first or trivia guidance, within all safety and factual constraints.'
    : 'The latest message is an unrelated arithmetic expression. Stay a colleague texting, not a calculator; do not guess an exact answer. A brief admission that you would need a calculator is appropriate here. Keep verified operational calculations separate.'
}
