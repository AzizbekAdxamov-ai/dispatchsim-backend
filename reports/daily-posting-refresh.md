# Daily Posting Refresh — Hisobot

## O'zgartirilgan fayllar

| Fayl | Tur | O'zgarish |
|---|---|---|
| `scripts/seed/postings.js` | EDIT | Config sutkalikka, `avgLifetimeMin` hisoblash |
| `scripts/refresh-postings.js` | NEW | Kunlik refresh skripti, `runRefresh()` eksport |
| `src/jobs/dailyRefresh.js` | NEW | node-cron, startup check, catch-up |
| `src/server.js` | EDIT | `startJobs()` qo'shildi |
| `package.json` | EDIT | `refresh:postings` script, `node-cron` dep |

## A1 — postings.js vaqt oynasi

**Oldingi config:**
```js
poolTarget: 400, windowDays: 7, backfillHours: 12
```

**Yangi config:**
```js
poolTarget: 200, visibleTarget: 20, coverageHours: 26
```

**`avgLifetimeMin` hisoblash:**
```
visibleTarget (20) × coverageHours (26) × 60 / poolTarget (200) = 156 daqiqa
```

Har bir postingning umri: `max(20, 156 × (0.3 + rng × 1.4))` = ~47–273 daqiqa (o'rtacha ~156).

**Timestamp offsetlari:**
- Backfill (index < visibleTarget): `posted_at` = `-(1..lifetimeMin)` daqiqa oldin
- Kelajak: `posted_at` = `0..(coverageHours × 60)` daqiqa kelajakda
- `expires_at` = `posted_at + lifetimeMin`
- `pickup_at` = `expires_at + 60..2881`
- `delivery_at` = `pickup_at + transit`

## A2 — refresh-postings.js

- **Host guard:** localhost/127.0.0.1 majburiy, `--allow-remote` bilan ch除外
- **Eskilarni tozalash:** `DELETE FROM load_postings WHERE status='open' AND expires_at < now() - interval '2 days'` — `booked` qatorlarga tegmaydi
- **Haydovchilar bazadan:** `SELECT id, current_lat, current_lon, duty_status FROM drivers`
- **Generatsiya:** `batchSize: 10`, AI orqali, `validateLoadItem` bilan
- **INSERT:** parametrlangan ($1, $2, ...) — SQL fayl rendering yo'q
- **Hisobot:** so'ralgan / qabul qilingan / qo'shilgan / tozalangan + tier taqsimoti

## A3 — dailyRefresh.js

- **Cron:** `0 4 * * *` (kuniga 04:00)
- **Startup check:** server ishga tushganda `shouldRefresh()` chaqiriladi
- **Catch-up sharti:**
  - `live < visibleTarget / 2` (10 tadan kam), YOKI
  - `last_gen IS NULL`, YOKI
  - `last_gen < now() - interval '20 hours'`
- **Guard:** `running` flag — bir vaqtda faqat bitta refresh
- **Xato server'ni qulatmaydi** — try/catch ichida

## Tekshiruv buyruqlari va natijalar

```bash
# A1 — mutlaq umr raqami qolmaganini tekshir (bo'sh chiqishi kerak)
$ grep -nE "(720|2880|10080|windowDays|backfillHours)" scripts/seed/postings.js
EXIT: 1   ← bo'sh ✅

# A1 — hisoblangan umr bor (topilishi kerak)
$ grep -n "avgLifetimeMin" scripts/seed/postings.js
125:  const avgLifetimeMin = Math.round(
149:    // Per-posting lifetime: avgLifetimeMin ± 70% jitter, min 20 min
150:    const lifetimeMin = Math.max(20, Math.round(avgLifetimeMin * (0.3 + rng() * 1.4)))
EXIT: 0   ✅

# A2 — halokatli buyruq yo'qligi (comment'dagi TRUNCATE mustasno)
$ grep -nE "TRUNCATE|DROP |DELETE FROM (drivers|trucks|loads)" scripts/refresh-postings.js
2:// INSERTs them directly. Unlike generate:seed.js (which TRUNCATEs everything),
EXIT: 0   ← faqat comment ✅

# A2 — host qorovuli bor
$ grep -n "allow-remote" scripts/refresh-postings.js
7://   node scripts/refresh-postings.js --allow-remote   (skip host guard)
247:  if (host !== 'localhost' && host !== '127.0.0.1' && !process.argv.includes('--allow-remote')) {
248:    console.error(`refuses to write to ${host} without --allow-remote`)
EXIT: 0   ✅

# A2 — haydovchilar bazadan
$ grep -n "FROM drivers" scripts/refresh-postings.js
107:    `SELECT id, current_lat, current_lon, duty_status FROM drivers`,
EXIT: 0   ✅

# A3 — server'ga ulangan
$ grep -n "startJobs" src/server.js
7:import { startJobs } from './jobs/dailyRefresh.js'
11:  startJobs()
EXIT: 0   ✅

# Sintaksis — uchalasi ham
$ node --check scripts/seed/postings.js        ← OK
$ node --check scripts/refresh-postings.js     ← OK
$ node --check src/jobs/dailyRefresh.js        ← OK

# Har funksiya BIR MARTA yozilgan
$ grep -c "function runRefresh" scripts/refresh-postings.js   → 1 ✅
$ grep -c "function startJobs" src/jobs/dailyRefresh.js      → 1 ✅

# Quvur ishlaydi
$ npm run generate:seed -- --dry-run
totals: 13 drivers, 5 trucks, 18 loads, 6 maintenance records, 300 daily-metric rows, 12 postings ✅
```
