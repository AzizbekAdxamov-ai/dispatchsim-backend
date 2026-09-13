# Deploy

## Ikkita jadval, ikki xil joyda — va nega

Ilovada vaqtga bog'liq ikkita ish bor, va ular butunlay boshqa tezlikda ishlaydi.

| Ish | Qanchada bir | Kim chaqiradi |
|---|---|---|
| `/ops/tick` | har daqiqada | **tashqi rejalashtiruvchi** |
| `/ops/refresh` | kuniga bir | Vercel cron (`vercel.json`) |

Tick har daqiqada kerak, chunki kompaniya soati siqilgan: **1 simulyatsiya kuni = 2 real
daqiqa** (`src/constants/simClock.js`). Tick yuklarni yetkazadi, hisob-fakturalarni
to'laydi, foiz va sug'urtani yozadi, yo'l hodisalarini chiqaradi. Kuniga bir marta
ishlaydigan tick — to'xtab qolgan o'yin.

Vercel'ning **Hobby** rejasi kuniga bir martadan tez-tez cron'ga ruxsat bermaydi, va
bunday `vercel.json` **deploy paytida xato bilan rad etiladi**:

> Hobby accounts are limited to daily cron jobs. This cron expression would run more
> than once per day.

Shuning uchun tick tashqaridan chaqiriladi. `src/modules/ops/ops.routes.js` aynan shu
uchun yozilgan — izohida turibdi: *"`x-ops-secret` for an external scheduler"*.

## 1. Muhit o'zgaruvchilari (Vercel → Settings → Environment Variables)

```
DATABASE_URL=<Neon yoki boshqa hostdagi postgres URL>
JWT_SECRET=<uzun tasodifiy satr>
CORS_ORIGIN=<frontend manzili, masalan https://dispatchsim.vercel.app>
NODE_ENV=production

OPS_TICK_SECRET=<uzun tasodifiy satr — tick va refresh uchun>
CRON_SECRET=<OPS_TICK_SECRET bilan BIR XIL>

AI_BASE_URL=https://api.groq.com/openai/v1
AI_API_KEY=<groq kaliti>
AI_MODEL=qwen/qwen3.8-27b

CHAT_BASE_URL=https://openrouter.ai/api/v1
CHAT_API_KEY=<openrouter kaliti>
CHAT_MODEL=<chat:diag topgan model>
```

`CRON_SECRET` — Vercel cron `Authorization: Bearer <CRON_SECRET>` yuboradi.
`OPS_TICK_SECRET` — tashqi rejalashtiruvchi `x-ops-secret` yuboradi. Marshrut ikkalasini
ham qabul qiladi, shuning uchun ikkovini bir xil qiling.

Sirsiz deploy qilsangiz endpoint **ishlamaydi va shunday deb aytadi** (`503
TICK_NOT_CONFIGURED`) — ochiq qolib, har kimga kompaniya soatini boshqarishga ruxsat
bermaydi.

## 2. Migratsiyalar

Lokal baza emas, **production bazasiga** qarshi:

```
DATABASE_URL=<production url> npm run migrate
DATABASE_URL=<production url> npm run sql:check
```

## 3. Board'ni birinchi marta to'ldirish

```
DATABASE_URL=<production url> npm run refresh:postings
```

Busiz birinchi foydalanuvchi bo'sh board ko'radi. `/ops/refresh` keyin o'zi davom
ettiradi.

## 4. Tashqi rejalashtiruvchi (tick)

[cron-job.org](https://cron-job.org) yoki UptimeRobot — bepul, daqiqalik:

- **URL**: `https://<sizning-backend>.vercel.app/ops/tick`
- **Method**: GET
- **Har**: 1 daqiqada
- **Header**: `x-ops-secret: <OPS_TICK_SECRET>`

Ishlayotganini tekshirish:

```
curl -H "x-ops-secret: <sir>" https://<backend>.vercel.app/ops/tick
```

Javob: `{"delivered":0,"paid":0,"late":0,"interestUsd":0,"insuranceUsd":0}` — nollar
normal, tick ishladi degani.

Tick **idempotent**: har bosqich shartli UPDATE, unique indeks yoki
`SELECT ... FOR UPDATE` bilan himoyalangan. Ikki marta chaqirilsa ham hech narsa ikki
marta sodir bo'lmaydi.

## 5. Refresh'ni tekshirish

```
curl -H "x-ops-secret: <sir>" https://<backend>.vercel.app/ops/refresh
```

Javob to'rttadan biri bo'ladi — `ran`, `cooldown`, `healthy`, `busy`, `failed`. Bular
farqlanadi, chunki "refreshed: false" uchta boshqa holatni yopib yuborardi va faqat
bittasi tekshirishga arziydi.

## Deploy'dan keyin nima jimgina buzilishi mumkin

- **Board bir kundan keyin bo'shab qoladi** → `/ops/refresh` chaqirilmayapti.
  Vercel → Logs → Crons bo'limida ko'ring.
- **Yuklar yetkazilmaydi, pul harakatlanmaydi** → tick chaqirilmayapti. Tashqi
  rejalashtiruvchi jurnalini ko'ring; 401 bo'lsa sarlavha noto'g'ri, 503 bo'lsa sir
  qo'yilmagan.
- **Chat "byudjet tugadi" deydi** → OpenRouter kunlik limiti. `npm run chat:usage`
  bugun necha so'rov ishlatilganini aytadi.
