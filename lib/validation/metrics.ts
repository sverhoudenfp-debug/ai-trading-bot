// ── FASE 4: volledige paper-performance metrics per strategy-versie ───────
// Pure berekening uit paper_orders (met de Fase-1 snapshots in context).
// Meet ALLES na fees/slippage. Volledige scheiding met backtest-metrics:
// dit is een apart datatype dat nooit met research-metrics gemengd wordt.

import type { PaperOrderExt } from "@/lib/paper/store";
import {
  VAL_MAX_SINGLE_COIN_SHARE,
  VAL_AI_EXIT_MIN_AVG_HOLD_MIN, VAL_AI_EXIT_MAX_SHORT_PCT,
} from "./config";

// ── context-uitsplitsing (Fase 1-snapshots; oude keys als fallback) ──────
interface ExitCtx {
  gross_pnl_eur?: number; fees_eur?: number; slippage_eur?: number;
  net_pnl_eur?: number; hold_min?: number; exit_reason?: string;
  gross?: number; fees?: number; slippage?: number;
}
interface EntryCtx {
  rsi15?: number; above_ema200?: boolean; dist_ema50_pct?: number;
  day_hi?: number; day_lo?: number; expected_move_pct?: number;
  risk_pct?: number; setup_quality?: string;
}

export interface CoinStats {
  pair: string; trades: number; wins: number; netPnl: number; fees: number;
  expectancyEur: number; winratePct: number;
}
export interface RegimeStats {
  regime: string; trades: number; netPnl: number; winratePct: number;
}
export interface FullPaperMetrics {
  // volumes
  totalOrders: number;
  entries: number;
  closed: number; wins: number; losses: number;
  winratePct: number;
  // geld — NA fees/slippage waar relevant
  grossPnl: number; fees: number; slippage: number; netPnl: number;
  grossProfit: number; grossLoss: number;
  expectancyEur: number;
  avgTradeEur: number; avgWinEur: number; avgLossEur: number;
  profitFactor: number | null;
  feeShareOfProfitPct: number;   // fees / gross profit (Deel 11)
  feeContributionToLossPct: number; // fees als deel van totale kostenpost bij verlies
  // risico
  maxDrawdownPct: number;
  maxLossStreak: number; maxWinStreak: number;
  // tijd
  avgHoldMin: number; medianHoldMin: number; longestHoldMin: number;
  tradesPerDay: number; tradesPerHour: number; observationHours: number;
  activeDays: number;              // dagen met ≥1 entry (Deel 5)
  // AI-exit gedrag (Deel 24)
  aiExitCount: number;
  aiExitAvgHoldMin: number;
  aiExitShortPct: number;          // % AI-exits korter dan min-hold
  // verdelingen
  perCoin: CoinStats[];
  singleCoinSharePct: number;      // concentratierisico (Deel 15)
  concentrationRisk: boolean;
  perRegime: RegimeStats[];
  insufficientRegimeData: string[]; // regimes met < MIN samples
}

/** Regime-afleiding uit de entry-snapshot (boven/onder EMA-200 + afstand EMA50 + volatiliteit). */
export function regimeOfEntry(ctx: EntryCtx | undefined): string {
  if (!ctx || ctx.above_ema200 === undefined) return "unknown";
  const rangePct = ctx.day_hi && ctx.day_lo && ctx.day_lo > 0
    ? ((ctx.day_hi - ctx.day_lo) / ctx.day_lo) * 100 : 0;
  const volPart = rangePct >= 4 ? "high-volatility" : rangePct <= 1.5 ? "low-volatility" : "mid-volatility";
  const trendPart = ctx.above_ema200
    ? (ctx.dist_ema50_pct ?? 0) > 1 ? "uptrend" : "uptrend-sideways"
    : (ctx.dist_ema50_pct ?? 0) < -1 ? "downtrend" : "downtrend-sideways";
  return `${trendPart}/${volPart}`;
}

/** Hoofdberekening — pure functie, geen I/O. */
export function computeFullPaperMetrics(args: {
  orders: PaperOrderExt[];       // ALLE orders (entries + exits) sinds activatie
  activatedAt: string;
  now?: Date;
}): FullPaperMetrics {
  const now = args.now ?? new Date();
  const all = args.orders;
  const entries = all.filter((o) => o.pnl_eur === null || o.pnl_eur === undefined);
  const closed = all.filter((o) => o.pnl_eur !== null && o.pnl_eur !== undefined);
  const wins = closed.filter((o) => (o.pnl_eur ?? 0) > 0);
  const losses = closed.filter((o) => (o.pnl_eur ?? 0) <= 0);

  const ex = (o: PaperOrderExt): ExitCtx =>
    ((o as { context?: ExitCtx }).context ?? {});
  const en = (o: PaperOrderExt): EntryCtx | undefined =>
    (o.pnl_eur === null || o.pnl_eur === undefined)
      ? ((o as { context?: EntryCtx }).context ?? undefined)
      : undefined;

  const grossSum = closed.reduce((a, o) => a + (ex(o).gross_pnl_eur ?? ex(o).gross ?? o.pnl_eur ?? 0), 0);
  const feeSum = closed.reduce((a, o) => a + (ex(o).fees_eur ?? ex(o).fees ?? 0), 0);
  const slipSum = closed.reduce((a, o) => a + (ex(o).slippage_eur ?? ex(o).slippage ?? 0), 0);
  const netSum = closed.reduce((a, o) => a + (o.pnl_eur ?? 0), 0);

  const grossProfit = wins.reduce((a, o) => a + (o.pnl_eur ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((a, o) => a + (o.pnl_eur ?? 0), 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : null;

  const holds = closed.map((o) => ex(o).hold_min ?? 0).filter((x) => x > 0).sort((a, b) => a - b);
  const avgHoldMin = holds.length ? Math.round(holds.reduce((a, b) => a + b, 0) / holds.length) : 0;
  const medianHoldMin = holds.length
    ? Math.round(holds.length % 2 === 1 ? holds[(holds.length - 1) / 2] : (holds[holds.length / 2 - 1] + holds[holds.length / 2]) / 2)
    : 0;
  const longestHoldMin = holds.length ? Math.max(...holds) : 0;

  // equity-curve-drawdown vanaf activatie (referentie 1000).
  // Fase 4-fix: RUNNING peak — puur stijgende curve = 0% drawdown.
  let eq = 1000; let runPeak = 1000; let maxDD = 0;
  for (const o of closed) {
    eq += o.pnl_eur ?? 0;
    runPeak = Math.max(runPeak, eq);
    if (runPeak > 0) maxDD = Math.max(maxDD, ((runPeak - eq) / runPeak) * 100);
  }
  const maxDrawdownPct = maxDD;

  let streak = 0, maxStreak = 0, wStreak = 0, maxWStreak = 0;
  for (const o of closed) {
    if ((o.pnl_eur ?? 0) <= 0) { streak += 1; wStreak = 0; maxStreak = Math.max(maxStreak, streak); }
    else { wStreak += 1; streak = 0; maxWStreak = Math.max(maxWStreak, wStreak); }
  }

  const observationHours = Math.max(0, (now.getTime() - new Date(args.activatedAt).getTime()) / 3_600_000);
  const days = Math.max(1, observationHours / 24);
  const tradesPerDay = entries.length / days;
  const tradesPerHour = entries.length / Math.max(1, observationHours);

  // actieve dagen: UTC-dagen met ≥1 entry
  const daySet = new Set(entries.map((o) => String(o.created_at ?? "").slice(0, 10)));
  const activeDays = daySet.size;

  // AI-exit gedrag
  const aiExits = closed.filter((o) => {
    const r = String(ex(o).exit_reason ?? o.reason ?? "");
    return /ai/i.test(r) && !/sl\b|take.?profit|stop.?loss/i.test(r.replace(/[^a-z]/gi, ""));
  });
  const aiHolds = aiExits.map((o) => ex(o).hold_min ?? 0).filter((x) => x > 0);
  const aiExitAvgHoldMin = aiHolds.length ? Math.round(aiHolds.reduce((a, b) => a + b, 0) / aiHolds.length) : 0;
  const aiShort = aiExits.filter((o) => (ex(o).hold_min ?? 0) < VAL_AI_EXIT_MIN_AVG_HOLD_MIN).length;
  const aiExitShortPct = aiExits.length ? Math.round((aiShort / aiExits.length) * 100) : 0;

  // per-coin (Deel 15)
  const pairs = [...new Set(closed.map((o) => o.pair))];
  const perCoin: CoinStats[] = pairs.map((p) => {
    const mine = closed.filter((o) => o.pair === p);
    const myWins = mine.filter((o) => (o.pnl_eur ?? 0) > 0);
    const myNet = mine.reduce((a, o) => a + (o.pnl_eur ?? 0), 0);
    const myFees = mine.reduce((a, o) => a + (ex(o).fees_eur ?? ex(o).fees ?? 0), 0);
    return {
      pair: p, trades: mine.length, wins: myWins.length, netPnl: r2(myNet), fees: r2(myFees),
      expectancyEur: mine.length ? r2(myNet / mine.length) : 0,
      winratePct: mine.length ? Math.round((myWins.length / mine.length) * 1000) / 10 : 0,
    };
  });
  // concentratie: aandeel van de sterkste coin in de SOM van positieve netto's
  const posSum = perCoin.filter((c) => c.netPnl > 0).reduce((a, c) => a + c.netPnl, 0);
  const topCoin = perCoin.reduce((a, c) => (c.netPnl > a.netPnl ? c : a), { pair: "-", netPnl: 0 } as CoinStats);
  const singleCoinSharePct = posSum > 0 ? Math.round((topCoin.netPnl / posSum) * 100) : 0;
  const concentrationRisk = perCoin.length > 1 && topCoin.netPnl > 0
    && singleCoinSharePct > VAL_MAX_SINGLE_COIN_SHARE * 100;

  // per-regime (Deel 14) — regime uit de ENTRY-snapshot; exit koppelt op pair+tijdnabijheid
  const entryRegimes = new Map<string, string>(); // pair → laatste entry-regime vóór exit
  const regimeAcc = new Map<string, { trades: number; net: number; wins: number }>();
  const sorted = [...all].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  for (const o of sorted) {
    if (o.pnl_eur === null || o.pnl_eur === undefined) {
      entryRegimes.set(o.pair, regimeOfEntry(en(o)));
    } else {
      const reg = entryRegimes.get(o.pair) ?? "unknown";
      const acc = regimeAcc.get(reg) ?? { trades: 0, net: 0, wins: 0 };
      acc.trades += 1; acc.net += o.pnl_eur ?? 0;
      if ((o.pnl_eur ?? 0) > 0) acc.wins += 1;
      regimeAcc.set(reg, acc);
      entryRegimes.delete(o.pair);
    }
  }
  const MIN_REGIME = 10;
  const perRegime: RegimeStats[] = [...regimeAcc.entries()].map(([regime, a]) => ({
    regime, trades: a.trades, netPnl: r2(a.net),
    winratePct: a.trades ? Math.round((a.wins / a.trades) * 1000) / 10 : 0,
  }));
  const insufficientRegimeData = perRegime.filter((r) => r.trades < MIN_REGIME).map((r) => r.regime);

  const feeShareOfProfitPct = grossProfit > 0 ? Math.round((feeSum / grossProfit) * 100) : feeSum > 0 ? 100 : 0;
  const totalCost = grossLoss + feeSum + slipSum;
  const feeContributionToLossPct = totalCost > 0 ? Math.round((feeSum / totalCost) * 100) : 0;

  return {
    totalOrders: all.length,
    entries: entries.length,
    closed: closed.length, wins: wins.length, losses: losses.length,
    winratePct: closed.length ? Math.round((wins.length / closed.length) * 1000) / 10 : 0,
    grossPnl: r2(grossSum), fees: r2(feeSum), slippage: r2(slipSum), netPnl: r2(netSum),
    grossProfit: r2(grossProfit), grossLoss: r2(grossLoss),
    expectancyEur: closed.length ? r2(netSum / closed.length) : 0,
    avgTradeEur: closed.length ? r2(netSum / closed.length) : 0,
    avgWinEur: wins.length ? r2(grossProfit / wins.length) : 0,
    avgLossEur: losses.length ? r2(-grossLoss / losses.length) : 0,
    profitFactor: pf === null ? null : Math.round(pf * 100) / 100,
    feeShareOfProfitPct,
    feeContributionToLossPct,
    maxDrawdownPct: Math.round(maxDrawdownPct * 10) / 10,
    maxLossStreak: maxStreak, maxWinStreak: maxWStreak,
    avgHoldMin, medianHoldMin, longestHoldMin,
    tradesPerDay: Math.round(tradesPerDay * 10) / 10,
    tradesPerHour: Math.round(tradesPerHour * 100) / 100,
    observationHours: Math.round(observationHours * 10) / 10,
    activeDays,
    aiExitCount: aiExits.length,
    aiExitAvgHoldMin,
    aiExitShortPct,
    perCoin,
    singleCoinSharePct,
    concentrationRisk,
    perRegime,
    insufficientRegimeData,
  };
}

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Deel 24: AI-exit-gedrag afzonderlijk beoordeelbaar. */
export function aiExitVerdict(m: FullPaperMetrics): { level: "OK" | "WARNING" | "CRITICAL"; reason: string } {
  if (m.aiExitCount === 0) return { level: "OK", reason: "geen AI-exits" };
  if (m.aiExitShortPct > VAL_AI_EXIT_MAX_SHORT_PCT || (m.aiExitAvgHoldMin > 0 && m.aiExitAvgHoldMin < VAL_AI_EXIT_MIN_AVG_HOLD_MIN)) {
    return {
      level: m.aiExitShortPct >= VAL_AI_EXIT_MAX_SHORT_PCT * 2 ? "CRITICAL" : "WARNING",
      reason: `AI-exits: ${m.aiExitShortPct}% korter dan ${VAL_AI_EXIT_MIN_AVG_HOLD_MIN} min, gem. hold ${m.aiExitAvgHoldMin} min — fee-churn-risico`,
    };
  }
  return { level: "OK", reason: `AI-exits gezond (gem. hold ${m.aiExitAvgHoldMin} min)` };
}
