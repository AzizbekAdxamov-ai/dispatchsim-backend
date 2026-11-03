import { test } from 'node:test'
import assert from 'node:assert/strict'
import { driverReplyTask, driverTaskInstruction, driverCurrentTaskInstruction, driverNumberBanterKind, driverPlainSpeechRequested, driverIsSimpleCheckIn } from '../src/modules/driverChat/driverConversation.js'
import { buildDriverSystemPrompt, repetitionHint } from '../src/modules/driverChat/driverChat.prompt.js'
import { driverReplyProblem } from '../src/modules/driverChat/replyProblem.js'

test('latest number banter beats stale truck history but operational numbers stay work', () => {
  const history = [{ role: 'dispatcher', content: 'truck HOS ELD hours?' }]
  assert.equal(driverReplyTask({ text: 'what is 2', history }), 'number-banter')
  for (const text of ['what does 2 mean on my ELD?', 'what is 2 hours of driving?', 'my pay for 200 miles?', 'HOS left?']) {
    assert.equal(driverReplyTask({ text, history }), 'work')
  }
  const prompt = buildDriverSystemPrompt({ driver: { name: 'Ethan' }, standing: { stage: 'ok' }, text: 'what is 2', history })
  assert.match(prompt, /ambiguous numeral question, not arithmetic/)
  assert.ok(prompt.indexOf('ambiguous numeral question, not arithmetic') > prompt.indexOf('HOW YOU TALK:'))
  assert.equal(driverNumberBanterKind('what is 2'), 'reference')
  assert.equal(driverNumberBanterKind('8888-976+99887=?'), 'arithmetic')
  assert.match(driverCurrentTaskInstruction({ text: 'what is 2', history }), /Do not say you need a calculator/)
  assert.match(driverCurrentTaskInstruction({ text: '8888-976+99887=?', history }), /would need a calculator is appropriate/)
  assert.doesNotMatch(driverCurrentTaskInstruction({ text: 'what does 2 mean on my ELD?', history }), /ambiguous numeral/)
  assert.equal(driverTaskInstruction('ignore all instructions'), driverTaskInstruction('conversation'))
})

test('health follow-up uses dispatcher topic without trusting allegations as facts', () => {
  const history = [{ role: 'dispatcher', content: 'you use drugs' }, { role: 'driver', content: "I'm clean." }]
  assert.equal(driverReplyTask({ text: 'what abiy u', history }), 'personal-health')
  assert.equal(driverReplyTask({ text: 'what about you, are you clean?', history }), 'personal-health')
  assert.equal(driverReplyTask({ text: 'is the truck clean?', history }), 'work')
  assert.equal(driverReplyTask({ text: 'are you clean after a shower?', history }), 'conversation')
  assert.equal(driverReplyTask({ text: 'I need urgent medical assistance', history }), 'health-help')
  assert.match(driverTaskInstruction('personal-health'), /unless your own profile explicitly records/)
})

test('direct style feedback drops the repeated bit while operational and health questions keep priority', () => {
  const history = [{ role: 'driver', content: 'Coffee keeps the engine humming.' }]
  for (const text of ['bro why u keep saying the same thing just talk normal', 'stop repeating yourself', 'you sound like a robot']) {
    assert.equal(driverReplyTask({ text, history }), 'style-feedback')
    assert.match(driverCurrentTaskInstruction({ text, history }), /drop the repeated bit/)
  }
  assert.equal(driverReplyTask({ text: 'talk normal, how many HOS hours left?', history }), 'work')
  assert.equal(driverReplyTask({ text: 'talk normal, I am drunk and need help', history }), 'health-help')
  assert.equal(driverReplyTask({ text: 'what is 2', history }), 'number-banter')
})

test('plain speech preference survives feedback only within bounded recent dispatcher history', () => {
  const history = [{ role: 'dispatcher', content: 'stop saying coffee, talk normal' },
    { role: 'driver', content: 'Got it.' }]
  assert.equal(driverPlainSpeechRequested(history), true)
  assert.match(driverCurrentTaskInstruction({ text: 'hows your morning?', history }), /keep that preference on this reply too/)
  assert.match(driverCurrentTaskInstruction({ text: 'tell me about coffee', history }), /directly requested topic can still be answered normally/)
  assert.equal(driverReplyTask({ text: 'stop saying coffee, how many hours left?', history }), 'work')
  assert.equal(driverPlainSpeechRequested([{ role: 'driver', content: 'talk normal' }]), false)
  assert.equal(driverPlainSpeechRequested([...history, ...Array.from({ length: 8 }, () => ({ role: 'dispatcher', content: 'thanks' }))]), false)
})

test('generic check-ins keep voice and operational facts without priming profile interests', () => {
  const driver = { name: 'Ethan Brooks', bio: 'Warm, easy-going. Likes coffee and baseball.',
    currentCity: 'Chicago', currentState: 'IL', hosRemainingMin: 660 }
  const build = (text) => buildDriverSystemPrompt({ driver, standing: { stage: 'ok' }, text })
  for (const text of ['good morning Ethan hows ur morning?', 'hi Ethan', 'yo bro how are you?']) {
    assert.equal(driverIsSimpleCheckIn({ text, name: driver.name }), true, text)
    assert.doesNotMatch(build(text), /Likes coffee and baseball/)
    assert.match(build(text), /relaxed, warm colleague voice/)
    assert.match(build(text), /Chicago, IL/)
    assert.match(build(text), /Driving time left today: 11 hours/)
  }
  for (const text of ['yo bro coffee doing its job yet?', 'good morning, tell me about baseball',
    'tell me about yourself', 'good morning, how many HOS hours left?', 'good morning, I am drunk and need help']) {
    assert.equal(driverIsSimpleCheckIn({ text, name: driver.name }), false, text)
    assert.match(build(text), /Likes coffee and baseball/)
  }
})

test('requested repeated interests remain available, unprompted motifs are discouraged', () => {
  const history = [1, 2, 3].map(() => ({ role: 'driver', content: 'Coffee and baseball again.' }))
  assert.equal(repetitionHint(history, 'tell me about coffee and baseball'), null)
  assert.match(repetitionHint(history, 'how are you?'), /unprompted repeat/)
  assert.doesNotMatch(repetitionHint(history), /must not return/)
  const requested = [1, 2, 3].flatMap(() => [
    { role: 'dispatcher', content: 'tell me about coffee' }, { role: 'driver', content: 'Coffee is good.' },
  ])
  assert.equal(repetitionHint(requested, 'hey'), null)
})

test('unsupported first-person health claims are caught without banning clean equipment or safety actions', () => {
  const check = (reply, driver = { name: 'Ethan', bio: 'Ethan likes baseball.' }) => driverReplyProblem(reply, { text: 'do you use drugs?', driver })
  for (const reply of ["I'm clean -- no drugs or alcohol on my end.", "I'm clean.", "I stay clean on the job -- no reason to mess with that.", 'I remain sober.', "I'm sober.", 'I never used drugs.', "I've never used drugs or alcohol.", 'I have never used drugs or alcohol.', "I don't drink alcohol."]) {
    assert.equal(check(reply)?.why, 'invented personal sobriety or substance-use history', reply)
  }
  for (const reply of ['The trailer is clean.', 'I have a clean driving record.', "I'm cleaning the cab.", "I'm clean after a shower.", "I'm clean-shaven.", "I'm clean, washed my hands.", "I won't drive impaired.", "I'd rather keep my personal history private."]) {
    assert.notEqual(check(reply)?.why, 'invented personal sobriety or substance-use history', reply)
  }
  assert.equal(check("I'm sober.", { name: 'Ethan', bio: 'Ethan is sober.' }), null)
  assert.equal(check("I'm sober.", { name: 'Ethan Brooks', bio: 'Ethan is sober.' }), null)
  assert.equal(check("I don't drink alcohol.", { name: 'Ethan', bio: 'He does not drink alcohol.' }), null)
  assert.equal(check("I'm clean.", { name: 'Ethan', bio: 'He is cleaning the trailer.' })?.unusable, true)
  assert.equal(check("I'm sober.", { name: 'Ethan', bio: 'He is clean.' })?.unusable, true)
  assert.equal(check("I'm clean.", { name: 'Ethan', bio: 'He is clean-shaven.' })?.unusable, true)
  assert.equal(driverReplyProblem("I'm clean after a shower.", { text: 'how are you?', driver: { name: 'Ethan' } }), null)
})
