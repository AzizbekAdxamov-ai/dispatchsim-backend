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
import { readFileSync } from 'node:fs'

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

// npm ISHGA TUSHIRILMAYDI.
//
// Birinchi versiya `npm run <script>` ni spawn qilardi va Windows'da
// darhol yiqildi: `Error: spawn EINVAL`. Node 18.20 dan beri `.cmd` va
// `.bat` fayllarni `shell: true` siz ishga tushirish taqiqlangan
// (CVE-2024-27980), `npm.cmd` esa aynan batch fayl.
//
// `shell: true` qo'shish ishlatardi, lekin u bilan birga qo'shtirnoq va
// bo'sh joy masalalari keladi — argument ichidagi probel buyruqni ikkiga
// bo'lib yuboradi. Buning o'rniga package.json dan skriptning O'ZI
// o'qiladi va `node` to'g'ridan-to'g'ri chaqiriladi. Qobiq umuman
// qatnashmaydi, ya'ni qochirish qoidalari ham kerak emas.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const command = pkg.scripts?.[script]
if (!command) {
  console.error(`package.json ichida "${script}" nomli skript yo'q.`)
  console.error(`Bor skriptlar: ${Object.keys(pkg.scripts ?? {}).join(', ')}`)
  process.exit(1)
}

// Deyarli hamma skript `node <fayl>` shaklida. Shu holatni aniq ushlaymiz
// va process.execPath bilan ishga tushiramiz — ya'ni AYNAN shu node.
const nodeScript = command.match(/^node\s+(?:--[\w-]+(?:=\S+)?\s+)*(\S+)(.*)$/)

console.log(`\n  baza  : ${host}`)
console.log(`  buyruq: ${command}\n`)

let child
if (nodeScript) {
  const flags = command.slice(4, command.indexOf(nodeScript[1])).trim()
  const extra = nodeScript[2].trim()
  child = spawn(
    process.execPath,
    [
      ...(flags ? flags.split(/\s+/) : []),
      nodeScript[1],
      ...(extra ? extra.split(/\s+/) : []),
      ...process.argv.slice(3),
    ],
    { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } },
  )
} else {
  // `node` bilan boshlanmaydigan skript. Qobiq orqali, chunki boshqa
  // yo'l yo'q — va shuning uchun bu holat alohida aytiladi.
  console.log('  (qobiq orqali ishga tushirilyapti)\n')
  child = spawn(command + (process.argv.slice(3).length ? ' ' + process.argv.slice(3).join(' ') : ''), {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, DATABASE_URL: url },
  })
}

child.on('error', (err) => {
  console.error(`\nIshga tushmadi: ${err.message}`)
  process.exit(1)
})
child.on('exit', (code) => process.exit(code ?? 1))
