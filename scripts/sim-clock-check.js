// sim_day() bazada haqiqatan kun qo'shyaptimi. Hech narsani o'zgartirmaydi.
//
//   npm run sim:check
//
// 033 ni npm test ushlamaydi -- testlar SQL funksiyani ishga tushira
// olmaydi, faqat JS'ni. Bu skript uchta faktni bazadan so'raydi:
//
//   1. bitta sim kun ichida sana o'zgarmasligi kerak
//   2. bir sim kun o'tishi kalendar sanasini aynan 1 kunga surishi kerak
//   3. epoxaning o'zi sim_day() bo'yicha epoxaning sanasiga tushishi kerak
//
// 120 (bir sim kun necha soniya) va 1 (kunlar farqi) src/constants/
// simClock.js'dagi REAL_MS_PER_SIM_DAY'dan hisoblanadi, qo'lda yozilmaydi --
// aks holda bu skript SQL bilan emas, o'z nusxasi bilan kelishib turadi.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'
import { REAL_SEC_PER_SIM_DAY } from '../src/constants/simClock.js'

const SIM_DAY_SECONDS = REAL_SEC_PER_SIM_DAY

let failed = false

function fail(label, detail) {
  failed = true
  console.error(`YIQILDI: ${label}`)
  console.error(`  ${detail}`)
}

try {
  // 1. Sim kun ichida sana o'zgarmaydi.
  //
  // Nega 119 emas: bu fakt faqat KUN CHEGARASIDAN oldin to'g'ri. Skript
  // kun o'rtasida (masalan 98-saniyada) ishga tushsa, +119s ikki kunga
  // tegib o'tadi va to'g'ri funksiya ham farq qaytaradi. Shuning uchun
  // so'rov now()'ning o'z kun pozitsiyasidan hisoblanadi: hozirgi pozitsiya
  // (0..119) va chegara qolgan qismni topadi, farq shu qolgan qismning
  // yarimchasida tekshiriladi.
  {
    const { rows: [posRow] } = await pool.query(
      `SELECT EXTRACT(EPOCH FROM (now() - sim_epoch()))::int % $1 AS pos`,
      [SIM_DAY_SECONDS],
    )
    const pos = posRow.pos
    const within = Math.max(1, Math.floor((SIM_DAY_SECONDS - pos) / 2))
    const { rows: [row] } = await pool.query(
      `SELECT sim_day(now()) = sim_day(now() + ($1 * interval '1 second')) AS same`,
      [within],
    )
    if (row.same === true) {
      console.log(`OK   bitta sim kun ichida (+${within}s, kunning ${pos}-soniyasida) sana o'zgarmadi`)
    } else {
      fail(
        "bitta sim kun ichida sana o'zgarmasligi kerak",
        `sim_day(now()) != sim_day(now() + ${within}s) (kunning ${pos}-soniyasida)`,
      )
    }
  }

  // 2. Bitta sim kun (120 soniya) o'tishi sanani aynan 1 kunga suradi.
  {
    const { rows: [row] } = await pool.query(
      `SELECT (sim_day(now() + ($1 * interval '1 second')) - sim_day(now())) AS diff`,
      [SIM_DAY_SECONDS],
    )
    if (row.diff === 1) {
      console.log(`OK   ${SIM_DAY_SECONDS}s o'tishi sanani 1 kunga surdi`)
    } else {
      fail(
        'bitta sim kun bitta kalendar kun bo\'lishi kerak',
        `sim_day farqi ${row.diff}, 1 bo'lishi kerak edi (${SIM_DAY_SECONDS}s oralig'ida)`,
      )
    }
  }

  // 3. Epoxaning o'zi sim_day() bo'yicha o'z sanasiga tushadi -- nol nuqta.
  {
    const { rows: [row] } = await pool.query(
      `SELECT sim_day(sim_epoch()) = (sim_epoch() AT TIME ZONE 'UTC')::date AS matches,
              sim_day(sim_epoch())::text AS got,
              ((sim_epoch() AT TIME ZONE 'UTC')::date)::text AS want`,
    )
    if (row.matches === true) {
      console.log(`OK   sim_day(sim_epoch()) = epoxaning sanasi (${row.got})`)
    } else {
      fail(
        "epoxaning o'zi o'z sanasida turishi kerak",
        `sim_day(sim_epoch()) = ${row.got}, kutilgan ${row.want}`,
      )
    }
  }
} finally {
  await pool.end()
}

if (failed) {
  console.error('\nsim-clock-check: YIQILDI')
  process.exit(1)
}

console.log('\nsim-clock-check: hammasi OK')
