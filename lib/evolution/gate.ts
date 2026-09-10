// ── FASE 3: VALIDATION GATE (Deel 5-7) ─────────────────────────────────
// PUUR CODE — geen AI, geen feelings. Een RESEARCH_CANDIDATE wordt pas
// PAPER_CANDIDATE als élke harde eis slaagt én de fee-aware baseline-
// vergelijking eerlijk is. De gate vraagt "voldoende bewijs om zinvol in
// paper te testen", niet "bewezen winstgevend" (Deel 6).

import {
  GATE_MIN_TRADES_IS, GATE_MIN_TRADES_OOS, GATE_MIN_OOS_EXPECTANCY_EUR,
  GATE_MIN_OOS_NET_PNL_EUR, GATE_MIN_PROFIT_FACTOR, GATE_MAX_OOS_DRAWDOWN_PCT,
  GATE_MIN_WF_CONSISTENCY_PCT, GATE_MIN_ROBUSTNESS_PASS_RATIO, GATE_MIN_SCORE,
  GATE_MIN_FEE_SCENARIO_PASS, GATE_MAX_SINGLE_COIN_SHARE,
  BASELINE_MAX_TRADE_MULTIPLIER, BASELINE_MIN_NET_IMPROVEMENT_EUR,
} from "./config";
import { Metrics } from "@/lib/research/backtest";
import { WfResult } from "@/lib/research/split";
import { RobustnessResult, OverfitFlags } from "@/lib/research/robustness";

export interface GateInput {
  isMetrics: Metrics;
  oosMetrics: Metrics;
  walkforward: WfResult;
  robustness: RobustnessResult;
  overfitting: { flags: OverfitFlags; warnings: string[] };
  perPair: { pair: string; netPnl: number; trades: number }[];
  score: number;                       // research-evaluatorscore (0-100)
  status: string;                      // uit de research-pipeline
  feeScenarios?: { label: string; netPnl: number }[]; // robustness fee-scenario's
}

export interface BaselineMetrics {
  name: string;
  oos: Pick<Metrics, "trades" | "netPnl" | "expectancyEur" | "maxDrawdownPct" | "profitFactor" | "fees">;
}

export interface GateVerdict {
  passed: boolean;
  reasons: string[];         // falingsredenen (leeg = geslaagd)
  warnings: string[];
  baselineComparison: string;
}

export function runValidationGate(
  c: GateInput,
  baseline: BaselineMetrics | null
): GateVerdict {
  const reasons: string[] = [];
  const warnings: string[] = [];

  // 1+2. sample size
  if (c.isMetrics.trades < GATE_MIN_TRADES_IS) reasons.push(`IS-trades ${c.isMetrics.trades} < ${GATE_MIN_TRADES_IS}`);
  if (c.oosMetrics.trades < GATE_MIN_TRADES_OOS) reasons.push(`OOS-trades ${c.oosMetrics.trades} < ${GATE_MIN_TRADES_OOS}`);

  // 3+4. OOS netto positief
  if (c.oosMetrics.expectancyEur <= GATE_MIN_OOS_EXPECTANCY_EUR) {
    reasons.push(`OOS-expectancy €${c.oosMetrics.expectancyEur} ≤ €${GATE_MIN_OOS_EXPECTANCY_EUR}/trade`);
  }
  if (c.oosMetrics.netPnl <= GATE_MIN_OOS_NET_PNL_EUR) {
    reasons.push(`OOS netto €${c.oosMetrics.netPnl} ≤ €${GATE_MIN_OOS_NET_PNL_EUR}`);
  }

  // 5. profit factor
  if ((c.oosMetrics.profitFactor ?? 0) < GATE_MIN_PROFIT_FACTOR) {
    reasons.push(`OOS profit factor ${c.oosMetrics.profitFactor} < ${GATE_MIN_PROFIT_FACTOR}`);
  }

  // 6. drawdown
  if (c.oosMetrics.maxDrawdownPct > GATE_MAX_OOS_DRAWDOWN_PCT) {
    reasons.push(`OOS max drawdown ${c.oosMetrics.maxDrawdownPct}% > ${GATE_MAX_OOS_DRAWDOWN_PCT}%`);
  }

  // 7. walk-forward consistentie
  if (c.walkforward.consistencyPct < GATE_MIN_WF_CONSISTENCY_PCT) {
    reasons.push(`walk-forward consistentie ${c.walkforward.consistencyPct}% < ${GATE_MIN_WF_CONSISTENCY_PCT}%`);
  }

  // 8+9. robustness + fee-sensitiviteit
  if (c.robustness.passRatio < GATE_MIN_ROBUSTNESS_PASS_RATIO) {
    reasons.push(`robustness pass-ratio ${(c.robustness.passRatio * 100).toFixed(0)}% < ${GATE_MIN_ROBUSTNESS_PASS_RATIO * 100}%`);
  }
  const feeScen = (c.feeScenarios ?? []).filter((s) => s.label.startsWith("fees_"));
  if (feeScen.length >= 2) {
    const pass = feeScen.filter((s) => s.netPnl > 0).length / feeScen.length;
    if (pass < GATE_MIN_FEE_SCENARIO_PASS) reasons.push(`fee-scenario's fragiel: ${Math.round(pass * 100)}% positief < ${GATE_MIN_FEE_SCENARIO_PASS * 100}%`);
  }

  // 10. research-score zelf (geen dominant criterium, wel een drempel)
  if (c.score < GATE_MIN_SCORE) reasons.push(`research-score ${c.score} < ${GATE_MIN_SCORE}`);

  // 11. kritieke overfitting-flags
  const f = c.overfitting.flags;
  if (f.oos_negative_while_is_positive) reasons.push("overfit-flag: IS positief / OOS negatief");
  if (f.walkforward_inconsistent) reasons.push("overfit-flag: walk-forward inconsistent");
  if (f.extreme_drawdown) reasons.push("overfit-flag: extreme drawdown");
  if (f.parameter_cliff) reasons.push("overfit-flag: parameter-klif");
  if (f.sample_too_small) reasons.push("overfit-flag: steekproef te klein");
  warnings.push(...c.overfitting.warnings);

  // 12. single-coin dependency
  const pos = c.perPair.filter((p) => p.netPnl > 0);
  const totalPos = pos.reduce((a, p) => a + p.netPnl, 0);
  if (pos.length >= 2 && totalPos > 0) {
    const top = Math.max(...pos.map((p) => p.netPnl));
    if (top / totalPos > GATE_MAX_SINGLE_COIN_SHARE) {
      reasons.push(`één coin draagt ${(100 * top / totalPos).toFixed(0)}% van de winst (> ${GATE_MAX_SINGLE_COIN_SHARE * 100}%)`);
    }
  }

  // baseline-vergelijking (fee-aware, Deel 7)
  let bc = "geen vergelijkbare baseline beschikbaar";
  if (baseline) {
    const b = baseline.oos;
    const expGain = c.oosMetrics.expectancyEur - b.expectancyEur;
    const netGain = c.oosMetrics.netPnl - b.netPnl;
    const tradeMult = b.trades > 0 ? c.oosMetrics.trades / b.trades : 1;
    bc = `vs ${baseline.name}: exp €${c.oosMetrics.expectancyEur} (Δ${expGain >= 0 ? "+" : ""}${expGain.toFixed(2)}), ` +
         `net €${c.oosMetrics.netPnl} (Δ${netGain >= 0 ? "+" : ""}${netGain.toFixed(2)}), ` +
         `trades ${c.oosMetrics.trades} vs ${b.trades} (×${tradeMult.toFixed(1)}), fees €${c.oosMetrics.fees} vs €${b.fees}`;
    if (expGain <= 0) reasons.push(`geen betere OOS-expectancy dan baseline (Δ${expGain.toFixed(2)} €/trade)`);
    if (tradeMult > BASELINE_MAX_TRADE_MULTIPLIER && netGain < BASELINE_MIN_NET_IMPROVEMENT_EUR) {
      reasons.push(`fee-churn-gevoelig: ×${tradeMult.toFixed(1)} zoveel trades voor slechts €${netGain.toFixed(2)} netto verbetering`);
    }
    if (c.oosMetrics.maxDrawdownPct > b.maxDrawdownPct * 1.5 && b.maxDrawdownPct > 0) {
      warnings.push(`drawdown ${c.oosMetrics.maxDrawdownPct}% ruim hoger dan baseline ${b.maxDrawdownPct}%`);
    }
  }

  return { passed: reasons.length === 0, reasons, warnings, baselineComparison: bc };
}
