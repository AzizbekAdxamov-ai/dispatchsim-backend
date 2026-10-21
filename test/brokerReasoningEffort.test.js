import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { groqReasoningEffort, groqReasoningParams } from '../src/constants/chatBudget.js'

const names = ['CHAT_BROKER_REASONING_EFFORT', 'CHAT_GROQ_REASONING_EFFORT', 'CHAT_DRIVER_REASONING_EFFORT']
function withEfforts(values, run) {
  const previous = names.map((name) => process.env[name])
  try {
    names.forEach((name, index) => { process.env[name] = values[index] ?? '' })
    run()
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]
      else process.env[name] = previous[index]
    })
  }
}

test('broker effort override reaches only the broker GPT-OSS request', () => {
  withEfforts(['medium', 'low', 'high'], () => {
    const groq = 'https://api.groq.com/openai/v1'
    assert.equal(groqReasoningParams(groq, 'openai/gpt-oss-120b', 'broker').reasoning_effort, 'medium')
    assert.equal(groqReasoningEffort('driver'), 'high')
    assert.equal(groqReasoningEffort(null), 'low')
    assert.deepEqual(groqReasoningParams('https://openrouter.ai/api/v1', 'openai/gpt-oss-120b', 'broker'), {})
  })
})

test('blank broker override preserves shared/default behavior and never changes driver or seed defaults', () => {
  withEfforts(['', 'high', ''], () => {
    assert.equal(groqReasoningEffort('broker'), 'high')
    assert.equal(groqReasoningEffort('driver'), 'high')
    assert.equal(groqReasoningEffort(null), 'high')
  })
  withEfforts(['medium', '', ''], () => {
    assert.equal(groqReasoningEffort('broker'), 'medium')
    assert.equal(groqReasoningEffort('driver'), 'medium')
    assert.equal(groqReasoningEffort(null), 'low')
  })
  withEfforts(['', '', ''], () => assert.equal(groqReasoningEffort('broker'), 'low'))
})

test('central configuration accepts valid broker efforts and refuses a typo before startup', () => {
  for (const [value, valid] of [['low', true], ['medium', true], ['high', true], ['', true], ['maximum', false]]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config.js')"], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: 'postgresql://unused:unused@localhost/unused', JWT_SECRET: 'x'.repeat(32), CHAT_BROKER_REASONING_EFFORT: value },
    })
    assert.equal(child.status, valid ? 0 : 1, value)
    if (!valid) assert.match(child.stderr, /CHAT_BROKER_REASONING_EFFORT must be/)
  }
})
