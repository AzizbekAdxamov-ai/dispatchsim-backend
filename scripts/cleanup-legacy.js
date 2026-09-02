// Bir martalik tozalash: brokerlar qo'shilishidan (migration 013) oldin
// yaratilgan e'lonlar `broker_id IS NULL` bilan qolgan. Ular bozorda
// ko'rinadi, lekin ular bilan gaplashib bo'lmaydi — brokerChat.service.js
// `BROKER_UNAVAILABLE` qaytaradi. Talaba uchun bu boshi berk ko'cha.
//
//   node scripts/cleanup-legacy.js          (faqat sanaydi, o'chirmaydi)
//   node scripts/cleanup-legacy.js --apply  (o'chiradi)
//
// Faqat status='open' qatorlar o'chadi — bron qilinganlarga tegilmaydi.
// broker_conversations FK'si ON DELETE CASCADE, lekin brokersiz e'londa
// suhbat bo'lishi mumkin emas.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'

const apply = process.argv.includes('--apply')

const { rows } = await pool.query(
  `SELECT
     count(*)                                                          AS jami,
     count(*) FILTER (WHERE posted_at <= now() AND expires_at > now()) AS live
   FROM load_postings
   WHERE status = 'open' AND broker_id IS NULL`,
)
const { jami, live } = rows[0]

console.log(`\nbrokersiz ochiq e'lonlar: ${jami} ta (shundan hozir ko'rinadigan: ${live})`)

if (!apply) {
  console.log("o'chirish uchun: npm run cleanup:legacy -- --apply\n")
  await pool.end()
  process.exit(0)
}

const del = await pool.query(
  `DELETE FROM load_postings WHERE status = 'open' AND broker_id IS NULL`,
)
console.log(`o'chirildi: ${del.rowCount} ta\n`)

await pool.end()
