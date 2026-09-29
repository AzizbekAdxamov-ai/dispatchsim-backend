# Deploy

## Ikkita jadval, ikki xil joyda — va nega

Ilovada vaqtga bog'liq ikkita ish bor, va ular butunlay boshqa tezlikda ishlaydi.

| Ish | Qanchada bir | Kim chaqiradi |
|---|---|---|
| `/ops/tick` | har daqiqada | **tashqi rejalashtuvchi** |
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

# Ro'yxatdan o'tgan yangi foydalanuvchi qaysi rolni oladi.
#
# Qo'yilmasa — HECH QANDAY rol olmaydi va Pending sahifasida qoladi.
# Bu xato emas, shunday mo'ljallangan: yopiq kurs uchun invite kod
# ishlatiladi. Lekin ochiq test uchun bu degani — birinchi testchi
# ro'yxatdan o'tadi va hech narsa qila olmaydi, chunki rol beradigan
# admin hali yo'q.
#
# Ruxsat etilgan qiymatlar: dispatcher, hr, finance, fleet-manager
DEFAULT_ROLE=dispatcher

AI_BASE_URL=https://api.groq.com/openai/v1
AI_API_KEY=<groq kaliti>
AI_MODEL=qwen/qwen3.8-27b

CHAT_BASE_URL=https://openrouter.ai/api/v1
CHAT_API_KEY=<openrouter kaliti>
CHAT_MODEL=<chat:diag topgan model>
```

## 1a. Frontend uchun ham bitta o'zgaruvchi

Frontend backend manzilini `VITE_API_URL` dan oladi, standarti
`http://localhost:4000`. Vercel'da qo'yilmasa, deploy qilingan frontend
ishlab chiquvchining kompyuteridagi backendga urinadi — va foydalanuvchi
uchun bu "hech narsa yuklanmayapti" bo'lib ko'rinadi, hech qanday xatosiz.

Frontend loyihasining Environment Variables bo'limida:

```
VITE_API_URL=https://<backend>.vercel.app
```

⚠️ `VITE_*` o'zgaruvchilari **qurilish vaqtida** bog'lanadi, ishlash
vaqtida emas. Ya'ni o'zgartirgandan keyin **qayta deploy** qilish shart —
o'zgaruvchini qo'yib qo'yishning o'zi yetarli emas.

Ikkala manzil bir-biriga kerak (backend'ga `CORS_ORIGIN`, frontend'ga
`VITE_API_URL`), shuning uchun tartib shunday:

1. Ikkalasini ham deploy qiling (manzillar ma'lum bo'ladi)
2. O'zgaruvchilarni qo'ying
3. Ikkalasini ham qayta deploy qiling

---

`CRON_SECRET` — Vercel cron `Authorization: Bearer <CRON_SECRET>` yuboradi.
`OPS_TICK_SECRET` — tashqi rejalashtiruvchi `x-ops-secret` yuboradi. Marshrut ikkalasini
ham qabul qiladi, shuning uchun ikkovini bir xil qiling.

Sirsiz deploy qilsangiz endpoint **ishlamaydi va shunday deb aytadi** (`503
TICK_NOT_CONFIGURED`) — ochiq qolib, har kimga kompaniya soatini boshqarishga ruxsat
bermaydi.

## 2. Migratsiyalar

Lokal baza emas, **production bazasiga** qarshi. Parolni qo'lda yozish
kerak emas — `.env` ichidagi `DATABASE_URL_PROD` ishlatiladi:

```
npm run prod -- mig:status      # avval: nima qo'llangan, nima yo'q
npm run prod -- migrate
npm run prod -- sql:check       # 89
```

`npm run prod` bitta buyruqni production bazasiga qarshi ishga tushiradi
va qaysi hostga borayotganini boshida aytadi. `DATABASE_URL` ning o'zi
hech qachon o'zgarmaydi — u lokal baza bo'lib qoladi.

Ma'lumot o'chiradigan buyruqlar (`reset:company`, `clear:fleet`, `seed`,
`cleanup:legacy`) bu yo'l bilan **umuman ishlamaydi**. Bu ataylab: eng
qimmat xato — noto'g'ri bazaga yuborilgan reset.

## 3. Board'ni birinchi marta to'ldirish

```
npm run prod -- refresh:postings
```

Busiz birinchi foydalanuvchi bo'sh board ko'radi. `/ops/refresh` keyin o'zi davom
ettiradi.

## 3a. Birinchi admin (ixtiyoriy, lekin tavsiya etiladi)

`DEFAULT_ROLE=dispatcher` bilan har kim dispecher bo'ladi. Lekin kimgadir
HR yoki Moliyachi rolini qo'shish, yoki foydalanuvchilarni ko'rish uchun
admin kerak.

Avval ilovada ro'yxatdan o'ting, keyin:

```
npm run prod -- grant:admin sizning@email.com
```

Bu bir marta qilinadi. Keyingi adminlarni admin panelidan tayinlash
mumkin.

---

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
