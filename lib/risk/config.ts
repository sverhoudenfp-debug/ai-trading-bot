// ── CENTRALE RISICO-CONFIGURATIE (Fase 1) ─────────────────────────────
// ÉÉN plek voor álle hard-limieten van de engine. De AI (of welke agent
// dan ook) kan NOOIT buiten deze banden komen — de guards in
// lib/risk/engine.ts dwingen ze af in pure code.
//
// Alles is via env-vars te tunen (zie .env.example), maar de defaults zijn
// bewust conservatief: kapitaalbescherming gaat vóór winstoptimalisatie.

// ── Risico per trade (% van equity) ────────────────────────────────────
// De AI kiest vrij BINNEN deze band; validateAiProposal() clampt hard.
export const RISK_MIN_PCT = num(process.env.RISK_MIN_PCT, 0.25);
export const RISK_MAX_PCT = num(process.env.RISK_MAX_PCT, 1.0);
export const RISK_DEFAULT_PCT = num(process.env.RISK_DEFAULT_PCT, 0.5);

// ── Positiegrootte / exposure ───────────────────────────────────────────
export const MAX_NOTIONAL_PCT = num(process.env.MAX_NOTIONAL_PCT, 25);        // max notioneel per nieuwe trade (% van equity)
export const MAX_TOTAL_EXPOSURE_PCT = num(process.env.MAX_TOTAL_EXPOSURE_PCT, 50); // max totaal open (% van equity)
export const MAX_OPEN_POSITIONS = num(process.env.MAX_OPEN_POSITIONS, 4);     // max aantal gelijktijdige posities
export const CASH_BUFFER_PCT = num(process.env.CASH_BUFFER_PCT, 2);            // min 2% kas altijd vrijhouden

// ── Fee-aware trading ───────────────────────────────────────────────────
// Round-trip-kosten = 2×(fee + slippage). Een trade moet de fees ruimschoots
// kunnen verdienen, anders is de verwachte netto-edge negatief.
//   GUARD 1:  tp_pct ≥ ROUND_TRIP_COST_PCT × FEE_COVER_FACTOR   (default 0,6% × 2,5 = ≥1,5%)
//   GUARD 2:  (tp_pct − kosten) / (sl_pct + kosten) ≥ MIN_NET_RR (default ≥ 1,0)
// Beide guards moeten passeren; de AI kan dit NIET overrulen.
export const FEE_PCT = num(process.env.FEE_PCT, 0.25);
export const SLIPPAGE_PCT = num(process.env.SLIPPAGE_PCT, 0.05);
export const ROUND_TRIP_COST_PCT = 2 * (FEE_PCT + SLIPPAGE_PCT);
export const FEE_COVER_FACTOR = num(process.env.FEE_COVER_FACTOR, 2.5);
export const MIN_NET_RR = num(process.env.MIN_NET_RR, 1.0);

// ── Churn-bescherming: minimum houdtijd + cooldown ─────────────────────
export const MIN_HOLD_MIN = num(process.env.MIN_HOLD_MIN, 15);   // normale positie minimaal 15 min
export const COOLDOWN_MIN = num(process.env.COOLDOWN_MIN, 10);  // na een exit: 10 min geen nieuwe entry op dat pair

// ── Trade-frequency limieten ────────────────────────────────────────────
export const MAX_ENTRIES_PER_PAIR_PER_HOUR = num(process.env.MAX_ENTRIES_PER_PAIR_PER_HOUR, 2);
export const MAX_ENTRIES_PER_PAIR_PER_DAY = num(process.env.MAX_ENTRIES_PER_PAIR_PER_DAY, 6);
export const MAX_ENTRIES_PER_HOUR = num(process.env.MAX_ENTRIES_PER_HOUR, 8);
export const MAX_ENTRIES_PER_DAY = num(process.env.MAX_ENTRIES_PER_DAY, 20);

// ── Dagverlies + verlies-snelheid (circuit breakers) ────────────────────
// ADAPTIEF daglimiet (master-prompt): een circuit breaker, géén risico-knop.
// Limiet beweegt maximaal 1pp per afgesloten Amsterdamse handelsdag binnen
// de band [MIN, MAX]. Verhoogt NOOIT risk-per-trade / notional / exposure —
// die limits staan hierboven en worden door niets automatisch aangepast.
export const DAILY_LOSS_LIMIT_MIN_PCT = num(process.env.DAILY_LOSS_LIMIT_MIN_PCT, 5);    // hardere grens (−5%)
export const DAILY_LOSS_LIMIT_MAX_PCT = num(process.env.DAILY_LOSS_LIMIT_MAX_PCT, 15);   // ruimste grens (−15%)
export const DAILY_LOSS_LIMIT_DEFAULT_PCT = num(process.env.DAILY_LOSS_LIMIT_DEFAULT_PCT, 10); // start/-fallback (−10%)
export const DAILY_LOSS_MAX_ADJ_PP = num(process.env.DAILY_LOSS_MAX_ADJ_PP, 1);          // max |Δ| per dag, in percentagepunten
// Beslisdrempels (gekoppeld aan de bestaande risk-architectuur): de pot riskeert
// 0,25–1,0% per trade; een dagrendement ver buiten de ruis van één trade
// (±1%+) én met voldoende gesloten trades telt als "duidelijk". Extreem
// (>8%: verdacht — het daglimiet zelf haalt −10%) blokkeert verruiming.
export const DAILY_LOSS_POS_RETURN_PCT = num(process.env.DAILY_LOSS_POS_RETURN_PCT, 1.0);
export const DAILY_LOSS_NEG_RETURN_PCT = numSigned(process.env.DAILY_LOSS_NEG_RETURN_PCT, -2.0);
export const DAILY_LOSS_MIN_TRADES = num(process.env.DAILY_LOSS_MIN_TRADES, 5);
export const DAILY_LOSS_EXTREME_RETURN_PCT = num(process.env.DAILY_LOSS_EXTREME_RETURN_PCT, 8);
export const LOSS_VELOCITY_COUNT = num(process.env.LOSS_VELOCITY_COUNT, 3);    // ≥3 verliezen …
export const LOSS_VELOCITY_WINDOW_MIN = num(process.env.LOSS_VELOCITY_WINDOW_MIN, 60); // … binnen 60 min
export const LOSS_VELOCITY_PAUSE_MIN = num(process.env.LOSS_VELOCITY_PAUSE_MIN, 60);  // → 60 min géén entries

// ── AI-limieten ─────────────────────────────────────────────────────────
export const MAX_PROPOSALS_PER_RUN = num(process.env.MAX_PROPOSALS_PER_RUN, 2); // hard: max 2 voorstellen/run (code-level)
export const AI_SL_MIN_PCT = num(process.env.AI_SL_MIN_PCT, 1);
export const AI_SL_MAX_PCT = num(process.env.AI_SL_MAX_PCT, 10);
export const AI_TP_MIN_PCT = num(process.env.AI_TP_MIN_PCT, 0.5);
export const AI_TP_MAX_PCT = num(process.env.AI_TP_MAX_PCT, 15);
export const AI_MAX_CALLS_PER_HOUR = num(process.env.AI_MAX_CALLS_PER_HOUR, 30);
export const AI_MAX_CALLS_PER_DAY = num(process.env.AI_MAX_CALLS_PER_DAY, 240);
export const AI_MAX_COST_USD_PER_DAY = num(process.env.AI_MAX_COST_USD_PER_DAY, 3.0);

// ── Tijdzone van de handelsdag ─────────────────────────────────────────
export const TRADING_TIMEZONE = process.env.TRADING_TIMEZONE ?? "Europe/Amsterdam";

// ── Nieuws-fail-safe ───────────────────────────────────────────────────
// true (veiligst): is de nieuws-status onbekend/verlopen, dan worden nieuwe
// entries geblokkeerd (fail-closed). Exits en risicobeheer lopen altijd door.
export const NEWS_FAIL_CLOSED = (process.env.NEWS_FAIL_CLOSED ?? "true") === "true";
// Grace na de TTL van een alert voordat fail-closed intreedt
export const NEWS_STALE_GRACE_MIN = num(process.env.NEWS_STALE_GRACE_MIN, 10);

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}
function numSigned(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : d;
}
