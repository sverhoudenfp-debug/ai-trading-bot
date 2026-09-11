// ── Exchange-adapter: data ophalen ──────────────────────────────────────
// Fase 1-2 gebruiken de gratis publieke API van Bitvavo (geen account nodig).
// Bitvavo geeft per aanroep max. 1440 candles (15 dagen) én ondersteunt
// historische ranges → ideaal voor backtests. Vanaf fase 3 komt hier een
// tweede adapter naast te hangen (trading-API); de rest van de app merkt
// daar niets van.

export interface Candle {
  t: number; // unix-tijd (sec) van het begin van de candle
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export async function fetchCandles(
  market = "BTC-EUR",
  intervalMin = 15,
  days = 45
): Promise<Candle[]> {
  const now = Date.now();
  const endTarget = now - days * 86400 * 1000;
  let end = now;
  const out: Candle[] = [];
  const seen = new Set<number>();

  // Bitvavo staat per range-aanroep max. 1440 candles toe (15 dagen op 15m)
  // → we lopen in vensters van 1440 candles achterwaarts
  const windowMs = 1440 * intervalMin * 60 * 1000;
  for (let guard = 0; guard < 12 && end > endTarget; guard++) {
    const start = Math.max(endTarget, end - windowMs + intervalMin * 60 * 1000);
    const url = `https://api.bitvavo.com/v2/${market}/candles?interval=${intervalMin}m&start=${start}&end=${end}&limit=1440`;
    // AUDIT 11 sep: harde timeout — marktdata mag de run nooit laten hangen;
    // een falend pair wordt door de callers fail-closed overgeslagen.
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    // 400 = Bitvavo kent voor deze range geen candles (begin van de historie
    // bereikt) → gewoon stoppen, geen fout. Andere statussen zijn wél fout.
    if (res.status === 400) break;
    if (!res.ok) throw new Error(`Bitvavo HTTP ${res.status}`);
    const rows: [number, string, string, string, string, string][] = await res.json();
    if (!Array.isArray(rows) || !rows.length) break;

    for (const r of rows) {
      const t = Math.floor(r[0] / 1000);
      if (!seen.has(t)) {
        seen.add(t);
        out.push({ t, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });
      }
    }

    const oldest = rows[rows.length - 1][0]; // rows zijn nieuwst-eerst
    if (oldest >= end) break; // veiligheid: geen voortgang
    end = oldest - 1;
  }

  return out.sort((a, b) => a.t - b.t);
}
