# 📋 DispatchSim Load Board — Hisobot

**Sana:** 28–29 avgust 2026  
**Loyiha:** dispatchsim-backend  
**Ish turi:** Load board tizimi — e'lonlar generatsiyasi, o'qish API, bron qilish

---

## Umumiy ko'rinish

AQSh logistika/dispatch sohasini o'rgatuvchi ta'lim simulatorining **load board** tizimi qurildi:
- E'lonlar (postings) seed orqali generatsiya qilinadi
- API orqali o'qiladi (filter, sort, deadhead)
- bron qilinadi (poyga, idempotentlik, ogohlantirishlar)

---

## 28 avgust — 2a: Seed poydevori

### Vazifa
Drivers va trucks jadvaliga yangi ustunlar qo'shish.

### O'zgartirilgan fayllar (6 ta):

| # | Fayl | O'zgarish |
|---|---|---|
| 1 | `scripts/seed/render.js` | `raw()` helper + `sqlLiteral()` ga `__raw` shoxi |
| 2 | `scripts/seed/validate.js` | `rateBandFor` ga `export` |
| 3 | `scripts/seed/build.js` | `randomCity()` obyekt; `buildDriverRow` ga `current_city/state/lat/lon`; `buildTruckRow` ga `trailer_type` (indeksdan); `DRIVER_COLUMNS`/`TRUCK_COLUMNS` yangilandi |
| 4 | `src/modules/drivers/drivers.repository.js` | +4 alias (`currentCity`, `currentState`, `currentLat`, `currentLon`) |
| 5 | `src/modules/fleet/trucks.repository.js` | +1 alias (`trailerType`) |

### Tekshiruv:
- ✅ Drivers/trucks — faqat yangi ustunlar, mavjud qiymatlar bayt-bayt bir xil
- ✅ Loads/maintenance/metrics — 0 qator o'zgarmagan

---

## 28 avgust — 2b: E'lonlar quvuri

### Vazifa
Postings generatsiya tizimi — 6 daraja, `now()`-nisbiy vaqtlar.

### Yaratilgan fayl (1 ta):

| # | Fayl | Vazifa |
|---|---|---|
| 1 | `scripts/seed/postings.js` | POSTING_CONFIG, TIERS (6 daraja), TIER_WEIGHTS, buildPostingRows |

### O'zgartirilgan fayllar (3 ta):

| # | Fayl | O'zgarish |
|---|---|---|
| 2 | `scripts/seed/build.js` | POSTING_COLUMNS, buildPostingRows integratsiyasi |
| 3 | `scripts/seed/render.js` | TRUNCATE ga `load_postings` |
| 4 | `scripts/generate-seed.js` | Postings kategoriyasi, FIXTURE_POSTINGS |

### Dry-run natijasi:
```
13 drivers, 5 trucks, 18 loads, 6 maintenance, 300 metrics, 12 postings
```

### Tekshiruvlar:
| # | Tekshiruv | Natija |
|---|---|---|
| 1 | Eski jadvallar tegilmagan | ✅ |
| 2 | Hovuz muzlamagan (12 × `now() + interval`) | ✅ |
| 3 | Taqiqlangan so'zlar | ✅ 0 ta |
| 4 | Determinizm (md5 bir xil) | ✅ |

---

## 28 avgust — 3a: API o'qish tomoni

### Vazifa
GET /load-board va GET /load-board/:id endpointlari.

### Yaratilgan fayllar (5 ta):

| # | Fayl | Vazifa |
|---|---|---|
| 1 | `src/modules/loadBoard/loadBoard.schemas.js` | Zod `.strict()` — filterlar |
| 2 | `src/modules/loadBoard/loadBoard.repository.js` | SQL: CTE + LEFT JOIN LATERAL (deadhead) |
| 3 | `src/modules/loadBoard/loadBoard.service.js` | Service qatlami |
| 4 | `src/modules/loadBoard/loadBoard.controller.js` | Controller — parse → service → JSON |
| 5 | `src/modules/loadBoard/loadBoard.routes.js` | requireAuth + requireRole(), GET /, GET /:id |

### O'zgartirilgan fayllar (2 ta):

| # | Fayl | O'zgarish |
|---|---|---|
| 6 | `src/app.js` | `/load-board` mount |
| 7 | `src/lib/errors.js` | `POSTING_NOT_FOUND` |

### Curl testlari:
| Tekshiruv | Natija |
|---|---|
| Tokenisiz → 401 | ✅ |
| `?limit=3` | ✅ |
| `equipmentType=dry-van` (kalit) | ✅ |
| `?sort=deadhead` | ✅ |
| `?maxDeadheadMi=500` | ✅ |
| `?originState=TX` | ✅ |
| `?bogus=1` → 400 | ✅ |
| `GET /:id` | ✅ |

---

## 29 avgust — 3b: API yozish tomoni (POST /book)

### Vazifa
Bron qilish — birinchi haqiqiy write endpoint. Poyga, idempotentlik, ogohlantirishlar.

### O'zgartirilgan fayllar (7 ta):

| # | Fayl | O'zgarish |
|---|---|---|
| 1 | `src/modules/loadBoard/loadBoard.repository.js` | `bookPostingAtomically`, `getPostingForIdempotent`, `setBookedLoadId`, `getFleetEquipmentKeys` |
| 2 | `src/modules/loadBoard/loadBoard.service.js` | `bookPosting` — withTransaction, race handling, PG error mapping, warnings |
| 3 | `src/modules/loadBoard/loadBoard.controller.js` | `bookPosting` handler |
| 4 | `src/modules/loadBoard/loadBoard.schemas.js` | `bookPostingSchema` |
| 5 | `src/modules/loadBoard/loadBoard.routes.js` | `POST /:id/book` + `bookLimiter` |
| 6 | `src/lib/errors.js` | 5 ta yangi xatolik kodi |
| 7 | `src/middleware/rateLimit.js` | `bookLimiter` (20/daqiqa) |

### Yaratilgan fayl (1 ta):

| # | Fayl | Vazifa |
|---|---|---|
| 1 | `src/modules/loads/loads.repository.js` | `createLoad(client, row)` |

### Bron jarayoni:
1. Atomar shartli UPDATE (`WHERE status='open' AND posted_at<=now() AND expires_at>now()`)
2. 0 qator → ajratish: yo'q → 404, men tomonidan → 200, boshqa → 409, o'tgan → 410
3. Load ID — `booked_load_id_seq` dan 6 raqamli
4. Loads INSERT — `status = driverId ? 'ontime' : 'neutral'`
5. FK link — `booked_load_id` alohida UPDATE
6. Ogohlantirishlar — COMMIT dan keyin, tranzaksiyadan tashqarida

### Tekshiruvlar:

| # | Tekshiruv | Natija |
|---|---|---|
| 1 | Book → 201 + load id 600004 | ✅ |
| 2 | Idempotent repeat → 200 + same load id | ✅ |
| 3 | Race condition → bitta 201, ikkinchisi 409 POSTING_TAKEN | ✅ |
| 4 | GET /loads/:id → load exists, status: ontime | ✅ |
| 5 | Posting gone from board → 0 visible | ✅ |

### Xatolik kodlari:
| Kod | HTTP | Sabab |
|---|---|---|
| `POSTING_NOT_FOUND` | 404 | E'lon topilmadi yoki kelajakda |
| `POSTING_TAKEN` | 409 | Boshqa dispatcheron bron qilgan |
| `POSTING_EXPIRED` | 410 | Muddati o'tgan |
| `DRIVER_HAS_ACTIVE_LOAD` | 409 | Haydovchining faol yuk'i bor |
| `LOAD_ID_UNAVAILABLE` | 409 | Load ID ketma-ketligi to'silgan |
| `DRIVER_NOT_AVAILABLE` | 400 | Haydovchi mavjud emas |

---

## 29 avgust — 3b tuzatishlar (5 ta nuqson)

### Nuqson 1: getPostingForIdempotent ajratish
**Muammo:** `posted_at > now()` (hali tomchilamagan e'lon) holatida xato kodi aniqlanmagan — board oldindan sanab chiqilardi.
**Tuzatish:** `bookPosting` dagi ajratish prioritetti:
- `status='booked'` + `bookedByUserId === userId` → idempotent 200
- `status='booked'` + boshqa user → POSTING_TAKEN 409
- `expires_at <= now()` → POSTING_EXPIRED 410
- `posted_at > now()` → POSTING_NOT_FOUND 404 (TAKEN yoki boshqa emas)

### Nuqson 2: Javob shakli 201/200 da bir xil
**Muammo:** 201 va 200 da javob shakli farq qilardi.
**Tuzatish:** Ikkala holatda ham `{ load, posting, warnings }`. Idempotent yo'lda `loadsRepo.getLoadById(bookedLoadId)` bilan yuk qayta o'qiladi.

### Nuqson 3: Xato xaritasi keng
**Muammo:** Barcha 23505/23514 xatolari xaritalanardi — foydalanuvchi noto'g'ri xabar olardi.
**Tuzatish:** Faqat 3 ta ma'lum constraint:
- `loads_one_active_per_driver_idx` → DRIVER_HAS_ACTIVE_LOAD
- `loads_pkey` → LOAD_ID_UNAVAILABLE
- `loads_pending_clean` → DRIVER_NOT_AVAILABLE
- BOSHQA hamma → 500 (real sabab logda ko'rinadi)

### Nuqson 4: truckId frontenddan olinardi
**Muammo:** Frontend `truckId` yuborardi — bu xavfli (falsified data).
**Tuzatish:** `bookPostingSchema` dan `truckId` olib tashlandi. Serverda `findTruckForDriver(client, driverId)` orqali topiladi: `SELECT id FROM trucks WHERE driver_id=$1 AND status<>'maintenance'`.

### Nuqson 5: collectWarnings har doim chaqirilishi kerak
**Muammo:** `driverId` bo'lmasa ogohlantirishlar chaqirilmaydi — eng ko'p ogohlantirish kerak bo'lgan holatda ogohlantirish yo'q.
**Tuzatish:** `collectWarnings(posting, driverId)` har doim chaqiriladi. Yangi ogohlantirishlar:
- `no-available-driver` — bo'sh haydovchi yo'q
- `no-matching-equipment` — fleet'da mos trailer yo'q
- `tight-pickup-window` — pickup 4 soatdan yaqin (yangi)

### Qo'shimcha: controller'dan console.error olib tashlandi
**Sabab:** `errorHandler.js` o'z ishini qiladi — ikkilamchi logging kerak emas.

### Tekshiruvlar (qayta ishga tushirilgan server):

| # | Tekshiruv | Natija |
|---|---|---|
| 1 | Book → 201 + load id 600011 | ✅ |
| 2 | Idempotent repeat → 200 + same load id | ✅ |
| 3 | Race condition → bitta 201, ikkinchisi 409 POSTING_TAKEN | ✅ |
| 4 | GET /loads/:id → load exists, status: ontime | ✅ |
| 5 | Posting gone from board → 0 visible | ✅ |

---

## Umumiy statistika

| Kategoriya | Soni |
|---|---|
| Yaratilgan fayllar | 8 |
| O'zgartirilgan fayllar | 13 |
| API endpointlar | 3 (GET /, GET /:id, POST /:id/book) |
| Xatolik kodlari | 6 |
| Seed darajalari | 6 (strong, marginal, trap-deadhead, trap-hos, trap-equipment, filler) |

### Seed natijasi (dry-run, seed 42):
```
13 drivers, 5 trucks, 18 loads, 6 maintenance, 300 metrics, 12 postings
```

---

## Muhim dizayn qarorlari

1. **Rng oqimi tozligi** — yangi ustunlar qo'shilsa ham, loads/maintenance/metrics o'zgarmadi
2. **Postings oxirida qurilgan** — boshqa jadvallarga ta'sir qilmaydi
3. **Trailer type indeksdan** — `COVERED_TYPES[i % 4]`, rng sarflanmagan
4. **40% backfill** — board darrov to'liq
5. **`now()` nisbiy vaqtlar** — seed har qachon yangi
6. **`raw()` helper** — SQL fragmentlarini sqlLiteral'dan o'tkazish
7. **Atomar poyga** — shartli UPDATE, boshqa hech narsa kerak emas
8. **Idempotentlik** — same user re-booking → 200 + same load id
9. **Ogohlantirishlar tranzaksiyadan tashqarida** — bronni hech qachon yiqitmaydi

---

*Generated with Codebuff 🤖*
