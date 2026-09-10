// ── FASE 4: verwachtingen uit research + drift-berekening (Deel 7/8) ───────
// Bij activatie staan de historische research-verwachtingen in
// strategy_registry.research_metrics. Hier worden ze omgezet naar een
// gestructureerd ExpectedProfile, en continu vergeleken met de WERKELIJKE
// paper-prestaties. Zeven drift-dimensies, drie niveaus:
//   NORMAL | WARNING | CRITICAL.
// WARNING ≈ nooit automatisch rollback; CRITICAL kán rollback triggeren.

import type { RegistryRow } from "@/lib/evolution/db";
import type { FullPaperMetrics } from "./metrics";
import {
  DRIFT_EXP_WARN_FACTOR, DRIFT_EXP_CRIT_FACTOR,
  DRIFT_PF_WARN_FACTOR, DRIFT_PF_CRIT_FACTOR,
  DRIFT_DD_WARN_FACTOR, DRIFT_DD_CRIT_FACTOR,
  DRIFT_FREQ_WARN_LOW, DRIFT_FREQ_WARN_HIGH, DRIFT_FREQ_CRIT_LOW, DRIFT_FREQ_CRIT_HIGH,
  DRIFT_HOLD_WARN_LOW, DRIFT_HOLD_WARN_HIGH, DRIFT_HOLD_CRIT_LOW, DRIFT_HOLD_CRIT_HIGH,
  DRIFT_FEE_WARN_FACTOR, DRIFT_FEE_CRIT_FACTOR,
  DRIFT_WINRATE_WARN_PP, DRIFT_WINRATE_CRIT_PP,
} from "./config";

// De research-dataset: 180 dagen, IS 65% / OOS 35% → OOS-periode ≈ 63 dagen.
const RESEARCH_DATASET_DAYS = 180;
const RESEARCH_OOS_SHARE = 0.35;

export interface ExpectedProfile {
  expectancyEur: number;      // OOS-verwachting per trade
  profitFactor: number | null;
  winratePct: number;
  maxDrawdownPct: number;
  avgHoldMin: number;
  tradesPerDay: number;       // verwachte frequentie uit OOS-sample
  feeRatioPct: number;        // verwacht fee-aandeel van gross profit
  netPnl: number;
  trades: number;
}

export function expectedProfileFrom(row: RegistryRow): ExpectedProfile {
  const rm = (row.research_metrics ?? null) as {
    oos?: {
      expectancyEur?: number; netPnl?: number; trades?: number;
      maxDrawdownPct?: number; avgHoldMin?: number; fees?: number;
      winratePct?: number; profitFactor?: number | null;
      grossPnl?: number;
    };
  } | null;
  const oos = rm?.oos ?? {};
  const oosDays = RESEARCH_DATASET_DAYS * RESEARCH_OOS_SHARE;
  const fees = oos.fees ?? 0;
  const gross = (oos.netPnl ?? 0) + fees; // bruto vóór fees ≈ netto + fees
  return {
    expectancyEur: r2(oos.expectancyEur ?? 0),
    profitFactor: oos.profitFactor ?? null,
    winratePct: oos.winratePct ?? 0,
    maxDrawdownPct: oos.maxDrawdownPct ?? 0,
    avgHoldMin: Math.round(oos.avgHoldMin ?? 0),
    tradesPerDay: Math.round(((oos.trades ?? 0) / oosDays) * 100) / 100,
    feeRatioPct: gross > 0 ? Math.round((fees / gross) * 100) : 0,
    netPnl: r2(oos.netPnl ?? 0),
    trades: oos.trades ?? 0,
  };
}

export interface DriftDimension {
  dimension: "expectancy" | "profit_factor" | "drawdown" | "frequency" | "hold_time" | "fee_ratio" | "winrate";
  expected: string;
  actual: string;
  delta: string;
  level: "NORMAL" | "WARNING" | "CRITICAL";
  note: string;
}

export interface DriftReport {
  dimensions: DriftDimension[];
  worstLevel: "NORMAL" | "WARNING" | "CRITICAL";
  hasCritical: boolean;
  hasWarning: boolean;
}

export function computeDrift(expected: ExpectedProfile, actual: FullPaperMetrics, minHoldFloorMin = 0): DriftReport {
  const dims: DriftDimension[] = [];

  // 1. expectancy
  const expE = expected.expectancyEur;
  const actE = actual.expectancyEur;
  dims.push({
    dimension: "expectancy",
    expected: `€${expE}/trade`,
    actual: `€${actE}/trade`,
    delta: `€${r2(actE - expE)}/trade`,
    level: expE > 0
      ? (actE <= expE * DRIFT_EXP_CRIT_FACTOR || actE <= 0 ? "CRITICAL"
        : actE < expE * DRIFT_EXP_WARN_FACTOR ? "WARNING" : "NORMAL")
      : (actE < 0 ? "WARNING" : "NORMAL"),
    note: expE > 0 ? `paper-exp is ${Math.round((actE / expE) * 100) / 100}x verwacht` : `geen positieve backtest-expectancy om tegen te toetsen`,
  });

  // 2. profit factor
  if (expected.profitFactor && expected.profitFactor > 0) {
    const actPf = actual.profitFactor;
    if (actPf === null || actPf === undefined) {
      dims.push({
        dimension: "profit_factor", expected: `${expected.profitFactor}`, actual: "n.v.t.",
        delta: "-", level: "NORMAL",
        note: "nog geen verliezende trades — PF nog niet te beoordelen (geen drift-oordeel)",
      });
    } else {
      dims.push({
        dimension: "profit_factor", expected: `${expected.profitFactor}`, actual: `${actPf}`,
        delta: `${r2(actPf - expected.profitFactor)}`,
        level: actPf < expected.profitFactor * DRIFT_PF_CRIT_FACTOR ? "CRITICAL"
          : actPf < expected.profitFactor * DRIFT_PF_WARN_FACTOR ? "WARNING" : "NORMAL",
        note: `PF-verhouding paper/backtest: ${expected.profitFactor > 0 ? r2(actPf / expected.profitFactor) : "-"}`,
      });
    }
  }

  // 3. drawdown
  const expD = expected.maxDrawdownPct;
  const actD = actual.maxDrawdownPct;
  dims.push({
    dimension: "drawdown",
    expected: `${expD}%`,
    actual: `${actD}%`,
    delta: `${r2(actD - expD)}pp`,
    level: expD > 0
      ? (actD > expD * DRIFT_DD_CRIT_FACTOR ? "CRITICAL"
        : actD > expD * DRIFT_DD_WARN_FACTOR ? "WARNING" : "NORMAL")
      : (actD > 10 ? "WARNING" : "NORMAL"),
    note: expD > 0 ? `paper-DD is ${r2(actD / Math.max(expD, 0.01))}× de verwachte` : "geen backtest-DD bekend",
  });

  // 4. trade frequency
  const expF = expected.tradesPerDay;
  const actF = actual.tradesPerDay;
  const fRatio = expF > 0 ? actF / expF : 0;
  dims.push({
    dimension: "frequency",
    expected: `${expF}/dag`,
    actual: `${actF}/dag`,
    delta: `${r2(actF - expF)}/dag`,
    level: expF <= 0 ? (actF > 8 ? "WARNING" : "NORMAL")
      : (fRatio > DRIFT_FREQ_CRIT_HIGH || fRatio < DRIFT_FREQ_CRIT_LOW ? "CRITICAL"
        : fRatio > DRIFT_FREQ_WARN_HIGH || fRatio < DRIFT_FREQ_WARN_LOW ? "WARNING" : "NORMAL"),
    note: expF > 0 ? `frequentie is ${r2(fRatio)}× verwacht` : "geen backtest-frequentie bekend",
  });

  // 5. hold time
  const expH = expected.avgHoldMin;
  const actH = actual.avgHoldMin;
  const hRatio = expH > 0 ? actH / expH : 0;
  dims.push({
    dimension: "hold_time",
    expected: `${expH} min`,
    actual: `${actH} min`,
    delta: `${r2(actH - expH)} min`,
    level: (minHoldFloorMin > 0 && actH > 0 && actH < minHoldFloorMin) ? "CRITICAL"
      : expH <= 0 ? "NORMAL"
      : (hRatio > DRIFT_HOLD_CRIT_HIGH || hRatio < DRIFT_HOLD_CRIT_LOW) ? "CRITICAL"
      : (hRatio > DRIFT_HOLD_WARN_HIGH || hRatio < DRIFT_HOLD_WARN_LOW) ? "WARNING" : "NORMAL",
    note: expH > 0 ? `hold is ${r2(hRatio)}× verwacht${minHoldFloorMin > 0 ? ` (min-hold ${minHoldFloorMin} min)` : ""}` : "geen backtest-hold bekend",
  });

  // 6. fee ratio (fees / gross profit)
  const expFee = expected.feeRatioPct;
  const actFee = actual.feeShareOfProfitPct;
  dims.push({
    dimension: "fee_ratio",
    expected: `${expFee}%`,
    actual: `${actFee}%`,
    delta: `${r2(actFee - expFee)}pp`,
    level: expFee > 0
      ? (actFee > expFee * DRIFT_FEE_CRIT_FACTOR ? "CRITICAL"
        : actFee > expFee * DRIFT_FEE_WARN_FACTOR ? "WARNING" : "NORMAL")
      : (actFee > 60 ? "WARNING" : "NORMAL"),
    note: expFee > 0 ? `fee-aandeel is ${r2(actFee / Math.max(expFee, 0.01))}× verwacht` : "geen backtest-fee-ratio bekend",
  });

  // 7. winrate
  const expW = expected.winratePct;
  const actW = actual.winratePct;
  const wDelta = actW - expW;
  dims.push({
    dimension: "winrate",
    expected: `${expW}%`,
    actual: `${actW}%`,
    delta: `${r2(wDelta)}pp`,
    level: wDelta <= -DRIFT_WINRATE_CRIT_PP ? "CRITICAL"
      : wDelta <= -DRIFT_WINRATE_WARN_PP ? "WARNING" : "NORMAL",
    note: `winrate-verschil ${r2(wDelta)}pp t.o.v. backtest`,
  });

  const hasCritical = dims.some((d) => d.level === "CRITICAL");
  const hasWarning = dims.some((d) => d.level === "WARNING");
  return {
    dimensions: dims,
    worstLevel: hasCritical ? "CRITICAL" : hasWarning ? "WARNING" : "NORMAL",
    hasCritical,
    hasWarning,
  };
}

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}
