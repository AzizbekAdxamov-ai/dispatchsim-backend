import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const RUNNER_URL = new URL('../scripts/prod.js', import.meta.url)
const LOCAL_URL = 'postgres://local-user@localhost/local-db'
const PROD_URL = 'postgres://remote-user@prod.example/prod-db'
const NODE_PATH = '/fixture/node'
const EXIT_FAILURE = 1
const SCRIPT_COMMANDS = {
  'copy:drivers-prod': 'node scripts/copy-drivers-to-prod.js',
  'mig:status': 'node scripts/mig-status.js',
  'reset:company': 'node scripts/reset-company.js',
}

// Exercise the actual runner with inert process boundaries: no dotenv import,
// subprocess, network, real package read, or database connection can occur.
function invoke(script, args = []) {
  const calls = []
  const source = readFileSync(RUNNER_URL, 'utf8')
    .replace(/^import .*$/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(RUNNER_URL.href))
  const stop = new Error('process exited')
  const result = { calls }
  const env = { DATABASE_URL: LOCAL_URL, DATABASE_URL_PROD: PROD_URL }
  try {
    runInNewContext(source, {
      URL,
      console: { log() {}, error() {} },
      readFileSync: () => JSON.stringify({ scripts: SCRIPT_COMMANDS }),
      spawn: (...call) => { calls.push(call); return { on() {} } },
      process: {
        argv: [NODE_PATH, RUNNER_URL.pathname, script, ...args],
        execPath: NODE_PATH,
        env,
        exit(code) { result.exitCode = code; throw stop },
      },
    })
  } catch (error) {
    if (error !== stop) throw error
  }
  return result
}

test('copy runner preserves distinct source and target database URLs', () => {
  // Kills: overwriting the copy source with DATABASE_URL_PROD.
  const { calls } = invoke('copy:drivers-prod', ['--dry-run'])
  const [[, , options]] = calls
  assert.equal(options.env.DATABASE_URL, LOCAL_URL)
  assert.equal(options.env.DATABASE_URL_PROD, PROD_URL)
})

test('copy runner forwards only the requested copy arguments', () => {
  // Kills: injecting --allow-remote, which the copy script rejects.
  for (const mode of ['--dry-run', '--confirm']) {
    const { calls } = invoke('copy:drivers-prod', [mode])
    const [[executable, args]] = calls
    assert.equal(executable, NODE_PATH)
    assert.deepEqual(Array.from(args), ['scripts/copy-drivers-to-prod.js', mode])
  }
})

test('ordinary prod commands retain production targeting and remote opt-in', () => {
  // Kills: preserving local DATABASE_URL or dropping --allow-remote for ordinary commands.
  const { calls } = invoke('mig:status')
  const [[, args, options]] = calls
  assert.equal(options.env.DATABASE_URL, PROD_URL)
  assert.deepEqual(Array.from(args), ['scripts/mig-status.js', '--allow-remote'])
})

test('destructive commands still require the exact production hostname', () => {
  // Kills: removing the destructive-command confirmation guard.
  const { calls, exitCode } = invoke('reset:company')
  assert.deepEqual(calls, [])
  assert.equal(exitCode, EXIT_FAILURE)
  const approved = invoke('reset:company', ['--confirm-host=prod.example'])
  const [[, args, options]] = approved.calls
  assert.equal(options.env.DATABASE_URL, PROD_URL)
  assert.deepEqual(Array.from(args), ['scripts/reset-company.js', '--allow-remote'])
})
