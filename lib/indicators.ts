// ── Technische indicatoren ──────────────────────────────────────────────
// Zelfgeschreven (geen externe library nodig): EMA, RSI, momentum, vol.

export function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** RSI volgens Wilder-smoothing (standaardmethode) */
export function rsiSeries(values: number[], period = 14): number[] {
  const out: number[] = new Array(values.length).fill(50);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

/** Momentum: % koersverandering over n candles */
export function momentumSeries(values: number[], bars = 8): number[] {
  return values.map((_, i) =>
    i < bars ? 0 : (values[i] / values[i - bars] - 1) * 100
  );
}

/** Dagelijkse volatiliteit: standaarddeviatie van de laatste n rendementen (in %) */
export function volatilityAt(values: number[], i: number, n = 20): number {
  const start = Math.max(1, i - n + 1);
  const rets: number[] = [];
  for (let j = start; j <= i; j++) rets.push((values[j] / values[j - 1] - 1) * 100);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  return Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
}
