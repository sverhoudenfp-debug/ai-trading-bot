// ── FASE 3: paper-monitoring, drift-detectie en rollback-triggers ────────
// Meet per actieve strategy version de ÉCHTE paper-prestaties (paper_orders)
// tegen de research-verwachtingen, en bepaalt deterministisch:
//   INSUFFICIENT_DATA (nog geen oordeel mogelijk) | OK | WARN | ROLLBACK.
// Alle drempels uit lib/evolution/config.ts — de AI heeft hier geen stem.

import { listOrdersSince } from "@/lib/paper/store";
import type { PaperOrderExt } from "@/lib/paper/store";
import {
  PAPER_MIN_TRADES, PAPER_MIN_OBSERVATION_HOURS, PAPER_MIN_NET_PNL_EUR,
  PAPER_MIN_EXPECTANCY_EUR, PAPER_MIN_PROFIT_FACTOR,
  ROLLBACK_MAX_LOSS_EUR, ROLLBACK_MAX_LOSS_STREAK, ROLLBACK_MAX_DRAWDOWN_PCT,
  ROLLBACK_MAX_FEE_SHARE_PCT, ROLLBACK_MAX_TRADES_PER_DAY,
  DRIFT_WARN_EXPECTANCY_FACTOR, DRIFT_ROLLBACK_EXPECTANCY_NEG, DRIFT_WARN_DD_FACTOR,
  CANARY_MAX_TRADES_PER_DAY, ROLLBACK_ERROR_COUNT,
} from "./config";

export interface PaperMetrics {
  trades: number;            // gesloten trades
  wins: number; losses: number;
  winratePct: number;
  grossPnl: number; fees: number; slippage: number; netPnl: number;
  expectancyEur: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  avgHoldMin: number; longestHoldMin: number;
  maxLossStreak: number;
  feeSharePct: number;       // fees / (gross + fees) — fee-burn maatstaf
  tradesPerDay: number;
  observationHours: number;
  rejections: number; riskBlocks: number; cooldownBlocks: number; feeBlocks: number; errors: number;
}

export interface MonitorVerdict {
  state: "INSUFFICIENT_DATA" | "OK" | "WARN" | "ROLLBACK";
  triggers: string[];
  warnings: string[];
  metrics: PaperMetrics;
  drift: string;             // leesbare backtest-vs-paper vergelijking
}

interface ExpectedFromResearch {
  expectancyEur: number;     // OOS-verwachting per trade
  netPnl: number;
  maxDrawdownPct: number;
  avgHoldMin: number;
  fees: number;
  trades: number;
}

/** Pure berekening uit paper-orders (vanaf activated_at) + verwachtingen. */
export function computeMonitorVerdict(args: {
  orders: PaperOrderExt[];     // gesloten orders (pnl_eur != null) sinds activatie
  entries: number;             // aantal entries sinds activatie
  blocked: { rejections: number; risk: number; cooldown: number; fee: number; errors: number };
  activatedAt: string;
  isCanary: boolean;
  expected: ExpectedFromResearch;
  now?: Date;
}): MonitorVerdict {
  const now = args.now ?? new Date();
  const closed = args.orders.filter((o) => o.pnl_eur !== null && o.pnl_eur !== undefined);
  const wins = closed.filter((o) => (o.pnl_eur ?? 0) > 0);
  const losses = closed.filter((o) => (o.pnl_eur ?? 0) <= 0);
  const netPnl = closed.reduce((a, o) => a + (o.pnl_eur ?? 0), 0);
  // Fase 4-fix: de echte exit-context gebruikt gross_pnl_eur/fees_eur/
  // slippage_eur (snake_case met _eur); oude key-namen als fallback.
  const grossSum = closed.reduce((a, o) => {
    const ctx = (o as { context?: { gross_pnl_eur?: number; gross?: number } }).context ?? {};
    return a + (ctx.gross_pnl_eur ?? ctx.gross ?? o.pnl_eur ?? 0);
  }, 0);
  const feeSum = closed.reduce((a, o) => {
    const ctx = (o as { context?: { fees_eur?: number; fees?: number } }).context ?? {};
    return a + (ctx.fees_eur ?? ctx.fees ?? 0);
  }, 0);
  const slipSum = closed.reduce((a, o) => {
    const ctx = (o as { context?: { slippage_eur?: number; slippage?: number } }).context ?? {};
    return a + (ctx.slippage_eur ?? ctx.slippage ?? 0);
  }, 0);

  const holds = closed.map((o) => (o as { context?: { hold_min?: number } }).context?.hold_min ?? 0).filter((x) => x > 0);
  const avgHoldMin = holds.length ? Math.round(holds.reduce((a, b) => a + b, 0) / holds.length) : 0;
  const longestHoldMin = holds.length ? Math.max(...holds) : 0;

  // equity-curve voor drawdown (start = 1000-referentie)
  // Fase 4-fix: running peak — puur stijgende curve = 0% drawdown
  let eq = 1000; let runPeak = 1000; let maxDD = 0;
  for (const o of closed) {
    eq += o.pnl_eur ?? 0;
    runPeak = Math.max(runPeak, eq);
    if (runPeak > 0) maxDD = Math.max(maxDD, ((runPeak - eq) / runPeak) * 100);
  }
  const maxDrawdownPct = maxDD;

  // verlies-streak
  let streak = 0, maxStreak = 0;
  for (const o of closed) {
    if ((o.pnl_eur ?? 0) <= 0) { streak += 1; maxStreak = Math.max(maxStreak, streak); }
    else streak = 0;
  }

  const grossProfit = wins.reduce((a, o) => a + (o.pnl_eur ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((a, o) => a + (o.pnl_eur ?? 0), 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : null;

  const observationHours = Math.max(0, (now.getTime() - new Date(args.activatedAt).getTime()) / 3_600_000);
  const tradesPerDay = observationHours >= 1 ? args.entries / (observationHours / 24) : args.entries;

  const metrics: PaperMetrics = {
    trades: closed.length, wins: wins.length, losses: losses.length,
    winratePct: closed.length ? Math.round((wins.length / closed.length) * 1000) / 10 : 0,
    grossPnl: r2(grossSum), fees: r2(feeSum), slippage: r2(slipSum), netPnl: r2(netPnl),
    expectancyEur: closed.length ? r2(netPnl / closed.length) : 0,
    profitFactor: pf === null ? null : Math.round(pf * 100) / 100,
    maxDrawdownPct: Math.round(maxDrawdownPct * 10) / 10,
    avgHoldMin, longestHoldMin,
    maxLossStreak: maxStreak,
    feeSharePct: grossSum + feeSum > 0 ? Math.round((feeSum / (Math.abs(grossSum) + feeSum)) * 100) : 0,
    tradesPerDay: Math.round(tradesPerDay * 10) / 10,
    observationHours: Math.round(observationHours * 10) / 10,
    rejections: args.blocked.rejections, riskBlocks: args.blocked.risk,
    cooldownBlocks: args.blocked.cooldown, feeBlocks: args.blocked.fee,
    errors: args.blocked.errors,
  };

  // ── drift vs research (Deel 27: "BACKTEST +100 / PAPER −50" zichtbaar) ──
  const drift =
    `backtest(OOS): exp €${args.expected.expectancyEur}/trade · DD ${args.expected.maxDrawdownPct}% · fees €${args.expected.fees} || ` +
    `paper: exp €${metrics.expectancyEur}/trade · DD ${metrics.maxDrawdownPct}% · fees €${metrics.fees} || ` +
    `Δexp €${r2(metrics.expectancyEur - args.expected.expectancyEur)}/trade`;

  // ── oordeel ────────────────────────────────────────────────────────────
  const triggers: string[] = [];
  const warnings: string[] = [];

  if (closed.length < PAPER_MIN_TRADES || observationHours < PAPER_MIN_OBSERVATION_HOURS) {
    return {
      state: "INSUFFICIENT_DATA",
      triggers: [],
      warnings: [`nog geen oordeel: ${closed.length}/${PAPER_MIN_TRADES} trades, ${metrics.observationHours}/${PAPER_MIN_OBSERVATION_HOURS}u observatie`],
      metrics, drift,
    };
  }

  // rollback-triggers (hard)
  if (netPnl <= ROLLBACK_MAX_LOSS_EUR) triggers.push(`netto €${r2(netPnl)} ≤ €${ROLLBACK_MAX_LOSS_EUR}`);
  if (maxStreak >= ROLLBACK_MAX_LOSS_STREAK) triggers.push(`${maxStreak} verliezen op rij (≥ ${ROLLBACK_MAX_LOSS_STREAK})`);
  if (metrics.maxDrawdownPct > ROLLBACK_MAX_DRAWDOWN_PCT) triggers.push(`drawdown ${metrics.maxDrawdownPct}% > ${ROLLBACK_MAX_DRAWDOWN_PCT}%`);
  if (metrics.feeSharePct >= ROLLBACK_MAX_FEE_SHARE_PCT) triggers.push(`fee-burn ${metrics.feeSharePct}% ≥ ${ROLLBACK_MAX_FEE_SHARE_PCT}%`);
  if (tradesPerDay > ROLLBACK_MAX_TRADES_PER_DAY) triggers.push(`excessieve frequentie ${metrics.tradesPerDay}/dag > ${ROLLBACK_MAX_TRADES_PER_DAY}`);
  if (metrics.expectancyEur <= DRIFT_ROLLBACK_EXPECTANCY_NEG) triggers.push(`paper-expectancy €${metrics.expectancyEur} ≤ €${DRIFT_ROLLBACK_EXPECTANCY_NEG}/trade`);
  if (metrics.errors >= ROLLBACK_ERROR_COUNT) triggers.push(`${metrics.errors} runtime-fouten`);
  if (args.isCanary && tradesPerDay > CANARY_MAX_TRADES_PER_DAY * 1.5) triggers.push(`canary frequentie ${metrics.tradesPerDay}/dag ruim boven limiet ${CANARY_MAX_TRADES_PER_DAY}`);

  // drift-waarschuwingen (zacht)
  if (args.expected.expectancyEur > 0 && metrics.expectancyEur < args.expected.expectancyEur * DRIFT_WARN_EXPECTANCY_FACTOR) {
    warnings.push(`expectancy-drift: paper €${metrics.expectancyEur} < ${DRIFT_WARN_EXPECTANCY_FACTOR}× verwacht €${args.expected.expectancyEur}`);
  }
  if (args.expected.maxDrawdownPct > 0 && metrics.maxDrawdownPct > args.expected.maxDrawdownPct * DRIFT_WARN_DD_FACTOR) {
    warnings.push(`drawdown-drift: paper ${metrics.maxDrawdownPct}% > ${DRIFT_WARN_DD_FACTOR}× verwacht ${args.expected.maxDrawdownPct}%`);
  }

  // paper-validation-criteria (Deel 10) — voor PAPER_VALIDATING-evaluatie
  if (netPnl < PAPER_MIN_NET_PNL_EUR) triggers.push(`netto €${r2(netPnl)} < minimum €${PAPER_MIN_NET_PNL_EUR}`);
  if (metrics.expectancyEur < PAPER_MIN_EXPECTANCY_EUR) triggers.push(`expectancy €${metrics.expectancyEur} < €${PAPER_MIN_EXPECTANCY_EUR}`);
  if (pf !== null && pf < PAPER_MIN_PROFIT_FACTOR) triggers.push(`profit factor ${pf} < ${PAPER_MIN_PROFIT_FACTOR}`);

  if (triggers.length) return { state: "ROLLBACK", triggers, warnings, metrics, drift };
  if (warnings.length) return { state: "WARN", triggers, warnings, metrics, drift };
  return { state: "OK", triggers, warnings, metrics, drift };
}

/** Verzamel blocking-statistieken per strategie uit signals/outcomes (read-only). */
export function blockedStatsFromSignals(signals: { strategy_version?: string | null; outcome?: string | null }[], prefix: string): {
  rejections: number; risk: number; cooldown: number; fee: number; errors: number;
} {
  const mine = signals.filter((s) => (s.strategy_version ?? "").startsWith(prefix));
  return {
    rejections: mine.filter((s) => s.outcome === "rejected").length,
    risk: mine.filter((s) => (s.outcome === "blocked_risk")).length,
    cooldown: mine.filter((s) => s.outcome === "blocked_cooldown").length,
    fee: mine.filter((s) => (s.outcome === "blocked_fee_edge")).length,
    errors: mine.filter((s) => s.outcome === "error").length,
  };
}

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}
