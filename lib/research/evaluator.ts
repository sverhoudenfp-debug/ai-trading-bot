// ── FASE 2: Strategy Evaluation Score ───────────────────────────────────
// Objectieve score uit MEERDERE metrics — nadrukkelijk gescheiden van
// trading-approval: een hoge research-score betekent NIET tradable.
// Activering is pas een Fase 3-beslissing (met menselijke/signals-check).

import { Metrics } from "./backtest";
import { WfResult } from "./split";
import { RobustnessResult } from "./robustness";
import { ResearchStatus, MIN_TRADES_IS, MIN_TRADES_OOS, CANDIDATE_MIN_SCORE } from "./config";
import type { OverfitFlags } from "./robustness";

export interface Evaluation {
  status: ResearchStatus;           // NOOIT ACTIVE/LIVE — type staat dit niet toe
  score: number;                      // 0–100
  components: Record<string, number>;
  rejectionReasons: string[];
  warnings: string[];
}

/**
 * Scorecomponenten (elk 0–1, gewogen naar 0–100):
 *  - OOS-expectancy: netto per trade t.o.v. risico (% van SL-afstand kapitaal)
 *  - OOS profit factor
 *  - OOS drawdown (klein = beter)
 *  - sample-size factor (sqrt van OOS-trades / minimum)
 *  - walk-forward consistentie
 *  - robustness pass-ratio
 */
export function evaluateSpec(args: {
  isMetrics: Metrics;
  oosMetrics: Metrics;
  wf: WfResult;
  robustness: RobustnessResult;
  flags: OverfitFlags;
  warnings: string[];
}): Evaluation {
  const { isMetrics, oosMetrics, wf, robustness, flags, warnings } = args;
  const rejectionReasons: string[] = [];

  // ── harde afwijzingen ─────────────────────────────────────────────────
  if (isMetrics.trades < MIN_TRADES_IS) {
    rejectionReasons.push(`te weinig in-sample trades (${isMetrics.trades} < ${MIN_TRADES_IS})`);
  }
  if (oosMetrics.trades < MIN_TRADES_OOS) {
    rejectionReasons.push(`te weinig out-of-sample trades (${oosMetrics.trades} < ${MIN_TRADES_OOS})`);
  }
  if (oosMetrics.netPnl <= 0) {
    rejectionReasons.push(`out-of-sample netto negatief (${oosMetrics.netPnl} EUR)`);
  }
  if (flags.oos_negative_while_is_positive) {
    rejectionReasons.push("overfit: IS positief, OOS negatief");
  }
  if (flags.fee_fragile) {
    rejectionReasons.push(`fee-fragiel: slechts ${Math.round(robustness.passRatio * 100)}% robustness-scenario's positief`);
  }

  // ── scorecomponenten ──────────────────────────────────────────────────
  // expectancy per trade als % van equity (equityStart = 1000 in research)
  const expPct = oosMetrics.trades ? (oosMetrics.expectancyEur / 1000) * 100 : 0; // % per trade
  const cExpectancy = clamp01((expPct + 0.1) / 0.6);      // −0,1%..+0,5% per trade
  const cPf = clamp01(((oosMetrics.profitFactor ?? 0) - 0.8) / 0.9);  // PF 0,8..1,7
  const cDd = clamp01(1 - oosMetrics.maxDrawdownPct / 20); // DD 0..20%
  const cSample = clamp01(Math.sqrt(oosMetrics.trades / (MIN_TRADES_OOS * 4)));
  const cWf = wf.totalWindows ? wf.positiveWindows / wf.totalWindows : 0;
  const cRob = robustness.passRatio;

  const score = Math.round(
    (cExpectancy * 0.30 + cPf * 0.20 + cDd * 0.10 + cSample * 0.15 + cWf * 0.15 + cRob * 0.10) * 100
  );

  // ── status-bepaling (Fase 2-lifecycle) ────────────────────────────────
  let status: ResearchStatus;
  if (isMetrics.trades < MIN_TRADES_IS || oosMetrics.trades < MIN_TRADES_OOS) {
    status = isMetrics.trades === 0 ? "INSUFFICIENT_DATA" : "INSUFFICIENT_DATA";
    if (rejectionReasons.length === 0) rejectionReasons.push("steekproef te klein voor een oordeel");
  } else if (rejectionReasons.length > 0) {
    status = "REJECTED";
  } else if (score >= CANDIDATE_MIN_SCORE) {
    status = "RESEARCH_CANDIDATE";
  } else {
    status = "REJECTED";
    rejectionReasons.push(`score ${score} < ${CANDIDATE_MIN_SCORE} (consistente maar kleine edge onvoldoende bewezen)`);
  }

  return {
    status,
    score,
    components: {
      oos_expectancy: r2(cExpectancy),
      oos_profit_factor: r2(cPf),
      oos_drawdown: r2(cDd),
      sample_size: r2(cSample),
      walkforward: r2(cWf),
      robustness: r2(cRob),
    },
    rejectionReasons,
    warnings,
  };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
}
function r2(x: number): number {
  return Math.round(x * 100) / 100;
}
