import fs from 'fs'
import { pool } from '../src/db/pool.js'

const BASE = 'http://localhost:4000'

const l1 = JSON.parse(fs.readFileSync('./tmp/login1.json', 'utf8'))
const l2 = JSON.parse(fs.readFileSync('./tmp/login2.json', 'utf8'))
const T1 = l1.token
const T2 = l2.token

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

let test1LoadId = null

// Find open posting IDs
const board = await req('GET', '/load-board?limit=100', null, T1)
const openPostings = board.json.postings.filter(p => p.status === 'open')
console.log(`Open postings: ${openPostings.length}`)
openPostings.forEach(p => console.log(`  ${p.id} ${p.equipmentType}`))

// Find free drivers
const freeDrivers = await pool.query(`
  SELECT d.id, d.name FROM drivers d
  WHERE NOT EXISTS (SELECT 1 FROM loads l WHERE l.driver_id = d.id AND l.status IN ('ontime','delayed'))
  ORDER BY d.id LIMIT 5
`)
console.log(`Free drivers: ${freeDrivers.rows.map(r => r.id).join(', ')}`)

// =====================================================================
// TEST 1: Book → 201 + load id 600000+
// =====================================================================
console.log('\n=== TEST 1: Book posting ===')
const posting1 = openPostings[0]
const driver1 = freeDrivers.rows[0]?.id
const r1 = await req('POST', `/load-board/${posting1.id}/book`, { driverId: driver1 }, T1)
test1LoadId = r1.json.load?.id
console.log(`HTTP: ${r1.status} (expect 201)`)
console.log(`Load ID: ${r1.json.load?.id}`)
console.log(`Posting status: ${r1.json.posting?.status}`)
console.log(`Has load: ${!!r1.json.load}, Has posting: ${!!r1.json.posting}`)
console.log(`PASS: ${r1.status === 201 && test1LoadId && r1.json.posting?.status === 'booked'}`)

// =====================================================================
// TEST 2: Idempotent repeat → 200 + same load id
// =====================================================================
console.log('\n=== TEST 2: Idempotent repeat ===')
const r2 = await req('POST', `/load-board/${posting1.id}/book`, { driverId: driver1 }, T1)
console.log(`HTTP: ${r2.status} (expect 200)`)
console.log(`Load ID: ${r2.json.load?.id}`)
console.log(`Same as test 1: ${r2.json.load?.id === test1LoadId}`)
console.log(`Posting status: ${r2.json.posting?.status}`)
console.log(`Has load+posting: ${!!r2.json.load && !!r2.json.posting}`)
console.log(`PASS: ${r2.status === 200 && r2.json.load?.id === test1LoadId}`)

// =====================================================================
// TEST 3: Race condition → one 201, one 409
// =====================================================================
console.log('\n=== TEST 3: Race condition ===')
const posting2 = openPostings[1]
const driver2 = freeDrivers.rows[1]?.id
const driver3 = freeDrivers.rows[2]?.id
if (!posting2) {
  console.log('SKIP — no 2nd open posting')
} else if (!driver2 || !driver3) {
  console.log('SKIP — not enough free drivers')
} else {
  const [ra, rb] = await Promise.all([
    req('POST', `/load-board/${posting2.id}/book`, { driverId: driver2 }, T1),
    req('POST', `/load-board/${posting2.id}/book`, { driverId: driver3 }, T2),
  ])
  const codes = [ra.status, rb.status].sort()
  console.log(`User 1: ${ra.status}, User 2: ${rb.status}`)
  console.log(`One 201, one 409: ${codes[0] === 201 && codes[1] === 409}`)
  if (ra.status === 201) console.log(`  Winner load: ${ra.json.load?.id}`)
  if (rb.status === 201) console.log(`  Winner load: ${rb.json.load?.id}`)
  const loser = ra.status === 409 ? ra : rb
  console.log(`  Loser error: ${loser.json.error?.code}`)
  console.log(`PASS: ${codes[0] === 201 && codes[1] === 409}`)
}

// =====================================================================
// TEST 4: Load exists via GET /loads/:id
// =====================================================================
console.log('\n=== TEST 4: Load exists ===')
const r4 = await req('GET', `/loads/${test1LoadId}`, null, T1)
console.log(`HTTP: ${r4.status} (expect 200)`)
console.log(`Load ID: ${r4.json?.id}`)
console.log(`Status: ${r4.json?.status}`)
console.log(`Driver: ${r4.json?.driverId}`)
console.log(`PASS: ${r4.status === 200 && r4.json?.id === test1LoadId}`)

// =====================================================================
// TEST 5: Posting gone from board
// =====================================================================
console.log('\n=== TEST 5: Posting gone from board ===')
const r5 = await req('GET', '/load-board?limit=100', null, T1)
const found = r5.json.postings.find(p => p.id === posting1.id)
console.log(`Booking posting still visible: ${!!found}`)
console.log(`PASS: ${!found}`)

await pool.end()
console.log('\n=== ALL TESTS COMPLETE ===')
