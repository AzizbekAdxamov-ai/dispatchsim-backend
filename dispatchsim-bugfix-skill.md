---
name: dispatchsim-bugfix
description: DispatchSim frontend'ida aniqlangan barcha buglarni tuzatish bo'yicha to'liq qo'llanma — equipment rasm/label mos kelmasligi, Cargo Layout dark theme buzilishi, va oldini olish uchun arxitektura qoidalari. Bug tuzatish ishlariga kirishdan oldin shu faylni to'liq o'qi.
---

# DispatchSim — Bug Fix Qo'llanmasi

## Umumiy qoida — ishni boshlashdan oldin

Har bir bug uchun: avval **sababini top** (nega yuz berdi), keyin tuzat, keyin
**barcha o'xshash joylarni** tekshir (bitta joyda bug bo'lsa, boshqa joyda ham
bo'lishi mumkin). Tuzatgandan keyin albatta skrinshot orqali tekshir — "tuzatdim"
deb aytishdan oldin ko'zing bilan tasdiqla.

---

## BUG #1 — Equipment rasm va label mos kelmaydi (ENG MUHIM)

### Nima kuzatilgan
- Load #4471: badge "Dry Van" deb yozilgan, lekin rasmda Reefer (muzlatgich
  bloki bilan) ko'rsatilgan
- Load #4472: badge "Reefer" deb yozilgan, lekin rasmda oddiy Dry Van
  ko'rsatilgan (muzlatgich bloki yo'q)
- Ya'ni Dry Van va Reefer rasmlari **bir-biri bilan almashtirilgan**

### Nega yuz bergan (ehtimoliy sabab)
Rasm va matn label ikki xil joydan, bir-biriga bog'lanmagan holda olinган —
"single source of truth" yo'q edi.

### Tuzatish — majburiy arxitektura

**1-qadam:** `src/data/equipmentTypes.js` faylini yarat (agar yo'q bo'lsa) yoki
qayta yoz — bu equipment haqidagi BARCHA ma'lumotning yagona manbai:

```js
export const EQUIPMENT_TYPES = {
  'dry-van':    { label: 'Dry Van',    image: '/assets/equipment/dry-van.png',    color: 'var(--accent)' },
  'reefer':     { label: 'Reefer',     image: '/assets/equipment/reefer.png',     color: 'var(--blue)' },
  'flatbed':    { label: 'Flatbed',    image: '/assets/equipment/flatbed.png',    color: 'var(--amber)' },
  'step-deck':  { label: 'Step Deck',  image: '/assets/equipment/step-deck.png',  color: 'var(--purple)' },
  'tanker':     { label: 'Tanker',     image: '/assets/equipment/tanker.png',     color: 'var(--red)' },
  'power-only': { label: 'Power Only', image: '/assets/equipment/power-only.png', color: 'var(--text-2)' },
};
```

**2-qadam:** Mock load ma'lumotlarida (`src/data/mockData.js` yoki qayerda
bo'lsa) har bir load'da equipment **faqat kalit sifatida** saqlansin:

```js
{ id: '4471', equipmentType: 'dry-van', ... }
{ id: '4472', equipmentType: 'reefer', ... }
```

Hech qachon `equipment: "Dry Van, 53ft"` kabi erkin matn saqlanmasin — uzunlik
(`53ft`) alohida maydon (`equipmentLength`) sifatida saqlanadi, label esa
har doim `EQUIPMENT_TYPES` dan generatsiya qilinadi.

**3-qadam:** Vehicle rasmi ko'rsatiladigan HAR BIR joy (Load Detail sahifasi,
Loads jadvalidagi Equipment ustuni, Cargo Layout, equipment popover) — barchasi
**faqat** `EQUIPMENT_TYPES[load.equipmentType]` dan o'qisin. Hech qayerda
equipment nomi yoki rasm yo'li qo'lda (hardcoded string) yozilmasin.

**4-qadam:** Barcha mavjud load'larning `equipmentType` qiymatini tekshir va
tuzat:
- #4471 → hozir noto'g'ri 'reefer' rasmiga ulangan, `'dry-van'` bo'lishi kerak
- #4472 → hozir noto'g'ri 'dry-van' rasmiga ulangan, `'reefer'` bo'lishi kerak
- Qolgan barcha load'larni (#4473, #4474, #4475 va h.k.) ham tekshir

**5-qadam:** 6 ta rasm faylining o'zini tekshir (`public/assets/equipment/`
papkasida) — fayl nomi va undagi tasvir mos kelishi SHART:
- `dry-van.png` — oddiy yopiq tekis panelli kuzov, muzlatgich bloki YO'Q
- `reefer.png` — old qismida muzlatgich bloki (kichik quti/panjara shakli) BOR
- `flatbed.png` — ochiq tekis platforma
- `step-deck.png` — ikki pog'onali platforma, ko'p o'qli
- `tanker.png` — silindrsimon sisterna
- `power-only.png` — faqat tortuvchi, trailer yo'q

Agar fayllar noto'g'ri nomlangan bo'lsa (masalan ichida boshqa surat), fayllarni
qayta nomlab chiq, kodni o'zgartirma — fayl nomi manba hisoblanadi.

**6-qadam (tasdiqlash):** Har bir load'ni (#4471 dan #4475 gacha) birma-bir
brauzerda ochib, Vehicle bo'limidagi badge matni va rasm bir-biriga mosligini
tekshir. Skrinshot ol, har birida label va rasm turi bir xil ekanini ko'rsat.

---

## BUG #2 — Cargo Layout dark theme'da buzilgan edi (TUZATILGAN, tekshir)

### Nima kuzatilgan edi
Dark theme versiyasida truck rasmi juda kichik, pastga siqilib, kartochkalar
bilan mos kelmay qolgan edi.

### Hozirgi holat
Keyingi skrinshotlarda bu tuzatilganga o'xshaydi — truck katta va to'g'ri
joyda. Lekin quyidagilarni tasdiqlash kerak:

- Light va dark theme'da Cargo Layout **bir xil komponent** ekanligini
  tekshir (ikki marta yozilgan alohida kod bo'lmasin — bo'lsa, birlashtir)
- `cargo-grid` koordinatalari (`top/left/right/bottom` foizlar) ikkala
  theme'da bir xil qiymatda ekanligini tekshir, chunki ular rasmning o'ziga
  nisbatan hisoblangan, theme'ga bog'liq emas
- Ikkala theme'da ham skrinshot olib, truck va kartochkalar joylashuvi bir xil
  sifatda ekanligini tasdiqla

---

## BUG #3 — Umumiy "single source of truth" tekshiruvi

Bug #1 kabi muammolar boshqa joyda ham takrorlanmasligi uchun, quyidagilarni
ham tekshir:

- **Driver ma'lumotlari** — Drivers sahifasidagi va Load Detail'dagi
  "Assigned driver" bo'limidagi ma'lumot (ism, CDL, HOS) bitta manbadan
  (`mockData.js`dagi drivers massivi) kelishini tekshir, ikki joyda alohida
  yozilmagan bo'lsin
- **Broker ma'lumotlari** — Broker Chat sahifasi va Load Detail'dagi broker
  nomi/logotipi bir xil manbadan kelsin
- **Stat raqamlari** — Dashboard'dagi "Active loads: 12" va Loads
  sahifasidagi haqiqiy load soni bir xil hisoblansin (ikkalasi ham
  `loads.length` yoki mos filtrdan, hardcoded raqam emas)

## Tekshirish tartibi (bu skill uchun)

1. `equipmentTypes.js` faylini yarat/tuzat (Bug #1, 1-qadam)
2. Mock data'dagi barcha load'larning `equipmentType` maydonini tuzat
3. Barcha equipment ko'rsatiladigan komponentlarni shu yagona manbaga ulash
4. 6 ta rasm faylini tekshirib, noto'g'ri nomlanganlarini tuzat
5. Har bir load'ni ochib, mosligini skrinshot bilan tasdiqla
6. Cargo Layout'ni ikkala theme'da solishtirib tekshir
7. Bug #3'dagi boshqa "single source of truth" joylarini audit qil
8. Yakuniy hisobot: nechta load tekshirilgani, nechta xato topilgani va
   tuzatilgani haqida qisqa xulosa chiqar
