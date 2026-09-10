// ── FASE 2: extra indicatoren voor research (ATR) ────────────────────────
// Wilder-ATR over candles (true range smoothing) — nodig voor volatility-
// regime-classificatie. Recursief: waarde op i gebruikt alleen invoer ≤ i.

import { Candle } from "@/lib/exchange/marketdata";

export function atrSeries(candles: Candle[], period = 14): number[] {
  const out: number[] = new Array(candles.length).fill(0);
  if (candles.length < 2) return out;
  const tr: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c)));
  }
  let atr = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / Math.min(period, tr.length - 1);
  for (let i = 0; i < candles.length; i++) {
    if (i <= period) {
      const upto = tr.slice(1, i + 1);
      out[i] = upto.length ? upto.reduce((a, b) => a + b, 0) / upto.length : 0;
    } else {
      atr = (atr * (period - 1) + tr[i]) / period;
      out[i] = atr;
    }
  }
  return out;
}
