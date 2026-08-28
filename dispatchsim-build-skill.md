---
name: dispatchsim-build
description: DispatchSim — US logistika/dispatch sohasini o'rgatuvchi AI-simulator ilovasini qurish bo'yicha to'liq qo'llanma. React + Vite frontend, Docker orqali ishga tushirish. Loyihaning istalgan qismini (dashboard, login, loads, drivers va h.k.) qurishda yoki o'zgartirishda shu faylni o'qi.
---

# DispatchSim — qurilish qo'llanmasi

## Loyiha nima

DispatchSim — AQSh logistika/trucking sohasida ishlashni o'rgatuvchi ta'lim simulatori.
Yangi ishga kelgan yoki sohani o'rganmoqchi bo'lganlar uchun mo'ljallangan. Kompaniyalar
haqiqiy yuk va haydovchilar bilan risk qilmasdan xodimlarni shu orqali tayyorlaydi.

**MUHIM QOIDA:** bu "simulyatsiya" ekanligi UI'da hech qayerda ko'rsatilmaydi. User uchun
bu xuddi haqiqiy ish muhitidek tuyulishi kerak. "Simulation", "Scenario", "Score",
"Training" kabi so'zlar UI matnida ishlatilmaydi. Baholash "Dispatch status" nomi ostida,
xuddi broker/kompaniya tomonidan qo'yilgan real reyting kabi ko'rsatiladi.

Loads, drivers, brokerlar — barchasi AI tomonidan yaratiladi/boshqariladi. User faqat
inson rolini o'ynaydi: Dispatcher, HR yoki Moliyachi.

## Texnologik stack

- **Frontend**: React 18+ va Vite
- **Animatsiya — ikki kutubxona, vazifasiga qarab**:
  - **Framer Motion** — oddiy UI animatsiyalari: kartalar fade-in/slide-up,
    hover effektlari, sahifa o'tishlari (page transitions), modal/drawer
    ochilish-yopilishi. React komponentlari bilan tabiiy ishlaydi.
  - **GSAP** (`gsap-skills` orqali o'rnatilgan: `npx skills add
    https://github.com/greensock/gsap-skills --agent claude-code`) —
    murakkab timeline animatsiyalar: Speed/Fuel gauge strelkasining
    aylanishi, progress bar'larning ketma-ket (stagger) o'sishi, Cargo
    Layout'dagi kartochkalarning birin-ketin paydo bo'lishi, va SVG bilan
    bog'liq har qanday aniq animatsiya. React'da `gsap-react` skill'idagi
    `useGSAP` hook orqali ishlatiladi.
  - Qaysi holatda qaysi birini tanlash: agar animatsiya bitta komponent
    holatini almashtirsa (ochiq/yopiq, hover) — Framer Motion. Agar bir
    nechta element ketma-ket/vaqt bo'yicha aniq boshqarilishi kerak bo'lsa
    (masalan gauge strelkasi 0 dan 62 mph'gacha aniq egri chiziq bo'ylab
    yursin) — GSAP.
  - Barcha animatsiyalar silliq (ease), keskin bo'lmasin. Referens daraja:
    Linear, Vercel, Notion uslubi.
- **Chartlar**: Recharts — On-Time Delivery, Fleet Utilization Trend kabi grafiklar uchun
- **Styling**: CSS variables orqali (pastdagi token jadvaliga qara) — hech qachon
  hardcoded rang ishlatilmasin, chunki theme almashtirish imkoniyati bo'lishi kerak
- **Konteynerlashtirish**: Docker — quyidagi "Docker sozlamasi" bo'limiga qara
- **Ikonkalar**: oddiy inline SVG yoki Tabler Icons (agar kutubxona qo'shilsa)

## Dizayn tokenlari (CSS variables)

Loyiha ikkita theme variantini qo'llab-quvvatlaydi: **dark** (asosiy, tanlangan) va
kelajakda **light/cream**. Har doim CSS custom properties orqali yoz, `:root` va
`[data-theme="dark"]` / `[data-theme="light"]` orqali almashtiriladigan qilib qur.

```css
:root[data-theme="dark"]{
  --bg:#0C0F14; --panel:#12161D; --panel-2:#171C25; --panel-3:#1D2330;
  --border:#242A36; --border-soft:#1B212B;
  --text:#EDEFF3; --text-2:#8992A3; --text-3:#565E6E;
  --accent:#D9F35C; --accent-dim:#3A3F1E;
  --blue:#5B8DEF; --green:#4ADE80; --amber:#F5B942; --red:#F0605C;
}
:root[data-theme="light"]{
  --bg:#F7F2EA; --panel:#FFFDF9; --panel-2:#F1EAE0; --panel-3:#EAE1D2;
  --border:#E4DACB; --border-soft:#EAE1D2;
  --text:#3A3229; --text-2:#8A7D6B; --text-3:#B0A492;
  --accent:#3B7DD8; --accent-dim:#E4EDFB;
  --blue:#3B7DD8; --green:#3E9558; --amber:#C97F1F; --red:#C4453B;
}
```

Font: Inter (UI matn uchun), IBM Plex Mono (raqamlar/ID lar uchun — load ID, rate,
timestamp kabi).

## Sahifa tuzilmasi

1. **Login / Registratsiya** — rol tanlash (Dispatcher/HR/Moliyachi), kompaniya nomi.
   Fon: truck rasmi ustida shaffof/glass karta (backdrop-filter: blur).
2. **Dashboard** — sidebar (Dashboard, Loads, Drivers, Broker chat, Alerts, Documents,
   Dispatch status, Settings), topbar (timezone strip: EST/CST/PST, notification icon,
   telefon icon), alert strip, stat cards, load board jadvali, live tracking kartasi
   (speed/fuel gauge, HOS hisoblagichi).
3. **Fake phone widget** — pastki o'ng burchakda, "incoming call" animatsiyasi,
   Accept/Decline. User roliga qarab Driver AI yoki Broker AI bilan gaplashadi.

## Dashboard qo'shimcha komponentlari (Haulix darajasi)

Referens: Haulix (Phenomenon studiyasi) fleet-operations dashboardi. Quyidagi
komponentlar dashboard sahifasiga qo'shiladi, MVP doirasida:

- **On-Time Delivery Performance chart** — haftalik on-time/delayed foizi, area
  chart (Recharts kutubxonasi). X: kun nomlari, Y: 0-100%.
- **Fleet/Load Utilization Trend** — bar chart, haftalik faollik. Hover'da tooltip
  (masalan "Utilization: 38%, Distance: 1344.7 mi").
- **Alert Priority Queue** — kritik/warning holatlar ro'yxati, chap tomonda rangli
  chiziq (border-left: qizil=critical, sariq=warning), har birida "Resolve" (check)
  va "View" (ko'z) tugmalari.
- **Recent Activity feed** — vaqt tartibida oxirgi hodisalar (geofence, fuel,
  trip departure va h.k.), timestamp bilan.
- **Driver Management board** — kanban uslubida ustunlar: Driving / Resting /
  Off Duty. Har bir kartada: rasm/avatar, ism, CDL raqami, email, soatlar
  (bugun/hafta), reyting (star), qo'ng'iroq va "break" tugmalari.
- **Live tracking kartasi** — allaqachon qurilgan (speed/fuel gauge, HOS
  ogohlantirish, progress bar) — shu darajada qoladi.

**Cargo Layout** (yuk joylashuvi ko'rinishi):
- **Haqiqiy 3D emas** — statik, tekis (2D) yon ko'rinish. Truck real rasm (PNG,
  shaffof fon) sifatida `src/assets/truck-side.png` da saqlanadi.
- **Rang sxemasi — bu bo'lim uchun alohida**: oq fon (`#FFFFFF`), binafsha accent
  (`#6E3FF3`), status ranglar (critical=qizil, high=amber, normal=ko'k,
  low=kulrang). Dashboardning qolgan qismi dark theme'da qoladi — bu bo'lim
  atayin kontrastli "oq karta" sifatida ajralib turadi.
- **Konteyner kartochkalarini kuzov ICHIGA aniq joylashtirish (muhim, nozik ish)**:
  1. Kartochka grid'i `position: absolute` bilan truck rasmi ustiga qo'yiladi,
     lekin `top/left/right/bottom` — TO'RTTASI HAM foizda aniq belgilanadi
     (faqat width/height emas), shunda grid aynan kuzov ichida qoladi.
  2. Har bir truck rasmining kuzov chegarasi har xil — shuning uchun bu
     koordinatalarni "ko'zga chamalab" emas, quyidagi usul bilan aniqla:
     dev muhitda rasmni ochib, brauzer DevTools orqali kuzovning ichki
     to'rtburchagi (yuk qo'yiladigan bo'sh joy) chegaralarini o'lchab ol,
     keyin foizga aylantir.
  3. Kartochkalar kabinaga, g'ildiraklarga yoki kuzov chetiga TEGMASLIGI kerak —
     kuzov ichida kichik margin qoldir.
  4. Grid: 5 ustun x 2 qator = 10 kartochka, `grid-template-rows: repeat(2, 1fr)`
     bilan, kartochka balandligi kuzov balandligiga moslashsin.
  4b. **Hozirgi `truck-side.png` (2048×724 px) uchun tekshirilgan aniq qiymatlar**
     (agar rasm o'zgarmasa, to'g'ridan-to'g'ri shuni ishlat):
     ```css
     .cargo-grid{
       position:absolute;
       top:16.6%; left:30.8%; right:5%; bottom:51.7%;
       display:grid;
       grid-template-columns:repeat(5,1fr);
       grid-template-rows:repeat(2,1fr);
       gap:6px;
     }
     ```
  5. Kartochka matni siqilib ketmasin — agar joy kichik bo'lsa, font-size'ni
     kamaytirgandan ko'ra, truck rasmini kattaroq ko'rsat (truck-box balandligini
     oshir), shunda kuzov ichida kartochkalar uchun yetarli joy bo'ladi.
  6. **TEKSHIRISH SHART**: har o'zgarishdan keyin skrinshot olib, o'zing ko'r —
     kartochkalar kuzov ichida, o'qilishi oson va chiroyli tartibda ekanini
     tasdiqlaganingdan keyingina foydalanuvchiga ko'rsat.
- **`format-detection` meta tag qo'sh** (`<meta name="format-detection"
  content="telephone=no">`) — SHP-8841 kabi ID raqamlar telefon raqami sifatida
  ko'k rangga bo'yalmasligi uchun.
- Pastda ‹ › strelka tugmalar (vizual, MVP'da funksional bo'lishi shart emas).
- O'ng tomonda: konteynerlar ro'yxati (bosilganda tanlanadi) + tanlangan
  konteynerning detali (client, destination, weight, volume, risk score bar).
- Komponent: `components/dashboard/CargoLayout.jsx`, kichik komponentlarga bo'linadi:
  `CargoTruck` (rasm + grid overlay), `CargoList`, `CargoDetail`.

Chart kutubxonasi: **Recharts** (React bilan tabiiy integratsiya, sodda API).
Barcha chart ranglari CSS variables'dan olinadi (--blue, --accent, --green va h.k.),
hardcoded hex ishlatilmaydi.

Har bir yangi sahifa/komponent shu tuzilmadagi rang, shrift va spacing tokenlariga
qat'iy amal qilsin — ranglarni "ko'zga chiroyli ko'rinadi" asosida emas, yuqoridagi
jadvaldan tanlansin.

## Komponent arxitekturasi

```
src/
  components/
    layout/       Sidebar, Topbar, AppShell
    dashboard/    StatCards, LoadBoard, LiveTrackingCard, AlertStrip,
                  OnTimeChart, UtilizationChart, AlertQueue, ActivityFeed
    drivers/      DriverBoard, DriverCard, DriverColumn
    widgets/      CallWidget, NotificationPanel
    auth/         LoginForm, SignupForm
  pages/          Dashboard, Loads, Drivers, Login, Settings
  theme/          tokens.css, ThemeProvider
```

Har bir komponent alohida fayl, props orqali sozlanadigan, hardcoded matn/rang
ichida qolmasligi kerak.

## Docker sozlamasi

Ikki muhit uchun: development (tez o'zgarish ko'rish) va production (yakuniy build).

**Dockerfile** (production, multi-stage):
```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

**Dockerfile.dev** (development, hot-reload bilan):
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host"]
```

**docker-compose.yml**:
```yaml
services:
  frontend:
    build:
      context: .
      dockerfile: Dockerfile.dev
    ports:
      - "5173:5173"
    volumes:
      - .:/app
      - /app/node_modules
```

Development uchun: `docker compose up`. Production build uchun:
`docker build -t dispatchsim .` va `docker run -p 8080:80 dispatchsim`.

## Yozish uslubi (UI matnlari)

- Sodda, tabiiy tilda — na haddan tashqari rasmiy, na sleng
- Har bir tugma nima qilishini aniq aytadi ("Yukni tasdiqlash", "Qo'ng'iroqni qabul qilish")
- Xato xabarlari — nima bo'lganini va nima qilish kerakligini aytadi, uzr so'ramaydi
- "Simulyatsiya", "test", "ball" kabi so'zlar taqiqlangan (yuqoridagi MUHIM QOIDAga qara)

## Qurish tartibi (bosqichlar)

1. Vite + React loyihasini yarat, Docker sozlamalarini qo'sh, so'ng
   `npx skills add https://github.com/greensock/gsap-skills --agent claude-code`
   orqali GSAP skill to'plamini o'rnat
2. Theme tizimini (CSS variables + ThemeProvider) birinchi qur — qolgan hamma narsa
   shunga tayanadi
3. Layout komponentlari (Sidebar, Topbar)
4. Dashboard sahifasi (stat cards, load board, live tracking)
5. Login/Signup sahifasi
6. Fake phone widget
7. Analytics: On-Time chart, Utilization chart, Alert Queue, Activity feed (Recharts)
8. Driver Management board (kanban: Driving/Resting/Off Duty)
9. Framer Motion (UI o'tishlari) va GSAP (gauge/timeline animatsiyalari) qo'sh
10. Cargo Layout (statik 2D SVG truck + grid kartochkalar, oq/binafsha rangda)
11. Docker orqali ishga tushirib tekshir

Har bir bosqichdan keyin loyihani ishga tushirib (`npm run dev` yoki
`docker compose up`) natijani ko'rsating — keyingi bosqichga o'tishdan oldin
foydalanuvchi tasdiqlashi kerak.
