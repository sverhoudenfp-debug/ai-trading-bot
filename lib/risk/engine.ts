// ── RISK ENGINE (Fase 1): alle harde guards als pure functies ───────────
// Elke guard is pure code — de AI (of wat dan ook) kan er niet omheen.
// De order-agent (lib/agents/orders.ts) roept ze aan vóór uitvoering.
// Getest in tests/risk-engine.test.ts.

import {
  RISK_MIN_PCT, RISK_MAX_PCT, RISK_DEFAULT_PCT,
  MAX_NOTIONAL_PCT, MAX_TOTAL_EXPOSURE_PCT, MAX_OPEN_POSITIONS, CASH_BUFFER_PCT,
  FEE_PCT, SLIPPAGE_PCT, ROUND_TRIP_COST_PCT, FEE_COVER_FACTOR, MIN_NET_RR,
  MIN_HOLD_MIN, COOLDOWN_MIN,
  MAX_ENTRIES_PER_PAIR_PER_HOUR, MAX_ENTRIES_PER_PAIR_PER_DAY,
  MAX_ENTRIES_PER_HOUR, MAX_ENTRIES_PER_DAY,
  LOSS_VELOCITY_COUNT, LOSS_VELOCITY_WINDOW_MIN, LOSS_VELOCITY_PAUSE_MIN,
} from "./config";
import { amsterdamDay } from "@/lib/time";

/** Compacte ordervorm voor de guards (komt overeen met paper_orders-rijen). */
export interface OrderLite {
  created_at?: string | null;
  pair: string;
  side: "buy" | "sell";
  pnl_eur: number | null; // null = entry-rij, getal = exit-rij
  reason?: string | null;
}

// ── 1. Risico per trade hard clampen ────────────────────────────────────
export function clampRiskPct(riskPct: number | null | undefined): number {
  if (!Number.isFinite(riskPct) || (riskPct ?? 0) <= 0) return RISK_DEFAULT_PCT;
  return Math.min(RISK_MAX_PCT, Math.max(RISK_MIN_PCT, Number(riskPct)));
}

// ── 2. Fee-aware expectancy guard ───────────────────────────────────────
// Een trade is pas zinvol als de verwachte beweging (TP) de round-trip-
// kosten ruim overtreft:
//   GUARD 1:  tp_pct ≥ ROUND_TRIP_COST_PCT × FEE_COVER_FACTOR
//   GUARD 2:  (tp_pct − ROUND_TRIP_COST_PCT) / (sl_pct + ROUND_TRIP_COST_PCT) ≥ MIN_NET_RR
// Met defaults (0,6% kosten, factor 2,5, RR ≥ 1,0) betekent dit:
// TP ≥ 1,5% én netto reward/risk na kosten ≥ 1,0.
export function feeGuard(
  slPct: number,
  tpPct: number
): { ok: boolean; reason: string; roundTripCostPct: number; netRR: number } {
  const cost = ROUND_TRIP_COST_PCT;
  const netRR = (tpPct - cost) / (slPct + cost);
  if (tpPct < cost * FEE_COVER_FACTOR) {
    return { ok: false, reason: `fee-guard: TP ${tpPct}% dekt de round-trip-kosten (${cost.toFixed(2)}% × ${FEE_COVER_FACTOR}) niet`, roundTripCostPct: cost, netRR };
  }
  if (netRR < MIN_NET_RR) {
    return { ok: false, reason: `fee-guard: netto reward/risk na kosten ${netRR.toFixed(2)} < ${MIN_NET_RR}`, roundTripCostPct: cost, netRR };
  }
  return { ok: true, reason: "fee-guard ok", roundTripCostPct: cost, netRR };
}

// ── 3. Position sizing met harde notional- en exposure-caps ────────────
export interface SizingInput {
  equity: number;
  cash: number;
  openNotional: number;   // som der open posities (notioneel)
  openPositions: number;  // aantal open posities
  entry: number;          // entry-prijs (incl. gesimuleerde slippage)
  slPct: number;
  riskPct: number;       // wordt eerst hard gecleand
}
export interface SizingResult {
  ok: boolean;
  reason: string;
  size: number;
  notional: number;
  riskPct: number;
}
export function sizePosition(inp: SizingInput): SizingResult {
  const riskPct = clampRiskPct(inp.riskPct);
  const riskAmount = (inp.equity * riskPct) / 100;
  let size = riskAmount / (inp.entry * (inp.slPct / 100));

  // harde caps (in volgorde)
  const maxNotional = (inp.equity * MAX_NOTIONAL_PCT) / 100;          // 25% van equity per trade
  const spendable = inp.cash * (1 - CASH_BUFFER_PCT / 100);           // kasbuffer altijd vrij
  const maxTotal = (inp.equity * MAX_TOTAL_EXPOSURE_PCT) / 100;      // 50% van equity totaal open
  const roomTotal = maxTotal - inp.openNotional;

  if (inp.openPositions >= MAX_OPEN_POSITIONS) {
    return { ok: false, reason: `exposure-guard: max ${MAX_OPEN_POSITIONS} gelijktijdige posities`, size: 0, notional: 0, riskPct };
  }
  if (roomTotal <= 0) {
    return { ok: false, reason: `exposure-guard: totaal open notioneel ${(MAX_TOTAL_EXPOSURE_PCT).toFixed(0)}% van equity al bereikt`, size: 0, notional: 0, riskPct };
  }
  const capNotional = Math.min(maxNotional, spendable, roomTotal);
  if (capNotional <= 0) {
    return { ok: false, reason: "sizing: onvoldoende kas voor de minimale positie", size: 0, notional: 0, riskPct };
  }
  size = Math.min(size, capNotional / inp.entry);

  const notional = size * inp.entry;
  if (size <= 0 || notional <= 0) {
    return { ok: false, reason: "sizing: berekende size ≤ 0", size: 0, notional: 0, riskPct };
  }
  // (equity − kosten) mag nooit onder nul
  if (inp.equity - notional <= 0) {
    return { ok: false, reason: "sizing: equity zou negatief worden", size: 0, notional: 0, riskPct };
  }
  return { ok: true, reason: "sizing ok", size, notional, riskPct };
}

// ── 4. Minimum houdtijd ─────────────────────────────────────────────────
// Normale AI-exits mogen pas na MIN_HOLD_MIN. Uitzonderingen (mogen altijd):
// SL/TP (worden vóór deze guard gecontroleerd), daglimiet, nieuws 'high'.
export function minHoldGuard(
  entryTimeIso: string | null,
  now: Date = new Date(),
  opts: { newsHigh?: boolean } = {}
): { ok: boolean; remainingMin: number } {
  if (opts.newsHigh) return { ok: true, remainingMin: 0 };
  if (!entryTimeIso) return { ok: true, remainingMin: 0 };
  const heldMin = (now.getTime() - Date.parse(entryTimeIso)) / 60_000;
  if (!Number.isFinite(heldMin)) return { ok: true, remainingMin: 0 };
  if (heldMin >= MIN_HOLD_MIN) return { ok: true, remainingMin: 0 };
  return { ok: false, remainingMin: Math.ceil(MIN_HOLD_MIN - heldMin) };
}

// ── 5. Cooldown na een exit (per pair) ──────────────────────────────────
export function cooldownGuard(
  orders: OrderLite[],
  pair: string,
  now: Date = new Date()
): { ok: boolean; remainingMin: number } {
  const lastExit = orders
    .filter((o) => o.pair === pair && o.pnl_eur !== null && o.created_at)
    .sort((a, b) => Date.parse(b.created_at!) - Date.parse(a.created_at!))[0];
  if (!lastExit || !lastExit.created_at) return { ok: true, remainingMin: 0 };
  const sinceMin = (now.getTime() - Date.parse(lastExit.created_at)) / 60_000;
  if (sinceMin >= COOLDOWN_MIN) return { ok: true, remainingMin: 0 };
  return { ok: false, remainingMin: Math.ceil(COOLDOWN_MIN - sinceMin) };
}

// ── 6. Frequency limits (per pair én totaal, per uur én per dag) ───────
export function frequencyGuard(
  orders: OrderLite[],
  pair: string,
  now: Date = new Date()
): { ok: boolean; reason: string } {
  const entries = orders.filter((o) => o.pnl_eur === null && o.created_at); // entries
  const hourAgo = now.getTime() - 60 * 60_000;
  const dayStr = amsterdamDay(now);

  const inHour = entries.filter((o) => Date.parse(o.created_at!) >= hourAgo);
  const inDay = entries.filter((o) => {
    try { return amsterdamDay(new Date(o.created_at!)) === dayStr; } catch { return false; }
  });

  const pairHour = inHour.filter((o) => o.pair === pair).length;
  const pairDay = inDay.filter((o) => o.pair === pair).length;
  if (pairHour >= MAX_ENTRIES_PER_PAIR_PER_HOUR) {
    return { ok: false, reason: `frequency-guard: ${pairHour} entries op ${pair} in het laatste uur (max ${MAX_ENTRIES_PER_PAIR_PER_HOUR})` };
  }
  if (pairDay >= MAX_ENTRIES_PER_PAIR_PER_DAY) {
    return { ok: false, reason: `frequency-guard: ${pairDay} entries op ${pair} vandaag (max ${MAX_ENTRIES_PER_PAIR_PER_DAY})` };
  }
  if (inHour.length >= MAX_ENTRIES_PER_HOUR) {
    return { ok: false, reason: `frequency-guard: ${inHour.length} totaal entries in het laatste uur (max ${MAX_ENTRIES_PER_HOUR})` };
  }
  if (inDay.length >= MAX_ENTRIES_PER_DAY) {
    return { ok: false, reason: `frequency-guard: ${inDay.length} totaal entries vandaag (max ${MAX_ENTRIES_PER_DAY})` };
  }
  return { ok: true, reason: "frequency ok" };
}

// ── 7. Verlies-snelheid (churn circuit breaker) ─────────────────────────
// ≥ LOSS_VELOCITY_COUNT verliezen binnen LOSS_VELOCITY_WINDOW_MIN minuten
// → geen nieuwe entries tot (laatste verlies + LOSS_VELOCITY_PAUSE_MIN).
export function lossVelocityGuard(
  orders: OrderLite[],
  now: Date = new Date()
): { paused: boolean; untilIso: string | null; reason: string } {
  const winStart = now.getTime() - LOSS_VELOCITY_WINDOW_MIN * 60_000;
  const losses = orders
    .filter((o) => o.pnl_eur !== null && o.pnl_eur < 0 && o.created_at && Date.parse(o.created_at) >= winStart)
    .sort((a, b) => Date.parse(a.created_at!) - Date.parse(b.created_at!));
  if (losses.length < LOSS_VELOCITY_COUNT) {
    return { paused: false, untilIso: null, reason: "velocity ok" };
  }
  const last = losses[losses.length - 1];
  const until = Date.parse(last.created_at!) + LOSS_VELOCITY_PAUSE_MIN * 60_000;
  if (now.getTime() >= until) {
    return { paused: false, untilIso: null, reason: "velocity-pauze afgelopen" };
  }
  return {
    paused: true,
    untilIso: new Date(until).toISOString(),
    reason: `velocity-guard: ${losses.length} verliezen binnen ${LOSS_VELOCITY_WINDOW_MIN} min — entries gepauzeerd tot ${new Date(until).toISOString().slice(11, 16)} UTC`,
  };
}

// ── 8. PnL-uitsplitsing: koers / fees / slippage / netto ────────────────
// Precies genoeg om later te kunnen zeggen: "slechte entries" vs
// "kleine edge die door fees vernietigd werd".
export interface PnlBreakdown {
  grossPnlEur: number;     // koersbijdrage
  feesEur: number;         // fee entry + exit (op de werkelijke handelsprijs)
  slippageEur: number;     // gesimuleerde slippage entry + exit
  netPnlEur: number;       // netto (≈ proceeds − cost)
}
export function pnlBreakdown(
  entryAdj: number,   // werkelijke entryprijs (incl. slippage)
  exitAdj: number,    // werkelijke exitprijs (incl. slippage)
  size: number,
  isLong: boolean
): PnlBreakdown {
  const entryRaw = isLong ? entryAdj / (1 + SLIPPAGE_PCT / 100) : entryAdj / (1 - SLIPPAGE_PCT / 100);
  const exitRaw = isLong ? exitAdj / (1 - SLIPPAGE_PCT / 100) : exitAdj / (1 + SLIPPAGE_PCT / 100);
  const gross = (isLong ? exitRaw - entryRaw : entryRaw - exitRaw) * size;
  const fees = (entryAdj + exitAdj) * size * (FEE_PCT / 100);
  const slip = Math.abs(entryAdj - entryRaw) * size + Math.abs(exitAdj - exitRaw) * size;
  return {
    grossPnlEur: round2(gross),
    feesEur: round2(fees),
    slippageEur: round2(slip),
    netPnlEur: round2(gross - fees - slip),
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
