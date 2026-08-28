---
name: dispatchsim-polish
description: Mavjud DispatchSim frontend sahifalarini professional darajaga silliqlash — skrinshotlardan topilgan aniq nuqsonlar va tuzatish ko'rsatmalari. Sahifalar tayyor bo'lgach, "polish pass" o'tkazishda shu faylni o'qi.
---

# DispatchSim — Polish Pass

Bu fayl umumiy "yaxshi dizayn" maslahatlari emas — hozirgi qurilgan
prototiplarni ko'zdan kechirib topilgan **aniq nuqsonlar** ro'yxati.
Har birini alohida tekshir va tuzat.

## 1. Icon tizimi — eng muhim tuzatish

Hozir HTML entity/Unicode belgilar ishlatilgan (☏ ✉ ⌘ ⚙ va h.k.). Bular:
- Browser/OS bo'yicha turlicha render bo'ladi (ba'zi tizimlarda umuman
  ko'rinmasligi mumkin)
- Chiziq qalinligi, o'lchami boshqa UI elementlar bilan mos kelmaydi
- Professional SaaS mahsulotlarida hech qachon ishlatilmaydi

**Tuzatish:** butun loyiha bo'ylab **Lucide React** (`lucide-react`)
kutubxonasiga o'tish. Har bir joy:
- Sidebar nav: `LayoutDashboard`, `Package`, `Users`, `MessageSquare`,
  `AlertTriangle`, `FileText`, `Star`, `Settings`
- Topbar: `Phone`, `Mail`, `Bell`
- Boshqa joylar: `Search`, `Filter`, `Calendar`, `ChevronRight`,
  `ChevronLeft`, `X`, `Check`
Barcha ikonkalar bir xil `size` va `strokeWidth` bilan (masalan
`size={16} strokeWidth={1.75}`), komponent darajasida standartlashtirilgan.

## 2. Chat/scroll konteynerlar — overflow tuzatish

Load Detail sahifasidagi "Broker bilan yozishma" paneli va Broker Chat
sahifasidagi messages ro'yxati — ichidagi kontent panel chegarasidan
tashqariga chiqib ketishi mumkin. Tuzatish:
- Har bir scroll bo'ladigan ichki konteyner (`.chat-body`, `.messages`)da
  aniq `max-height` yoki flex parent ichida `min-height: 0` bo'lishi shart
  (flex child'ning default `min-height: auto` xatti-harakati overflow'ni
  buzadi)
- `overflow-y: auto` + panelning o'zida `overflow: hidden` (border-radius
  saqlanishi uchun)
- Load Detail'dagi kichik chat preview — balandligi cheklangan
  (`max-height: 200px`), "Barcha yozishmani ko'rish" havolasi qo'shiladi
  agar tarix uzun bo'lsa

## 3. Tugma vazni izchilligi

Filtr qatorida (Loads sahifasi: Broker/Sana/Status) barcha tugmalar **bir
xil vizual vaznda** bo'lishi kerak — birortasi boshqalaridan "muhimroq"
ko'rinmasin. Barchasi: `background: var(--panel)`, `border: 1px solid
var(--border)`, bir xil padding. Faqat asosiy CTA tugmalar (masalan "Call
broker", "+ Yangi") `--accent` fon bilan ajralib turadi — filtrlar emas.

## 4. Border-radius shkalasi — qat'iy standartlashtirish

Hozir 8px/10px/12px/14px aralash ishlatilgan. Belgilangan shkala:
```css
--radius-sm: 6px;   /* badge, tag, kichik tugma */
--radius-md: 8px;   /* input, oddiy tugma, kichik kartochka */
--radius-lg: 12px;  /* panel, katta karta, modal */
--radius-full: 999px; /* avatar, pill badge */
```
Har bir komponentda shu to'rttadan birini ishlat, oraliq qiymat (10px, 14px)
yo'q qilinsin.

## 5. State'larni class orqali boshqarish (inline style emas)

Cargo Layout'da tanlangan kartochka `style="border-color:var(--accent)"`
inline orqali belgilangan edi. Bu React'da noto'g'ri pattern. Tuzatish:
```jsx
<div className={`cargo-cell ${isSelected ? 'cargo-cell--selected' : ''}`}>
```
CSS'da `.cargo-cell--selected` klassi orqali barcha "tanlangan" stillar
(border, fon, shadow) bir joyda boshqariladi. Xuddi shu pattern har qanday
"active/selected/current" holatlar uchun qo'llanadi (nav-item, tab, list
qatorlar).

## 6. Spacing — 4px grid'ga qat'iy rioya

Hozirgi paddinglar orasida 9px, 11px, 13px kabi grid'dan chetga chiqqan
qiymatlar bor. Faqat 4 karrali qiymatlar ishlatilsin: 4, 8, 12, 16, 20, 24,
28, 32px. Bu vizual ritmni yaxshilaydi va Tailwind'ga o'tishni osonlashtiradi
(agar kelajakda kerak bo'lsa).

## 7. Bo'sh va xato holatlar (hozir yo'q)

Hech bir sahifada quyidagilar ko'rsatilmagan, qo'shilishi kerak:
- Loads ro'yxati bo'sh bo'lsa (filtr natija bermasa) — markazda ikonka +
  "Hech qanday load topilmadi" matni + filtrni tozalash tugmasi
  (dashboardsim-wire-up skillida aytilgan, lekin vizual dizayni hozir yo'q)
  bo'lishi kerak
- Broker chat'da suhbat tanlanmagan holat — o'ng panel bo'sh bo'lganda
  "Suhbatni tanlang" markazlashgan xabar
- Rasm/hujjat yuklanmasa — placeholder holat (broken image ikonkasi emas)

## 8. Fokus holatlari (accessibility)

Hozirgi prototiplarda `:focus` stillari yo'q — klaviatura orqali navigatsiya
qilganda hech narsa ko'rinmaydi. Har bir interaktiv element uchun:
```css
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

## Tekshirish tartibi

Har bir sahifani birma-bir och, yuqoridagi 8 bandni tekshir, tuzat, keyin
skrinshot olib solishtir (oldingi va keyingi holat). Faqat shundan keyin
keyingi sahifaga o't. Ustuvorlik tartibi: 1 (icon) → 2 (overflow) → 5
(state pattern) → qolganlari.
