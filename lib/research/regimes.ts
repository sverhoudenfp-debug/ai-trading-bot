// ── FASE 2: marktregime-classificatie ───────────────────────────────────
// Twee dimensies per candle (uitsluitend met data ≤ i):
//   trend:  EMA50 vs EMA200 + helling EMA50       → up | flat | down
//   vol:    ATR% t.o.v. 200-candle gemiddelde    → high | normal | low
// Samengevoegd tot zes genoemde regimes (Deel 22).

export type Regime =
  | "strong-uptrend" | "weak-uptrend" | "sideways"
  | "high-volatility" | "low-volatility" | "downtrend";

export function regimeAt(
  closes: number[],
  ema50: number[],
  ema200: number[],
  atr: number[],
  i: number
): Regime {
  if (i < 210) return "sideways";
  // trend-dimensie
  const emaDist = ema200[i] > 0 ? ((ema50[i] - ema200[i]) / ema200[i]) * 100 : 0;
  const slope = ema50[i - 24] > 0 ? ((ema50[i] - ema50[i - 24]) / ema50[i - 24]) * 100 : 0;
  const up = emaDist > 0.5 && slope > 0;
  const down = emaDist < -0.5 && slope < 0;

  // vol-dimensie: ATR% (ATR t.o.v. koers) vs 200-candle gemiddelde
  const atrPct = closes[i] > 0 ? (atr[i] / closes[i]) * 100 : 0;
  let sum = 0, n = 0;
  for (let k = Math.max(1, i - 199); k <= i; k++) {
    if (closes[k] > 0) { sum += (atr[k] / closes[k]) * 100; n++; }
  }
  const avgAtrPct = n ? sum / n : atrPct;
  const highVol = atrPct > avgAtrPct * 1.35;
  const lowVol = atrPct < avgAtrPct * 0.65;

  if (up && highVol) return "strong-uptrend";   // sterke trend mét vuur
  if (up) return "weak-uptrend";                // trend, maar rustig
  if (down) return "downtrend";
  if (highVol) return "high-volatility";
  if (lowVol) return "low-volatility";
  return "sideways";
}

export const REGIMES: Regime[] = [
  "strong-uptrend", "weak-uptrend", "sideways",
  "high-volatility", "low-volatility", "downtrend",
];
