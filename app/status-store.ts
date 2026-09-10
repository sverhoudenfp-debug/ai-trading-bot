"use client";

// ── Gedeelde data-cache voor alle dashboard-pagina's ────────────────────
// De status-API wordt één keer per ~20 s opgehaald, SHARED tussen de
// pagina's Dashboard / AI-Zoektocht / Orders. Wissel je van pagina, dan
// is de data al in het geheugen en hoef je niet opnieuw te laden.

import { useEffect, useState, useCallback } from "react";

// ── De vorm van /api/paper/status (één keer, voor alle pagina's) ──
export interface PaperState {
  pair: string; status: "flat" | "long" | "short"; cash: number;
  entry_price: number | null; entry_time: string | null;
  size: number | null; cost: number | null;
  day: string | null; day_start_equity: number; halted: boolean;
  updated_at?: string | null;
  sl_pct?: number | null;
  tp_pct?: number | null;
  strategy?: string | null;
}
export interface PaperOrder {
  id: number; created_at: string; pair: string; side: "buy" | "sell";
  price: number; size: number; reason: string; equity_after: number;
  pnl_eur: number | null; pnl_pct: number | null;
  strategy?: string | null; ai_explanation?: string | null;
}
export interface BlofinInfo {
  configured: boolean; live: boolean; equityUsd: number | null;
  positions: { instId: string; contracts: number; entry: number; mark: number; upl: number }[];
  error?: string;
}
export interface StatusPayload {
  configured: boolean;
  states: PaperState[];
  orders: PaperOrder[];
  pot?: { cash: number; day_start_equity: number; halted: boolean } | null;
  blofin?: BlofinInfo;
  agents?: {
    signals: { id: number; created_at: string; pair: string; side: string; kind: string; reason: string; strategy_version: string; outcome: string; outcome_reason: string | null; ai_explanation?: string | null; proposed_by?: string | null; timeframe?: string | null; sl_pct?: number | null; tp_pct?: number | null; risk_pct?: number | null; confidence?: string | null }[];
    news: { id: number; created_at: string; level: string; reason: string; valid_until: string } | null;
    newsList?: { id: number; created_at: string; level: string; reason: string; source: string; valid_until: string }[];
    aiStats?: { calls: number; errors: number; proposals: number; costUsd: number } | null;
    aiLast?: { created_at: string; error: string | null } | null;
    aiRuns?: { created_at: string; proposals: number; cost_usd_est: number; error: string | null }[];
    strategyStats?: { strategy: string; trades: number; wins: number; winrate: number; pnl_eur: number }[];
    executeMode?: boolean;
  } | null;
  [k: string]: unknown;
}

// ── De vorm van /api/multi (backtests + candles, per sessie gecached) ──
export interface MultiPair {
  pair: string; name: string; price: number;
  stats: { totalReturnPct: number; buyHoldPct: number; winRatePct: number; numTrades: number; numShorts: number; maxDrawdownPct: number; avgHoldHours: number; feesPaid: number; dailyStops: number; bestTradePct: number; worstTradePct: number };
  candles: { t: number; o: number; h: number; l: number; c: number }[];
  trades: { entryTime: number; exitTime: number; side: "long" | "short"; entryPrice: number; exitPrice: number; pnl: number; pnlPct: number; reason: string }[];
}
export interface MultiPayload {
  pairs: MultiPair[]; periodStart: number; periodEnd: number;
  [k: string]: unknown;
}

let statusCache: StatusPayload | null = null;
let multiCache: MultiPayload | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
const subs = new Set<() => void>();

function notify() { subs.forEach((f) => f()); }

async function fetchStatus() {
  try {
    const r = await fetch("/api/paper/status");
    const j = await r.json();
    if (j.configured && !j.error) {
      statusCache = j as StatusPayload;
      (statusCache as any).__at = Date.now();
      (statusCache as any).__atIso = new Date().toISOString();
      notify();
    }
  } catch { /* volgende poll probeert opnieuw */ }
}

function ensureTimer() {
  if (statusTimer) return;
  statusTimer = setInterval(fetchStatus, 20_000);
  fetchStatus();
}

/** Live status van de bot — gedeeld tussen alle pagina's. */
export function useStatus(): StatusPayload | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const rerender = () => bump((x) => x + 1);
    subs.add(rerender);
    if (!statusCache || Date.now() - ((statusCache as any).__at ?? 0) > 15_000) fetchStatus();
    ensureTimer();
    return () => { subs.delete(rerender); };
  }, []);
  return statusCache;
}

/** Multi-analyse (backtests + candles), één keer per sessie gecached. */
export function useMulti(): { multi: MultiPayload | null; reload: () => void } {
  const [, bump] = useState(0);
  const load = useCallback(() => {
    fetch("/api/multi")
      .then((r) => r.json())
      .then((j) => {
        if (!j.error) { multiCache = j; notify(); }
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    const rerender = () => bump((x) => x + 1);
    subs.add(rerender);
    if (!multiCache) load();
    return () => { subs.delete(rerender); };
  }, [load]);
  return { multi: multiCache, reload: load };
}

/** Actuele koersen van alle coins, elke 30 s (voor de live prijsjes). */
export function useLivePrices() {
  const [prices, setPrices] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      fetch("/api/paper/candles?prices=1")
        .then((r) => r.json())
        .then((j) => { if (alive && j.prices) setPrices(j.prices); })
        .catch(() => {});
    tick();
    const t = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return prices;
}
