> **Bu repo: `dispatchsim-backend`** — Express 5 + PostgreSQL API.
> Juftlik repo: `dispatchsim-frontend` (React 19 + Vite).
> Ikkalasi bitta mahsulot; quyidagi qoidalar ikkalasiga ham tegishli.

# DispatchSim — Claude uchun loyiha qoidalari

## Loyiha nima
AQSh logistika/dispatch sohasini oʻrgatuvchi taʼlim simulatori. User inson rolini oʻynaydi
(Dispatcher, HR, Moliyachi), loads/drivers/brokerlar AI tomonidan boshqariladi.

## ⛔ Eng qatʼiy qoida
UIʼda bu simulyatsiya ekanligi **hech qayerda koʻrsatilmaydi**.
Taqiqlangan soʻzlar: **Simulation, Scenario, Score, Training, Test**.
Baholash — "Dispatch status" nomi ostida, broker qoʻygan real reyting kabi.

## Kod qoidalari
- **Hardcoded rang yoʻq** — faqat CSS oʻzgaruvchilari (`var(--panel)`, `var(--text-2)`).
  Ikki theme bor: dark (asosiy) va light/cream
- **Hardcoded UI matni yoʻq** — komponent props orqali sozlanadi
- Barcha UI matni **ingliz tilida**
- `equipmentType` — har doim kalit (`'dry-van'`), hech qachon label (`'Dry Van'`).
  Yagona manba: `frontend/src/data/equipmentTypes.js`
- Font: Inter (matn), IBM Plex Mono (raqam va ID)
- Animatsiya: Framer Motion (oddiy holat) / GSAP `useGSAP` (murakkab timeline, gauge, SVG).
  Har doim silliq — referens: Linear, Vercel, Notion

## Batafsil qoʻllanmalar
| Fayl | Qachon |
|---|---|
| `dispatchsim-build-skill.md` | Yangi sahifa/komponent qurishda |
| `dispatchsim-polish-skill.md` | Polish pass — aniq nuqsonlar roʻyxati |
| `dispatchsim-bugfix-skill.md` | Bug tuzatishda |

## 🎯 BOSS — ish tartibi
Har vazifa quyidagi tartibda bajariladi:

```
1. TASHXIS  — vazifa murakkabligini baholang
              oddiy, aniq (bir joyni tuzatish) → toʻgʻridan-toʻgʻri coder
              murakkab/yangi                   → avval planner
2. PLANNER  — reja oling (agar kerak boʻlsa)
3. CODER    — reja boʻyicha kod yoziladi
4. REVIEWER — natija avtomatik tekshiriladi
              "TUZATISH KERAK" → coderʼga qaytadi (koʻpi bilan 3 marta)
              "QABUL QILINDI"  → keyingi qadam
5. XOTIRA   — natija Obsidian vaultʼga yoziladi
6. HISOBOT  — foydalanuvchiga qisqa xulosa
```

Subagentlar: `.claude/agents/planner.md`, `coder.md`, `reviewer.md`

**Ishni oʻzingiz bajarmang** — kod yozish `coder` ga, tekshirish `reviewer` ga
topshiriladi (Task tool orqali). BOSS faqat yoʻnaltiradi, xotiraga yozadi va hisobot
beradi. Sabab: (a) tekshiruvchi alohida boʻlgani uchun xatolar koʻproq ushlanadi,
(b) Pixel Agents kengaytmasi har subagentni alohida personaj sifatida koʻrsatadi —
BOSS ishni oʻzi qilsa, koʻrsatadigan narsa qolmaydi.

**Parallel ishlatish:** Pro limitini tez sarflaydi. Oddiy vazifada ketma-ket
(planner → coder → reviewer). Parallel — faqat chindan mustaqil qismlarga
boʻlinadigan katta vazifalarda.

## Avtonomlik
**Tasdiqsiz:** kod yozish/tuzatish/refactor, test, lokal commit, `dev` va `feature/*` ga push
**Tasdiq kerak:** `main` ga push yoki merge, tag yaratish, fayl oʻchirish, GitHub repo yaratish,
tashqi xizmatga yozish, email/xabar yuborish, pul bilan bogʻliq amallar

Tasdiq kerak boʻlsa — **bloklanmang**. Vaultʼdagi `06-Pending-Approval/` papkasiga yozib
qoʻying va boshqa vazifalarni davom ettiring.

## Xotira (Obsidian vault)
`C:\claudebrain\claude-brain` — markaz `00-MIYA.md`.
Har vazifa tugagach `03-Daily-Logs/` ga yozuv, loyiha holati `01-Projects/DispatchSim.md` ga.
Toʻliq qoidalar: vaultʼdagi `00-Claude-Instructions.md` va `00-Avtonomlik-qoidalari.md`.
