// ── Strategie: hybride, laag 1 = regel-kern ─────────────────────────────
// KADER: dit is de eerste laag van de hybride strategie. De "feature-pipeline"
// hieronder (RSI, trend, momentum) is bewust gescheiden gehouden. In de
// volgende iteratie komt hier een ML-model bovenop dat deze features gebruikt
// — dan is de bot écht hybride. Eerst willen we een eerlijke, begrijpbare
// baseline: koop een VERS dipje (RSI kruist onder de drempel) zolang de
// trend omhoog staat (koers boven de EMA). Cross-events in plaats van
// niveaus voorkomen dat de bot constant in- en uitkoopt — fees zijn de
// stille moordenaar van day-trading (de eerste backtests lieten zien dat
// 250 trades x ~0,6% kosten = -70% rendement opleverde).

import { Candle } from "./exchange/marketdata";
import { emaSeries, rsiSeries, momentumSeries } from "./indicators";

export interface StrategyParams {
  // Signalen
  rsiPeriod: number;   // RSI-lengte
  rsiBuy: number;      // RSI kruist ONDER deze waarde = verse dip (koopmoment)
  rsiExit: number;     // RSI boven deze waarde = dip uitgekocht (exit)
  emaTrend: number;    // EMA-lengte voor de trendfilter (200 x 15m ≈ 2 dagen)
  momentumBars: number;// Momentum-venster (feature voor de ML-laag)
  // Risicobeheer (verplicht ingebouwd)
  slPct: number;       // stop-loss per trade
  tpPct: number;       // take-profit per trade
  maxHoldBars: number; // max. vasthouden (64 x 15m = 16 uur → day-trading)
  riskPerTrade: number;// max % van kapitaal dat je per trade riskeert
  feePct: number;      // taker-fee van de exchange (0,25% bij Bitvavo/Kraken)
  slippagePct: number;// slipped entry/exit
  dailyLossLimitPct: number; // dagelijkse verlieslimiet → bot stopt die dag
}

export const DEFAULT_PARAMS: StrategyParams = {
  rsiPeriod: 14,
  rsiBuy: 30,
  rsiExit: 55,
  emaTrend: 200,
  momentumBars: 8,
  slPct: 1.5,
  tpPct: 2.5,
  maxHoldBars: 64,
  riskPerTrade: 1,
  feePct: 0.25,
  slippagePct: 0.05,
  dailyLossLimitPct: 3,
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

/** Koopsignaal: RSI kruist net onder de dip-drempel ÉN de trend staat omhoog */
export function longSignal(s: StrategyState, candles: Candle[], i: number, p: StrategyParams): boolean {
  if (i < 1) return false;
  const freshDip = s.rsi[i - 1] >= p.rsiBuy && s.rsi[i] < p.rsiBuy; // cross-event
  const uptrend = candles[i].c > s.emaTrend[i];
  return freshDip && uptrend;
}

/** Exit-signaal: de dip is uitgekocht (RSI hersteld boven de exit-drempel) */
export function exitSignal(s: StrategyState, _candles: Candle[], i: number, p: StrategyParams): boolean {
  return s.rsi[i] > p.rsiExit;
}
