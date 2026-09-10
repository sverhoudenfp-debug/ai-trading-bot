// ── FASE 2: feature-frame — alle indicator-context per 15m-candle ───────
// KERNVEILIGHEID (Deel 26): elke feature op index i gebruikt UITSLUITEND
// data met timestamp ≤ candle-i-close. Series (RSI/EMA/momentum/ATR) zijn
// recursief: waarde op i hangt alleen af van invoer ≤ i. De 1h-trend kijkt
// naar de LAATST GESLOTEN 1h-candle (start+1h ≤ start van de 15m-candle) —
// nooit de lopende, onvolledige 1h-candle. De 24h-high/low is een venster
// OVER de vorige 96 candles (exclusief de huidige), zodat een breakout-
// conditie geen zelfvervullende high kan gebruiken.

import { Candle } from "@/lib/exchange/marketdata";
import { rsiSeries, emaSeries, momentumSeries, volatilityAt } from "@/lib/indicators";
import { atrSeries } from "./indicators";
import { regimeAt, type Regime } from "./regimes";

export interface Frame {
  pair: string;
  candles: Candle[];
  // per-index features
  rsi: number[];
  ema50: number[];
  ema200: number[];
  mom8: number[];
  vol20: number[];
  atr14: number[];
  volSma20: number[];
  volumeZ: number[];
  high24h: number[];   // hoogste high van de vorige 96 candles (excl. huidige)
  low24h: number[];
  distEma50Pct: number[];
  distEma200Pct: number[];
  trend1h: ("up" | "down" | "flat")[];
  ret24hPct: number[];
  regime: Regime[];
}

const WARMUP = 220; // EMA200 + buffer — features geldig pas na warm-up

export function buildFrame(pair: string, c15: Candle[], c1h: Candle[]): Frame {
  const closes = c15.map((c) => c.c);
  const vols = c15.map((c) => c.v);
  const rsi = rsiSeries(closes, 14);
  const ema50 = emaSeries(closes, 50);
  const ema200 = emaSeries(closes, 200);
  const mom8 = momentumSeries(closes, 8);
  const atr = atrSeries(c15, 14);
  const ema1h = emaSeries(c1h.map((c) => c.c), 200);

  const vol20: number[] = [];
  const volSma20: number[] = [];
  const volumeZ: number[] = [];
  const high24h: number[] = [];
  const low24h: number[] = [];
  const distEma50Pct: number[] = [];
  const distEma200Pct: number[] = [];
  const ret24hPct: number[] = [];
  const regime: Regime[] = [];
  const trend1h: ("up" | "down" | "flat")[] = [];

  // binaire mapping: laatste GESLOTEN 1h-index per 15m-candle
  // (1h-candle is gesloten als start+3600 ≤ start van de 15m-candle)
  let j1h = -1;
  const lastClosed1h: number[] = new Array(c15.length).fill(-1);
  for (let i = 0; i < c15.length; i++) {
    const t = c15[i].t;
    while (j1h + 1 < c1h.length && (c1h[j1h + 1].t + 3600) <= t) j1h++;
    lastClosed1h[i] = j1h;
  }

  for (let i = 0; i < c15.length; i++) {
    vol20.push(volatilityAt(closes, i, 20));
    // volume-SMA over vorige 20 candles (excl. huidige — geen zelfreferentie)
    const vs = vols.slice(Math.max(0, i - 20), i);
    const vAvg = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : vols[i];
    const vStd = vs.length
      ? Math.sqrt(vs.reduce((a, b) => a + (b - vAvg) ** 2, 0) / vs.length)
      : 1;
    volSma20.push(vAvg || 1);
    volumeZ.push(vStd > 0 ? (vols[i] - vAvg) / vStd : 0);
    const win = c15.slice(Math.max(0, i - 96), i); // vorige 24 uur, excl. huidige
    high24h.push(win.length ? Math.max(...win.map((c) => c.h)) : c15[i].h);
    low24h.push(win.length ? Math.min(...win.map((c) => c.l)) : c15[i].l);
    distEma50Pct.push(ema50[i] > 0 ? ((closes[i] - ema50[i]) / ema50[i]) * 100 : 0);
    distEma200Pct.push(ema200[i] > 0 ? ((closes[i] - ema200[i]) / ema200[i]) * 100 : 0);
    ret24hPct.push(i >= 96 ? (closes[i] / closes[i - 96] - 1) * 100 : 0);
    const k = lastClosed1h[i];
    if (k >= 0 && ema1h[k] > 0) {
      const dist = (c1h[k].c - ema1h[k]) / ema1h[k] * 100;
      trend1h.push(dist > 1 ? "up" : dist < -1 ? "down" : "flat");
    } else trend1h.push("flat");
    regime.push(regimeAt(closes, ema50, ema200, atr, i));
  }

  return {
    pair, candles: c15,
    rsi, ema50, ema200, mom8, vol20, atr14: atr, volSma20, volumeZ,
    high24h, low24h, distEma50Pct, distEma200Pct, ret24hPct, trend1h, regime,
  };
}

export const FRAME_WARMUP = WARMUP;
