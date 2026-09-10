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

// ── HORIZON-generalisatie (master-prompt Deel 3): buildFrame werkt voor
// ELKE executie-timeframe. ctx = context-timeframe (trend-filter), ctxMinutes =
// context-candle-duur. NO-LOOK-AHEAD blijft identiek: de trend op index i
// kijkt naar de LAATST GESLOTEN ctx-candle (ctx-close ≤ start van candle i);
// de 24u-high/low vensters schalen mee met de bar-duur.
export function buildFrame(
  pair: string,
  exec: Candle[],
  ctx: Candle[],
  execMinutes: number,
  ctxMinutes: number,
): Frame {
  const closes = exec.map((c) => c.c);
  const vols = exec.map((c) => c.v);
  const rsi = rsiSeries(closes, 14);
  const ema50 = emaSeries(closes, 50);
  const ema200 = emaSeries(closes, 200);
  const mom8 = momentumSeries(closes, 8);
  const atr = atrSeries(exec, 14);
  const emaCtx = emaSeries(ctx.map((c) => c.c), 200);
  // aantal bars per 24 uur op de executie-timeframe (5m→288, 15m→96, 1h→24)
  const barsPerDay = Math.max(1, Math.round(1440 / execMinutes)); // candles per 24 uur

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

  // binaire mapping: laatste GESLOTEN ctx-index per exec-candle
  // (ctx-start + ctxMinutes·60 sec ≤ exec-start; t is in seconden — als v1: +3600)
  let j1h = -1;
  const lastClosed1h: number[] = new Array(exec.length).fill(-1);
  for (let i = 0; i < exec.length; i++) {
    const t = exec[i].t;
    const ctxSec = ctxMinutes * 60;
    while (j1h + 1 < ctx.length && (ctx[j1h + 1].t + ctxSec) <= t) j1h++;
    lastClosed1h[i] = j1h;
  }

  for (let i = 0; i < exec.length; i++) {
    vol20.push(volatilityAt(closes, i, 20));
    // volume-SMA over vorige 20 candles (excl. huidige — geen zelfreferentie)
    const vs = vols.slice(Math.max(0, i - 20), i);
    const vAvg = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : vols[i];
    const vStd = vs.length
      ? Math.sqrt(vs.reduce((a, b) => a + (b - vAvg) ** 2, 0) / vs.length)
      : 1;
    volSma20.push(vAvg || 1);
    volumeZ.push(vStd > 0 ? (vols[i] - vAvg) / vStd : 0);
    const win = exec.slice(Math.max(0, i - barsPerDay), i); // vorige 24 uur, excl. huidige
    high24h.push(win.length ? Math.max(...win.map((c) => c.h)) : exec[i].h);
    low24h.push(win.length ? Math.min(...win.map((c) => c.l)) : exec[i].l);
    distEma50Pct.push(ema50[i] > 0 ? ((closes[i] - ema50[i]) / ema50[i]) * 100 : 0);
    distEma200Pct.push(ema200[i] > 0 ? ((closes[i] - ema200[i]) / ema200[i]) * 100 : 0);
    ret24hPct.push(i >= barsPerDay ? (closes[i] / closes[i - barsPerDay] - 1) * 100 : 0);
    const k = lastClosed1h[i];
    if (k >= 0 && emaCtx[k] > 0) {
      const dist = (ctx[k].c - emaCtx[k]) / emaCtx[k] * 100;
      trend1h.push(dist > 1 ? "up" : dist < -1 ? "down" : "flat");
    } else trend1h.push("flat");
    regime.push(regimeAt(closes, ema50, ema200, atr, i));
  }

  return {
    pair, candles: exec,
    rsi, ema50, ema200, mom8, vol20, atr14: atr, volSma20, volumeZ,
    high24h, low24h, distEma50Pct, distEma200Pct, ret24hPct, trend1h, regime,
  };
}

export const FRAME_WARMUP = WARMUP;
