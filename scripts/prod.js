// Bitta buyruqni production bazasiga qarshi ishga tushiradi.
//
//   npm run prod -- mig:status
//   npm run prod -- migrate
//   npm run prod -- sql:check
//   npm run prod -- refresh:postings
//
// Nega bu bor: oldin `.env` ichida ikkita DATABASE_URL turardi, biri
// izohga olingan. Ularni almashtirish uchun har safar izoh belgisini
// ko'chirish kerak edi — va shu tarzda bir kuni `reset:company` noto'g'ri
// bazaga boradi. Endi DATABASE_URL hech qachon o'zgarmaydi: u lokal
// baza. Production faqat shu skript orqali, va faqat bitta buyruq uchun.
//
// Parol hech qayerga yozilmaydi — `.env` dan o'qiladi va bola jarayonga
// muhit o'zgaruvchisi sifatida beriladi. Ekranga chiqmaydi.

import 'dotenv/config'
import { spawn } from 'node:child_process'

const url = process.env.DATABASE_URL_PROD
if (!url) {
  console.error('DATABASE_URL_PROD .env ichida yo\'q.')
  process.exit(1)
}

const script = process.argv[2]
if (!script) {
  console.error('Qaysi buyruq? Masalan:  npm run prod -- mig:status')
  process.exit(1)
}

// Bularni production'da ishga tushirish deyarli har doim xato bo'ladi, va
// ularning har biri ma'lumot yo'qotadi. Skript ro'yxatga tayanmaydi —
// o'sha skriptlarning o'zida ham himoya bor (localhost bo'lmagan host
// uchun --allow-remote talab qilinadi) — lekin bu yerda to'xtash
// arzonroq: xato buyruq ishga tushishidan OLDIN.
const REFUSED = new Set(['reset:company', 'clear:fleet', 'seed', 'cleanup:legacy'])
if (REFUSED.has(script)) {
  console.error(`"${script}" production'da ishga tushirilmaydi — u ma'lumot o'chiradi.`)
  console.error('Rostdan kerak bo\'lsa, qo\'lda va ataylab qiling.')
  process.exit(1)
}

const host = (() => {
  try { return new URL(url).hostname } catch { return '(o\'qib bo\'lmadi)' }
})()

console.log(`\n  baza  : ${host}`)
console.log(`  buyruq: npm run ${script}\n`)

const child = spawn(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['run', script, ...process.argv.slice(3)],
  { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } },
)
child.on('exit', (code) => process.exit(code ?? 1))
