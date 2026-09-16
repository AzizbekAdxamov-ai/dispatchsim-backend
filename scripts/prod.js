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

// Ma'lumot o'chiradigan skriptlar. Ular production'da ham KERAK bo'ladi —
// masalan test boshlanishidan oldin kompaniyani tozalash — lekin tasodifan
// emas.
//
// Birinchi versiya ularni BUTUNLAY rad etardi. Bu noto'g'ri edi: hech
// qachon bekor qilib bo'lmaydigan himoya odamni uni chetlab o'tishga
// majbur qiladi — DATABASE_URL ni qo'lda qo'yib ishga tushirishga — va
// o'shanda bu skriptdagi himoyaning HAMMASI yo'qoladi: host ham
// ko'rsatilmaydi, ogohlantirish ham bo'lmaydi.
//
// Endi ular ishlaydi, lekin buyruqda host nomi AYNAN yozilishi kerak.
// Ya'ni "reset qilaman" demak yetarli emas — qaysi bazani reset
// qilayotganingizni yozib berishingiz kerak. Noto'g'ri bazaga yozilgan
// buyruq shu yerda to'xtaydi, ichida emas.
const DESTRUCTIVE = new Set(['reset:company', 'clear:fleet', 'seed', 'cleanup:legacy'])

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

if (DESTRUCTIVE.has(script)) {
  const confirmed = process.argv.includes(`--confirm-host=${host}`)
  if (!confirmed) {
    console.error(`\n"${script}" ma'lumot o'chiradi.\n`)
    console.error(`  baza: ${host}`)
    console.error('')
    console.error('Davom etish uchun host nomini buyruqqa yozing:')
    console.error(`  npm run prod -- ${script} --confirm-host=${host}`)
    console.error('')
    console.error('Bu ortiqcha yozuv emas: yagona himoya sifatida "ha" deb')
    console.error('javob berish, noto\'g\'ri terminalda ham xuddi shunday oson.')
    process.exit(1)
  }
  console.error(`\n  ${host} — MA'LUMOT O'CHIRILADI\n`)
}

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
      ...process.argv.slice(3).filter((a) => !a.startsWith('--confirm-host=')),
      // --allow-remote HAR BIR skriptga beriladi.
      //
      // Skriptlarning o'z himoyasi ("localhost bo'lmasa --allow-remote
      // talab qilaman") tasodifan production'ga tegib ketishdan saqlaydi.
      // Bu skript esa ta'rifi bo'yicha tasodif emas: uning butun vazifasi
      // production'ga murojaat qilish, va host ekranga chiqariladi.
      //
      // Avval u faqat DESTRUCTIVE ro'yxatidagilarga berilardi, va
      // `refresh:postings` o'sha ro'yxatda emas edi -- natijada board'ni
      // to'ldirish buyrug'i ishlamay qoldi, sababi esa foydalanuvchi hech
      // qachon so'ramagan bayroq edi.
      //
      // Haqiqiy himoya --confirm-host: u ma'lumot o'chiradigan skriptlar
      // uchun ALOHIDA ishlaydi va bu qatordan mustaqil.
      '--allow-remote',
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
