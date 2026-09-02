// Board census: nechta e'lon bor, hozir nechtasi ko'rinadi, va oxirgi
// yugurishda nechtasi qo'shildi.
//
//   node scripts/count-postings.js        (oxirgi 1 soat oynasi)
//   node scripts/count-postings.js 24     (oxirgi 24 soat)
//
// PowerShell'da `node -e "..."` qo'shtirnoqlarni yeb yuboradi — shuning
// uchun alohida fayl.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'

const hours = Number(process.argv[2] ?? 1)
if (!Number.isFinite(hours) || hours <= 0) {
  console.error('soat musbat son bo\'lishi kerak')
  process.exit(1)
}

const since = new Date(Date.now() - hours * 3600_000)

const { rows } = await pool.query(
  `SELECT
     count(*)                                                           AS jami,
     count(*) FILTER (WHERE posted_at <= now() AND expires_at > now())  AS live,
     count(*) FILTER (WHERE posted_at > now())                          AS kutmoqda,
     count(*) FILTER (WHERE expires_at <= now())                        AS tugagan,
     count(*) FILTER (WHERE status = 'booked')                          AS bron,
     count(*) FILTER (WHERE created_at > $1)                            AS yangi,
     count(*) FILTER (WHERE created_at > $1
                        AND posted_at <= now()
                        AND expires_at > now())                         AS yangi_live
   FROM load_postings`,
  [since],
)

const r = rows[0]
console.log(`\nload_postings — oxirgi ${hours} soat oynasi\n`)
console.log(`  jami e'lon        : ${r.jami}`)
console.log(`  hozir ko'rinadi   : ${r.live}`)
console.log(`  hali tomchilamagan: ${r.kutmoqda}`)
console.log(`  muddati tugagan   : ${r.tugagan}`)
console.log(`  bron qilingan     : ${r.bron}`)
console.log(`  ---`)
console.log(`  yangi qo'shilgan  : ${r.yangi}`)
console.log(`  shundan tirik     : ${r.yangi_live}   <-- ~20 bo'lishi kerak\n`)

const app = await pool.query(
  `SELECT
     count(*)                                                          AS jami,
     count(*) FILTER (WHERE posted_at <= now() AND expires_at > now()) AS live,
     count(*) FILTER (WHERE status = 'hired')                          AS yollangan,
     count(*) FILTER (WHERE created_at > $1)                           AS yangi
   FROM driver_applicants`,
  [since],
).catch((err) => {
  if (err.code === '42P01') return null   // jadval hali yo'q
  throw err
})

if (app) {
  const a = app.rows[0]
  console.log(`driver_applicants\n`)
  console.log(`  jami nomzod       : ${a.jami}`)
  console.log(`  hozir ko'rinadi   : ${a.live}`)
  console.log(`  yollangan         : ${a.yollangan}`)
  console.log(`  yangi qo'shilgan  : ${a.yangi}\n`)
} else {
  console.log(`driver_applicants — jadval hali yo'q\n`)
}

// ---------------------------------------------------------------------
// Brokers (migration 013). Every name here is invented — see the migration
// header for why a real company must never carry a fabricated rating.
// ---------------------------------------------------------------------
const brokers = await pool.query(
  `SELECT credit_rating, count(*)::int AS n, min(days_to_pay) AS min_days, max(days_to_pay) AS max_days
     FROM brokers GROUP BY credit_rating ORDER BY credit_rating`,
).catch((err) => {
  if (err.code === '42P01') return null
  throw err
})

if (brokers) {
  const total = brokers.rows.reduce((sum, r) => sum + r.n, 0)
  console.log(`brokers — ${total} ta\n`)
  for (const r of brokers.rows) {
    console.log(`  ${r.credit_rating}: ${String(r.n).padStart(2)} ta   ${r.min_days}-${r.max_days} kunda to'laydi`)
  }
  const linked = await pool.query(
    `SELECT count(*) FILTER (WHERE broker_id IS NOT NULL)::int AS bogli,
            count(*) FILTER (WHERE broker_id IS NULL)::int     AS boglanmagan
       FROM load_postings WHERE status = 'open' AND expires_at > now()`,
  )
  const l = linked.rows[0]
  console.log(`\n  ochiq e'lonlardan broker_id bor: ${l.bogli}, yo'q: ${l.boglanmagan}`)
  console.log('')
} else {
  console.log("brokers — jadval hali yo'q (013 migratsiyasi qo'llanmagan)\n")
}

// ---------------------------------------------------------------------
// Fleet — what the student has actually built
// ---------------------------------------------------------------------
const fleet = await pool.query(`
  SELECT
    (SELECT count(*)::int FROM drivers)                                   AS haydovchi,
    (SELECT count(*)::int FROM trucks)                                    AS trak,
    (SELECT count(*)::int FROM loads)                                     AS yuk,
    (SELECT count(*)::int FROM loads WHERE status = 'neutral')            AS biriktirilmagan
`)
const f = fleet.rows[0]
console.log('park\n')
console.log(`  haydovchi        : ${f.haydovchi}`)
console.log(`  trak             : ${f.trak}`)
console.log(`  yuk              : ${f.yuk}  (biriktirilmagan: ${f.biriktirilmagan})\n`)

// ---------------------------------------------------------------------
// Truck listings — third market
// ---------------------------------------------------------------------
const truckListings = await pool.query(`
  SELECT
    (SELECT count(*)::int FROM truck_listings WHERE status = 'open' AND posted_at <= now() AND expires_at > now()) AS ochiq,
    (SELECT count(*)::int FROM truck_listings) AS jami,
    (SELECT count(*)::int FROM truck_listings WHERE bought_truck_id IS NOT NULL) AS sotilgan
`)
const tl = truckListings.rows[0]
console.log('trak bozori\n')
console.log(`  ochiq            : ${tl.ochiq}`)
console.log(`  jami             : ${tl.jami}`)
console.log(`  sotilgan         : ${tl.sotilgan}\n`)

await pool.end()
