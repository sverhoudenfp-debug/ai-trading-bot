// ── FASE 2: spec-interpreter ───────────────────────────────────────────
// Vertaalt een gevalideerde StrategySpec naar concrete evaluaties op het
// feature-frame. PURE functies; de backtest-engine bepaalt wánneer een
// signaal executeert (close T → open T+1). Cross-condities vergelijken
// frame[i] met frame[i-1] — nooit met frame[i+1].

import { Frame } from "./frame";
import { Condition, StrategyFilters } from "./spec";

export function conditionMet(cond: Condition, f: Frame, i: number): boolean {
  const v = typeof cond.value === "number" ? cond.value : undefined;
  switch (cond.kind) {
    case "rsi_lt": return f.rsi[i] < (v ?? 50);
    case "rsi_gt": return f.rsi[i] > (v ?? 50);
    case "rsi_cross_under": return i > 0 && f.rsi[i - 1] >= (v ?? 30) && f.rsi[i] < (v ?? 30);
    case "rsi_cross_over": return i > 0 && f.rsi[i - 1] <= (v ?? 70) && f.rsi[i] > (v ?? 70);
    case "price_above_ema": {
      const e = cond.period === 50 ? f.ema50[i] : cond.period === 200 ? f.ema200[i] : null;
      if (e === null) return false; // alleen 50/200 vooraf berekend
      return f.candles[i].c > e;
    }
    case "price_below_ema": {
      const e = cond.period === 50 ? f.ema50[i] : cond.period === 200 ? f.ema200[i] : null;
      if (e === null) return false;
      return f.candles[i].c < e;
    }
    case "ema_above_ema": {
      if (cond.period !== 50 || cond.period2 !== 200) return false;
      return f.ema50[i] > f.ema200[i];
    }
    case "ema_below_ema": {
      if (cond.period !== 50 || cond.period2 !== 200) return false;
      return f.ema50[i] < f.ema200[i];
    }
    case "mom_gt": return f.mom8[i] > (v ?? 0);
    case "mom_lt": return f.mom8[i] < (v ?? 0);
    case "dist_ema50_between": {
      // value = ondergrens; de bovengrens is value + 2,0% (band)
      const d = f.distEma50Pct[i];
      const lo = v ?? -1.5;
      return d >= lo && d <= lo + 2.0;
    }
    case "dist_ema200_gt": return f.distEma200Pct[i] > (v ?? 0);
    case "dist_ema200_lt": return f.distEma200Pct[i] < (v ?? 0);
    case "breakout_24h": return f.candles[i].c > f.high24h[i];
    case "breakdown_24h": return f.candles[i].c < f.low24h[i];
    case "volume_gt_sma": return f.candles[i].v > (v ?? 1.5) * f.volSma20[i];
    case "trend1h": return f.trend1h[i] === (cond.value === "up" ? "up" : "down");
    case "volatility_gt": return f.vol20[i] > (v ?? 1);
    case "volatility_lt": return f.vol20[i] < (v ?? 1);
    default: return false;
  }
}

/** Alle entry-condities (AND) op index i. */
export function entrySignal(f: Frame, i: number, conds: Condition[]): boolean {
  return conds.every((c) => conditionMet(c, f, i));
}

/** Één exit-conditie volstaat (OR) op index i. */
export function exitSignal(f: Frame, i: number, conds: Condition[]): boolean {
  return conds.some((c) => conditionMet(c, f, i));
}

/** Filters (extra context-eisen) op index i. */
export function filtersOk(f: Frame, i: number, fl: StrategyFilters | undefined): boolean {
  if (!fl) return true;
  if (fl.min_volatility_pct !== undefined && f.vol20[i] < fl.min_volatility_pct) return false;
  if (fl.max_volatility_pct !== undefined && f.vol20[i] > fl.max_volatility_pct) return false;
  if (fl.require_trend1h && f.trend1h[i] !== fl.require_trend1h) return false;
  if (fl.min_volume_z !== undefined && f.volumeZ[i] < fl.min_volume_z) return false;
  return true;
}
