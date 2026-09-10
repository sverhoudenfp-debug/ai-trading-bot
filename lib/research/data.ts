// ── FASE 2: historische data-engine ─────────────────────────────────────
// Zelfde marktdata-bron als de trading-engine (Bitvavo, lib/exchange/
// marketdata.ts) — research en paper trading kijken dus naar DEZELFDE
// koersen. Module-cache (TTL) voorkomt dat meerdere hypotheses dezelfde
// candles steeds opnieuw downloaden; research draait alléén expliciet
// (job/route), nooit bij een dashboard-refresh.

import { fetchCandles, Candle } from "@/lib/exchange/marketdata";
import { RESEARCH_15M_DAYS, RESEARCH_1H_DAYS, RESEARCH_5M_DAYS, RESEARCH_4H_DAYS, RESEARCH_CACHE_TTL_MIN } from "./config";

// ── HORIZON (master-prompt Deel 3): per pair laden we alle executie-
// timeframes (5m/15m/1h) + context-timeframes (1h/4h) in één gecachte
// dataset. De bron blijft identiek aan de trading-engine (Bitvavo).
export interface PairDataset {
  pair: string;
  c5: Candle[];    // execution: scalping
  c15: Candle[];   // execution: intraday
  c1h: Candle[];   // execution: swing ÓF context (voor 5m/15m)
  c4h: Candle[];   // context voor 1h-executie
  fetchedAt: number;
  days: number;
}

const cache = new Map<string, PairDataset>();

/** Gecachte dataset voor één pair (download max. 1× per TTL). */
export async function getDataset(pair: string): Promise<PairDataset> {
  const hit = cache.get(pair);
  if (hit && Date.now() - hit.fetchedAt < RESEARCH_CACHE_TTL_MIN * 60_000) {
    return hit;
  }
  const [c5, c15, c1h, c4h] = await Promise.all([
    fetchCandles(pair, 5, RESEARCH_5M_DAYS),
    fetchCandles(pair, 15, RESEARCH_15M_DAYS),
    fetchCandles(pair, 60, RESEARCH_1H_DAYS),
    fetchCandles(pair, 240, RESEARCH_4H_DAYS),
  ]);
  const ds: PairDataset = {
    pair,
    c5, c15, c1h, c4h,
    fetchedAt: Date.now(),
    days: RESEARCH_15M_DAYS,
  };
  cache.set(pair, ds);
  return ds;
}

/** Meerdere pairs (voor multi-market onderzoek); per pair mag falen. */
export async function getDatasets(pairs: readonly string[]): Promise<{
  ok: PairDataset[];
  failed: string[];
}> {
  const ok: PairDataset[] = [];
  const failed: string[] = [];
  for (const p of pairs) {
    try {
      const ds = await getDataset(p);
      if (ds.c15.length < 2000) throw new Error(`te weinig 15m-candles (${ds.c15.length})`);
      ok.push(ds);
    } catch (e) {
      failed.push(`${p}: ${String(e instanceof Error ? e.message : e)}`);
    }
  }
  return { ok, failed };
}

/** Cache leegmaken (tests / geforceerde verversing). */
export function clearDatasetCache(): void {
  cache.clear();
}
