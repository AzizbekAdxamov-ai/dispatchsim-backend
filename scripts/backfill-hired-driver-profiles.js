// Local by default; --confirm is the only write switch. The prod runner
// explicitly supplies --allow-remote, but never implies confirmation.
import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { buildDriverPersona } from '../src/modules/hr/driverPersona.js'
import { listHiredWithoutBio, fillMissingProfile, insertQualification } from '../src/modules/hr/hr.repository.js'

const EXIT_FAILURE = 1
const USAGE = 'Usage: node scripts/backfill-hired-driver-profiles.js [--dry-run | --confirm] [--allow-remote]'

export function parseArgs(args) {
  const supported = new Set(['--dry-run', '--confirm', '--allow-remote'])
  if (args.some((arg) => !supported.has(arg)) || (args.includes('--dry-run') && args.includes('--confirm'))) {
    throw new Error(USAGE)
  }
  return { confirm: args.includes('--confirm'), allowRemote: args.includes('--allow-remote') }
}

export async function runBackfill({ client, confirm = false }) {
  await client.query(confirm ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const applicants = await listHiredWithoutBio(client, { lock: confirm })
    const drivers = []
    for (const applicant of applicants) {
      const profile = buildDriverPersona(applicant)
      if (confirm) {
        const updated = await fillMissingProfile(client, applicant.driverId, profile)
        if (!updated) continue
        await insertQualification(client, applicant.driverId, applicant)
      }
      drivers.push({ driverId: applicant.driverId, applicantId: applicant.id, bioLength: profile.bio.length })
    }
    await client.query('COMMIT')
    return { mode: confirm ? 'apply' : 'dry-run', count: drivers.length, drivers }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const connectionString = process.env.DATABASE_URL
  let host
  try { host = new URL(connectionString).hostname } catch { throw new Error('DATABASE_URL is missing or invalid') }
  const local = /^(localhost|127\.0\.0\.1)$/.test(host)
  if (!local && !options.allowRemote) throw new Error('Remote database requires --allow-remote')
  const client = new pg.Client({ connectionString, ssl: local ? false : { rejectUnauthorized: true } })
  try {
    await client.connect()
    console.log(JSON.stringify(await runBackfill({ client, ...options }), null, 2))
  } finally {
    await client.end().catch(() => {})
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Profile backfill failed; no partial changes committed.'); process.exitCode = EXIT_FAILURE })
}
