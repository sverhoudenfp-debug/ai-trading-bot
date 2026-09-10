// ── FASE 4: PAPER APPROVAL GATE (Deel 9/10) ───────────────────────────────
// Onafhankelijke, harde gate. 12 criteria, allemaal centraal configureerbaar.
// NOOIT goedkeuring op winrate alleen: de dragende metrics zijn netto
// expectancy, netto PnL, PF, drawdown, fees en sample size.
//   → verdict INSUFFICIENT_DATA | VALIDATION_EARLY | VALIDATION_PROGRESS |
//     VALIDATION_READY | PAPER_APPROVED | FAILED
// FAILED = definitief na voldoende data; een nieuwe versie moet opnieuw
// door de hele lifecycle. GEEN enkele route naar LIVE (Fase 5 is later).

import type { FullPaperMetrics, CoinStats } from "./metrics";
import type { DriftReport } from "./drift";
import type { IntegrityReport } from "./integrity";
import type { ConfidenceReport } from "./confidence";
import {
  VAL_MIN_OBSERVATION_DAYS, VAL_MIN_CLOSED_TRADES, VAL_MIN_ACTIVE_DAYS,
  VAL_MIN_NET_PNL_EUR, VAL_MIN_EXPECTANCY_EUR, VAL_MIN_PROFIT_FACTOR,
  VAL_MAX_DD_PCT, VAL_MAX_DD_FACTOR, VAL_MAX_FEE_SHARE_PCT,
  VAL_FREQ_MIN_FACTOR, VAL_FREQ_MAX_FACTOR,
  VAL_HOLD_MIN_FACTOR, VAL_HOLD_MAX_FACTOR,
  VAL_MAX_INTEGRITY_ISSUES, VAL_MAX_CRITICAL_DRIFT,
} from "./config";
import type { ExpectedProfile } from "./drift";

export type ValidationVerdict =
  | "INSUFFICIENT_DATA"
  | "VALIDATION_EARLY"
  | "VALIDATION_PROGRESS"
  | "VALIDATION_READY"
  | "PAPER_APPROVED"
  | "FAILED";

export interface ApprovalGateResult {
  verdict: ValidationVerdict;
  criteria: { id: number; name: string; pass: boolean; detail: string }[];
  hardFail: boolean;
  blockers: string[];
}

export function runApprovalGate(args: {
  metrics: FullPaperMetrics;
  drift: DriftReport;
  integrity: IntegrityReport;
  confidence: ConfidenceReport;
  expected: ExpectedProfile;
  minHoldFloorMin?: number;
}): ApprovalGateResult {
  const { metrics: m, drift, integrity, confidence, expected } = args;
  const observationDays = m.observationHours / 24;

  const daysObs = Math.round(observationDays * 10) / 10;
  const crit = (id: number, name: string, pass: boolean, detail: string) =>
    ({ id, name, pass, detail });

  const freqRatio = expected.tradesPerDay > 0 ? m.tradesPerDay / expected.tradesPerDay : null;
  const holdRatio = expected.avgHoldMin > 0 ? m.avgHoldMin / expected.avgHoldMin : null;

  // ── eerst: minimums (Deel 5) — zonder deze is er géén oordeel ────────
  const minTradesOk = m.closed >= VAL_MIN_CLOSED_TRADES;
  const minDaysOk = observationDays >= VAL_MIN_OBSERVATION_DAYS;
  const minActiveOk = m.activeDays >= VAL_MIN_ACTIVE_DAYS;
  if (!minTradesOk || !minDaysOk || !minActiveOk) {
    const early = confidence.label === "LOW_SAMPLE" || confidence.label === "EARLY";
    return {
      verdict: early ? "VALIDATION_EARLY" : "VALIDATION_PROGRESS",
      hardFail: false,
      blockers: [],
      criteria: [
        crit(1, "minimum observation period", observationDays >= VAL_MIN_OBSERVATION_DAYS, `${daysObs}/${VAL_MIN_OBSERVATION_DAYS} dagen`),
        crit(2, "minimum trades", minTradesOk, `${m.closed}/${VAL_MIN_CLOSED_TRADES} gesloten trades`),
        crit(3, "minimum actieve dagen", minActiveOk, `${m.activeDays}/${VAL_MIN_ACTIVE_DAYS} dagen met entries`),
      ],
    };
  }

  // ── dan: de 12 approval-criteria ────────────────────────────────────
  const criteria = [
    crit(1, "minimum observation period", observationDays >= VAL_MIN_OBSERVATION_DAYS, `${daysObs}/${VAL_MIN_OBSERVATION_DAYS} dagen`),
    crit(2, "minimum trades", minTradesOk, `${m.closed}/${VAL_MIN_CLOSED_TRADES} gesloten trades`),
    crit(3, "geen critical drift", !drift.hasCritical, drift.hasCritical
      ? `critical drift: ${drift.dimensions.filter((d) => d.level === "CRITICAL").map((d) => d.dimension).join(", ")}`
      : `worst: ${drift.worstLevel}`),
    crit(4, "netto PnL na fees structureel positief", m.netPnl >= VAL_MIN_NET_PNL_EUR,
      `netto €${m.netPnl} (min €${VAL_MIN_NET_PNL_EUR}; gross €${m.grossPnl}, fees €${m.fees}, slip €${m.slippage})`),
    crit(5, "expectancy acceptabel", m.expectancyEur >= VAL_MIN_EXPECTANCY_EUR,
      `€${m.expectancyEur}/trade (min €${VAL_MIN_EXPECTANCY_EUR})`),
    crit(6, "profit factor acceptabel", (m.profitFactor ?? 0) >= VAL_MIN_PROFIT_FACTOR,
      `PF ${m.profitFactor ?? "n.v.t."} (min ${VAL_MIN_PROFIT_FACTOR})`),
    crit(7, "drawdown binnen verwachting",
      m.maxDrawdownPct <= VAL_MAX_DD_PCT && (expected.maxDrawdownPct <= 0 || m.maxDrawdownPct <= expected.maxDrawdownPct * VAL_MAX_DD_FACTOR),
      `DD ${m.maxDrawdownPct}% (abs cap ${VAL_MAX_DD_PCT}%, verwacht ${expected.maxDrawdownPct}% → max ${Math.round(expected.maxDrawdownPct * VAL_MAX_DD_FACTOR * 10) / 10}%)`),
    crit(8, "fee ratio acceptabel", m.feeShareOfProfitPct <= VAL_MAX_FEE_SHARE_PCT,
      `fees €${m.fees} = ${m.feeShareOfProfitPct}% van gross profit (max ${VAL_MAX_FEE_SHARE_PCT}%)`),
    crit(9, "trade frequency binnen verwachting",
      freqRatio === null ? m.tradesPerDay <= 8 : freqRatio >= VAL_FREQ_MIN_FACTOR && freqRatio <= VAL_FREQ_MAX_FACTOR,
      `${m.tradesPerDay}/dag ${freqRatio !== null ? `(= ${Math.round(freqRatio * 100) / 100}× verwacht ${expected.tradesPerDay}/dag, band ${VAL_FREQ_MIN_FACTOR}–${VAL_FREQ_MAX_FACTOR}×)` : "(geen backtest-frequentie; harde cap 8/dag)"}`),
    crit(10, "hold time binnen verwachting",
      holdRatio === null ? m.avgHoldMin >= (args.minHoldFloorMin ?? 0) : holdRatio >= VAL_HOLD_MIN_FACTOR && holdRatio <= VAL_HOLD_MAX_FACTOR,
      `${m.avgHoldMin} min gem. ${holdRatio !== null ? `(= ${Math.round(holdRatio * 100) / 100}× verwacht ${expected.avgHoldMin} min, band ${VAL_HOLD_MIN_FACTOR}–${VAL_HOLD_MAX_FACTOR}×)` : ""}`),
    crit(11, "geen ernstige execution anomalies", m.aiExitShortPct < 100 && !(m.aiExitCount > 0 && m.aiExitAvgHoldMin > 0 && m.aiExitAvgHoldMin < (args.minHoldFloorMin ?? 15)),
      `AI-exits: ${m.aiExitCount}, gem. hold ${m.aiExitAvgHoldMin} min, ${m.aiExitShortPct}% korter dan min-hold`),
    crit(12, "geen data-integrity problemen",
      integrity.ok && integrity.issues.length <= VAL_MAX_INTEGRITY_ISSUES,
      integrity.issues.length
        ? integrity.issues.map((i) => `${i.severity}:${i.check}`).join("; ")
        : `integer (${integrity.checked.orders} orders gecheckt)`),
  ];

  // ── harde fails (na voldoende data is dit definitief) ─────────────────
  const hardFailCriteria = [
    { pass: criteria[3].pass, name: "netto negatief na voldoende data" },
    { pass: criteria[4].pass, name: "expectancy onder minimum" },
    { pass: criteria[5].pass, name: "profit factor onder 1,0" },
  ];
  const hardFail = hardFailCriteria.some((c) => !c.pass);

  const blockers = criteria.filter((c) => !c.pass).map((c) => `#${c.id} ${c.name}: ${c.detail}`);

  if (hardFail) {
    return { verdict: "FAILED", criteria, hardFail: true, blockers };
  }
  const allPass = criteria.every((c) => c.pass);
  if (allPass) {
    return { verdict: "PAPER_APPROVED", criteria, hardFail: false, blockers: [] };
  }
  // minimums gehaald, geen hard fail, maar criteria missen → door meten
  return { verdict: "VALIDATION_PROGRESS", criteria, hardFail: false, blockers };
}
