// ── FASE 2: historische data-engine ─────────────────────────────────────
// Zelfde marktdata-bron als de trading-engine (Bitvavo, lib/exchange/
// marketdata.ts) — research en paper trading kijken dus naar DEZELFDE
// koersen. Module-cache (TTL) voorkomt dat meerdere hypotheses dezelfde
// candles steeds opnieuw downloaden; research draait alléén expliciet
// (job/route), nooit bij een dashboard-refresh.

import { fetchCandles, Candle } from "@/lib/exchange/marketdata";
import { RESEARCH_15M_DAYS, RESEARCH_1H_DAYS, RESEARCH_CACHE_TTL_MIN } from "./config";

export interface PairDataset {
  pair: string;
  c15: Candle[];   // execution timeframe
  c1h: Candle[];   // context timeframe
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
  const [c15, c1h] = await Promise.all([
    fetchCandles(pair, 15, RESEARCH_15M_DAYS),
    fetchCandles(pair, 60, RESEARCH_1H_DAYS),
  ]);
  const ds: PairDataset = {
    pair,
    c15,
    c1h,
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
