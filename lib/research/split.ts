// ── FASE 2: train/test-split + walk-forward vensters ────────────────────
// IS (in-sample) komt strikt vóór OOS (out-of-sample): de AI formuleert
// hypotheses op basis van IS-samenvattingen; de OOS-periode valt volledig
// buiten de parameter-selectie. Walk-forward verdeelt de HELE dataset in
// opeenvolgende, niet-overlappende segmenten om consistentie te meten
// wanneer de markt verandert.

import { TRAIN_PCT, WF_SEGMENTS } from "./config";
import { Frame, FRAME_WARMUP } from "./frame";
import { StrategySpec } from "./spec";
import { runPairBacktest, RTrade, Metrics, computeMetrics } from "./backtest";

export interface Split {
  is: { fromIdx: number; toIdx: number };
  oos: { fromIdx: number; toIdx: number };
}

/** 65% in-sample / 35% out-of-sample (configureerbaar), op candles-niveau. */
export function makeSplit(n: number, trainPct = TRAIN_PCT): Split {
  const usable = n - FRAME_WARMUP;
  const splitIdx = FRAME_WARMUP + Math.floor(usable * trainPct / 100);
  return {
    is: { fromIdx: FRAME_WARMUP, toIdx: splitIdx - 1 },
    oos: { fromIdx: splitIdx, toIdx: n - 1 },
  };
}

export interface WfWindow { label: string; fromIdx: number; toIdx: number }

/** Walk-forward: WF_SEGMENTS opeenvolgende, niet-overlappende vensters. */
export function walkForwardWindows(n: number, segments = WF_SEGMENTS): WfWindow[] {
  const usable = n - FRAME_WARMUP;
  const segLen = Math.floor(usable / segments);
  const out: WfWindow[] = [];
  for (let s = 0; s < segments; s++) {
    const from = FRAME_WARMUP + s * segLen;
    const to = s === segments - 1 ? n - 1 : from + segLen - 1;
    out.push({ label: `wf${s + 1}`, fromIdx: from, toIdx: to });
  }
  return out;
}

export interface WfResult {
  windows: { label: string; metrics: Metrics }[];
  positiveWindows: number;
  totalWindows: number;
  consistencyPct: number;
}

/** Walk-forward evaluatie van één spec op één frame. */
export function walkForwardEvaluate(f: Frame, spec: StrategySpec, equityStart = 1000): WfResult {
  const wins = walkForwardWindows(f.candles.length).map((w) => {
    const bt = runPairBacktest(f, spec, { equityStart, fromIdx: w.fromIdx, toIdx: w.toIdx });
    return { label: w.label, metrics: computeMetrics(bt.trades, bt.equity, equityStart) };
  });
  const positive = wins.filter((w) => w.metrics.netPnl > 0 && w.metrics.trades > 0);
  return {
    windows: wins,
    positiveWindows: positive.length,
    totalWindows: wins.length,
    consistencyPct: wins.length ? Math.round((positive.length / wins.length) * 100) : 0,
  };
}
