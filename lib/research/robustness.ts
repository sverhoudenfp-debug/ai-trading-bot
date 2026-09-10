// ── FASE 2: robustness- en overfitting-analyse ───────────────────────────
// Robustness: her-test de strategie met bewust ONGUNSTIGERE aannames
// (hogere fees, meer slippage, slechtere entries/exits) en met kleine
// parameter-perturbaties. Een edge die onder deze druk instort was geen
// edge maar curve-fitting.
//
// Overfitting-signalen (Deel 14): expliciete flags, geen "hoogste ROI =
// beste" logica.

import { Frame } from "./frame";
import { StrategySpec, Condition } from "./spec";
import { runPairBacktest, Metrics, computeMetrics } from "./backtest";
import { WfResult } from "./split";
import { FEE_PCT, SLIPPAGE_PCT } from "@/lib/risk/config";
import { ROBUSTNESS_MIN_PASS_RATIO, MIN_TRADES_IS, MIN_TRADES_OOS } from "./config";

export interface RobustnessResult {
  scenarios: { label: string; netPnl: number; trades: number }[];
  passRatio: number;     // deel scenario's met netto positief
  ok: boolean;
}

/** Robustness-stresstests op één frame (zelfde spec, slechtere omstandigheden). */
export function robustnessTest(f: Frame, spec: StrategySpec, equityStart = 1000): RobustnessResult {
  const scenarios: { label: string; opts: Record<string, number> }[] = [
    { label: "fees_x1.5", opts: { feePct: FEE_PCT * 1.5 } },
    { label: "fees_x2", opts: { feePct: FEE_PCT * 2 } },
    { label: "slippage_x2", opts: { slippagePct: SLIPPAGE_PCT * 2 } },
    { label: "entry_slechter", opts: { entrySlipExtraPct: 0.1 } },
    { label: "exit_slechter", opts: { exitSlipExtraPct: 0.1 } },
  ];
  const results = scenarios.map((sc) => {
    const bt = runPairBacktest(f, spec, { equityStart, ...sc.opts });
    const m = computeMetrics(bt.trades, bt.equity, equityStart);
    return { label: sc.label, netPnl: m.netPnl, trades: m.trades };
  });
  const passing = results.filter((r) => r.netPnl > 0).length;
  const passRatio = results.length ? passing / results.length : 0;
  return { scenarios: results, passRatio, ok: passRatio >= ROBUSTNESS_MIN_PASS_RATIO };
}

/** Parameter-perturbatie: numerieke conditiedrempels ±10% (één per keer). */
export function perturbationTest(f: Frame, spec: StrategySpec, equityStart = 1000): {
  worstRatio: number;   // slechtste netto t.o.v. basis (kan negatief zijn)
  variants: { label: string; netPnl: number }[];
} {
  const base = computeMetrics(runPairBacktest(f, spec, { equityStart }).trades, [], equityStart).netPnl;
  const variants: { label: string; netPnl: number }[] = [];
  (spec.entry_conditions as Condition[]).forEach((c, idx) => {
    if (typeof c.value === "number") {
      for (const dir of [-1, 1]) {
        const p = { ...spec, entry_conditions: spec.entry_conditions.map((x, j) =>
          j === idx ? { ...x, value: x.value as number * (1 + 0.1 * dir) } : x) } as StrategySpec;
        const bt = runPairBacktest(f, p, { equityStart });
        const m = computeMetrics(bt.trades, bt.equity, equityStart);
        variants.push({ label: `entry[${idx}].value${dir > 0 ? "+10%" : "-10%"}`, netPnl: m.netPnl });
      }
    }
  });
  const worst = variants.length ? Math.min(...variants.map((v) => v.netPnl)) : base;
  // bij base ≤ 0 is de strategie al afgewezen op netto; ratio dan betekenisloos
  const worstRatio = base > 0 ? worst / base : 1;
  return { worstRatio, variants };
}

// ── overfitting-detectie ─────────────────────────────────────────────────
export interface OverfitFlags {
  oos_negative_while_is_positive: boolean;
  walkforward_inconsistent: boolean;
  single_coin_dominance: boolean;
  sample_too_small: boolean;
  extreme_drawdown: boolean;
  fee_fragile: boolean;
  parameter_cliff: boolean;
}

export function detectOverfitting(args: {
  isMetrics: Metrics;
  oosMetrics: Metrics;
  wf: WfResult;
  perPairNet: { pair: string; netPnl: number }[];
  robustness: RobustnessResult;
  perturbation: { worstRatio: number };
}): { flags: OverfitFlags; warnings: string[] } {
  const { isMetrics, oosMetrics, wf, perPairNet, robustness, perturbation } = args;
  const flags: OverfitFlags = {
    oos_negative_while_is_positive: isMetrics.netPnl > 0 && oosMetrics.netPnl <= 0,
    walkforward_inconsistent: wf.consistencyPct < 50,
    single_coin_dominance: (() => {
      const pos = perPairNet.filter((p) => p.netPnl > 0);
      const totalPos = pos.reduce((a, p) => a + p.netPnl, 0);
      if (pos.length < 2 || totalPos <= 0) return false;
      const top = Math.max(...pos.map((p) => p.netPnl));
      return top / totalPos > 0.8;
    })(),
    sample_too_small: oosMetrics.trades < MIN_TRADES_OOS || isMetrics.trades < MIN_TRADES_IS,
    extreme_drawdown: oosMetrics.maxDrawdownPct > 25,
    fee_fragile: !robustness.ok,
    parameter_cliff: perturbation.worstRatio < 0.4,
  };
  const warnings: string[] = [];
  if (flags.oos_negative_while_is_positive) warnings.push("in-sample positief maar out-of-sample negatief — klassieke overfit");
  if (flags.walkforward_inconsistent) warnings.push(`walk-forward inconsistent (${wf.positiveWindows}/${wf.totalWindows} vensters positief)`);
  if (flags.single_coin_dominance) warnings.push("één coin levert vrijwel alle winst — edge is niet breed");
  if (flags.sample_too_small) warnings.push(`steekproef te klein (IS ${isMetrics.trades} / OOS ${oosMetrics.trades} trades; minimum ${MIN_TRADES_IS}/${MIN_TRADES_OOS})`);
  if (flags.extreme_drawdown) warnings.push(`extreme drawdown OOS (${oosMetrics.maxDrawdownPct}%)`);
  if (flags.fee_fragile) warnings.push("fragiel t.o.v. fees/slippage — de edge zit te dicht tegen de kosten");
  if (flags.parameter_cliff) warnings.push("parameter-klif: kleine drempelwijzigingen (-10%) laten de strategie instorten");
  return { flags, warnings };
}
