# FASE 1 — Hardening (10 sep 2026)

De bot is in Fase 1 grondig gehard; zie `supabase-phase1-setup.sql` voor de
bijbehorende (optionele maar aanbevolen) migration en `.env.example` voor alle
nieuwe, centraal configureerbare limieten. Kort:

- **Risico per trade: 0,25–1,0% van de pot** (hard gecleand, was 5–10%).
- **Notional cap 25% van equity per trade; totaal open ≤ 50%; max 4 posities** (was: 95% van de kas).
- **Fee-guard:** trades waarvan de TP de ~0,6% round-trip-kosten niet ≥2,5× dekt of netto RR < 1,0 hebben, worden hard geblokkeerd.
- **Min-hold 15 min** op AI-exits (SL/TP/daglimiet/nieuws-high altijd toegestaan) + **cooldown 10 min per pair** na een exit.
- **Frequentie-limieten:** 2 entries/pair/uur, 6/pair/dag, 8/uur, 20/dag.
- **Daglimiet −5%** + verlies-snelheids-guard (≥3 verliezen in 60 min → 60 min pauze).
- **Atomaire claims + run-lock:** dubbele/gelijke-tijdige verwerking is onmogelijk (DB-niveau).
- **Strikte AI-output-validatie + max 2 voorstellen/run** (code-level).
- **AI-budget:** max 30 calls/uur, 240/dag, $3/dag — budget op → AI zwijgt, risicobeheer loopt door.
- **Handelsdag = Europe/Amsterdam** (was UTC).
- **BloFin-demo-reconciliation** elke tick + safety-guard: mirror werkt uitsluitend tegen het demo-host.
- Nog steeds volledig PAPER/DEMO — geen enkele live-activering mogelijk.

Tests: `npm test` (42 safety-tests). Type-check: `npm run typecheck`.

---

# AI Trading Bot — Silvijn Verhouden

AI-gestuurde crypto day-trading bot (BTC/EUR) met eigen dashboard.
Bouw ik in fasen — **niet** in één keer:

| Fase | Wat | Status |
|---|---|---|
| 1 | **Backtest** — strategie testen op historische data, geen geld | ✅ actief |
| 2 | **Paper trading** — live meekijken, gesimuleerde orders | volgende |
| 3 | **Live trading** — echte exchange-orders | pas na goed fase 2 |

## Architectuur (kort)
- **Één Next.js/TypeScript-app**: dashboard (React) + bot-logica (API-routes) samen.
- Vercel is serverless → geen 24/7-proces. Oplossing: een cron job pingt
  `/api/...` periodiek zodat de bot de markt checkt (fase 2+). Voor fase 1
  draait de backtest op verzoek via de knop of bij het openen van de pagina.
- **Data**: gratis publieke Bitvavo API (15m candles BTC-EUR, gratis). Voor fase 1 en 2
  is geen account nodig.
- **Exchange voor fase 3** is een config-keuze (`lib/exchange/`): de rest van de
  app merkt daar niets van. Keuze volgt na fase 2.

## Strategie: hybride (in lagen)
Fase 1 = **regel-kern**: koop de dip (lage RSI) zolang de trend hoger staat
(EMA-filter), met score-systeem. Dit is bewust de eerlijke baseline.
De ML-laag (GradientBoosting-achtig, zoals in het lokale Python-onderzoek)
komt hier bovenop zodra de baseline staat — dezelfde feature-pipeline.

## Risicobeheer (altijd actief)
- Stop-loss **−1,2%** en take-profit **+1,8%** per trade (intrabar gecontroleerd)
- Max **1%** risico per trade (positiegrootte wordt hiernaar berekend)
- **Daglimiet −3%**: bot stopt die dag automatisch
- Max **16 uur** houdtijd (day-trading)
- Elke actie wordt gelogd (orderhistorie in het dashboard)

## Wat zit waar?
```
lib/exchange/marketdata.ts   → data ophalen (publieke API, geen key)
lib/indicators.ts        → EMA, RSI, momentum, volatiliteit
lib/strategy.ts          → signalen + alle parameters (hier schuiven!)
lib/backtest.ts          → simulatie-engine met kosten & risicobeheer
app/api/backtest/route.ts→ API-route die de backtest draait
app/page.tsx             → het dashboard
```

## Lokaal draaien
```bash
npm install
npm run dev   # → http://localhost:3000
```

## Live op Vercel
1. vercel.com → **Continue with GitHub**
2. **Add New → Project** → importeer deze repository → **Deploy**

---

**Eerlijke waarschuwing.** Dit is een leerproject. Crypto is risicovol; je kunt
je inleg volledig verliezen. Een backtest kijkt alleen achterom en zegt niets
over de toekomst. Niets in deze repository is financieel advies.

## Fase 2 — Paper trading (multi-coin, long-only)

### Paper-live op het Blofin demo-account (optioneel)
Met `PAPER_LIVE=blofin` spiegel je de paper-trades 1-op-1 naar het
demo-account bij Blofin (`demo-trading-openapi.blofin.com`): long-only,
hefboom 1x, cross margin — virtueel geld, echte matching-engine.
Vereiste env-variabelen: `BLOFIN_API_KEY`, `BLOFIN_SECRET_KEY`,
`BLOFIN_PASSPHRASE` (demo-keys uit de Demo Trading-omgeving, alleen
Read+Trade-rechten). Fouten in de spiegeling breken de interne
simulatie nooit; het dashboard toont de Blofin-status in de feed.

De bot volgt 4 coins (BTC, ETH, SOL, XRP) met elk een eigen virtueel potje
van €1000, 24/7: long bij een verse RSI-dip in een stijgende trend.
Shorts zijn na het data-experiment van 8 sep 2026 UITGEZET (verloor in beide
testvensters); her-evaluatie na de paper-periode. Alle orders gesimuleerd.

## Setup (eenmalig, ~10 min)

De bot handelt gesimuleerd op live koersen. Drie stappen:

1. **Database** — plak `supabase-setup.sql` in Supabase → SQL Editor → Run
   (dit verwijdert de oude tabellen en maakt de multi-coin-versie aan).
2. **Environment variables in Vercel** (Settings → Environment Variables, daarna Redeploy):
   - `SUPABASE_URL` — je Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` — je service_role key
   - `PAPER_TOKEN` — een lang willekeurig geheim (bijv. uit `openssl rand -hex 20`)
3. **Cron-wekker** — maak een gratis account op cron-job.org → Add cron job:
   - URL: `https://JOUW-APP.vercel.app/api/paper/run?token=JOUW-PAPER_TOKEN`
   - Schedule: every 5 minutes
   - De bot checkt daarna zelfstandig de markt, elke 5 min, 24/7.

Geen echte orders in deze fase. Fase 3 (echt geld) start pas als fase 2
minstens een maand winstgevender dan buy&hold is — zie de roadmap.
