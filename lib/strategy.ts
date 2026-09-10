// ── Strategie: hybride, laag 1 = regel-kern ─────────────────────────────
// KADER: dit is de eerste laag van de hybride strategie. De "feature-pipeline"
// hieronder (RSI, trend, momentum) is bewust gescheiden gehouden — daar komt
// in de volgende iteratie een ML-model bovenop.
//
// LAAG 1 (nu): twee spiegelregels, allebei cross-events (dat voorkomt
// trade-churn; fees zijn de stille moordenaar van day-trading):
//   LONG:  RSI kruist ONDER 30 én koers boven EMA-200  → koop de verse dip
//   SHORT: RSI kruist BOVEN 70 én koers onder EMA-200  → verkoop de verse pomp
// SHORT: RSI kruist BOVEN de drempel én koers onder EMA-200 → verkoop de
// verse pomp. Standaard UIT (data, zie allowShorts); op Blofin kan het wél
// echt — de mirror ondersteunt short sinds 9 sep 2026.

import { Candle } from "./exchange/marketdata";
import { emaSeries, rsiSeries, momentumSeries } from "./indicators";

export interface StrategyParams {
  allowShorts: boolean; // 9 sep 2026: 80 long+short-combo's getest — shorts 40-44% wr, negatief; daarom UIT. Code is klaar; kan met één vlag aan.
  // Signalen — long
  rsiPeriod: number;
  rsiBuy: number;    // RSI kruist ONDER deze waarde = verse dip (koopsignaal)
  rsiExit: number;   // RSI boven deze waarde = dip uitgekocht (long exit)
  // Signalen — short (spiegel)
  rsiShort: number;     // RSI kruist BOVEN deze waarde = verse pomp (shortsignaal)
  rsiShortExit: number; // RSI onder deze waarde = pomp uitgekwakt (short exit)
  // Trend & features
  emaTrend: number;     // EMA-lengte voor de trendfilter (200 x 15m ≈ 2 dagen)
  momentumBars: number; // Momentum-venster (feature voor de ML-laag)
  // Risicobeheer (verplicht ingebouwd, geldt voor long ÉN short)
  slPct: number;       // stop-loss per trade
  tpPct: number;       // take-profit per trade
  maxHoldBars: number; // max. vasthouden (64 x 15m = 16 uur → day-trading)
  riskPerTrade: number;// max % van kapitaal dat je per trade riskeert
  feePct: number;      // taker-fee van de exchange (0,25% bij Bitvavo/Kraken)
  slippagePct: number; // slipped entry/exit
  dailyLossLimitPct: number; // dagelijkse verlieslimiet → bot stopt die dag
}

export const DEFAULT_PARAMS: StrategyParams = {
  allowShorts: false,
  rsiPeriod: 14,
  rsiBuy: 30,
  rsiExit: 60,
  rsiShort: 70,
  rsiShortExit: 45,
  emaTrend: 200,
  momentumBars: 8,
  slPct: 3,       // verbreed na winrate-sweep 9 sep 2026: 60% wr over 90d (was 1.5)
  tpPct: 4,
  maxHoldBars: 64,
  riskPerTrade: 0.5,   // Fase 1: 1% → 0,5% (centrale band: 0,25-1,0%)
  feePct: 0.25,
  slippagePct: 0.05,
  dailyLossLimitPct: 5,   // Fase 1: 3% → 5% op één lijn met DAILY_LOSS_LIMIT_PCT
};

export interface StrategyState {
  rsi: number[];
  emaTrend: number[];
  momentum: number[];
}

export function prepare(candles: Candle[], p: StrategyParams): StrategyState {
  const closes = candles.map((c) => c.c);
  return {
    rsi: rsiSeries(closes, p.rsiPeriod),
    emaTrend: emaSeries(closes, p.emaTrend),
    momentum: momentumSeries(closes, p.momentumBars),
  };
}

/** Koopsignaal (LONG): RSI kruist net onder de dip-drempel ÉN trend staat omhoog */
export function longSignal(s: StrategyState, candles: Candle[], i: number, p: StrategyParams): boolean {
  if (i < 1) return false;
  const freshDip = s.rsi[i - 1] >= p.rsiBuy && s.rsi[i] < p.rsiBuy;
  const uptrend = candles[i].c > s.emaTrend[i];
  return freshDip && uptrend;
}

/** Shortsignaal: RSI kruist net over de pomp-drempel ÉN trend staat omlaag */
export function shortSignal(s: StrategyState, candles: Candle[], i: number, p: StrategyParams): boolean {
  if (!p.allowShorts) return false;
  if (i < 1) return false;
  const freshPump = s.rsi[i - 1] <= p.rsiShort && s.rsi[i] > p.rsiShort;
  const downtrend = candles[i].c < s.emaTrend[i];
  return freshPump && downtrend;
}

/** Long exit: de dip is uitgekocht (RSI hersteld boven de exit-drempel) */
export function exitLongSignal(s: StrategyState, _candles: Candle[], i: number, p: StrategyParams): boolean {
  return s.rsi[i] > p.rsiExit;
}

/** Short exit: de pomp is uitgekwakt (RSI gezakt onder de exit-drempel) */
export function exitShortSignal(s: StrategyState, _candles: Candle[], i: number, p: StrategyParams): boolean {
  return s.rsi[i] < p.rsiShortExit;
}
