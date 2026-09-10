// ── Publiek status-eindpunt voor het dashboard ─────────────────────────
// Alleen lezen (bot-status per coin + laatste orders + agent-activiteit).
// Geen token nodig: hier staat niets geheims in.

import { NextResponse } from "next/server";
import { getStates, listOrders, listOrdersSince, supabaseConfigured, POT_PAIR } from "@/lib/paper/store";
import { snapshot as blofinSnapshot } from "@/lib/exchange/blofin";
import { listSignals, latestNewsAlert, aiStats24h, lastAgentRun, listSignalsSince, aiUsageSince, listNewsAlerts } from "@/lib/agents/db";
import { aiExecuteEnabled } from "@/lib/agents/config";
import { currentLimitPct } from "@/lib/risk/dailyLimit";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!supabaseConfigured) {
    return NextResponse.json({ configured: false });
  }
  try {
    const [states, orders, blofin] = await Promise.all([
      getStates(), listOrders(50), blofinSnapshot(),
    ]);
    const potRow = states.find((s) => s.pair === POT_PAIR);

    // ── agent-informatie: signalen + nieuws-status ──
    // Defensief: als de nieuwe tabellen er nog niet zijn, blijft het
    // dashboard gewoon werken (agents: null).
    let signals: Awaited<ReturnType<typeof listSignals>> | null = null;
    let news: Awaited<ReturnType<typeof latestNewsAlert>> | null = null;
    let newsList: Awaited<ReturnType<typeof listNewsAlerts>> = [];
    try {
      [signals, news, newsList] = await Promise.all([listSignals(20), latestNewsAlert(), listNewsAlerts(25)]);
    } catch {
      signals = null; news = null;
    }
    const aiStats = await aiStats24h(); // null als agent_runs er nog niet is
    const aiLast = await lastAgentRun().catch(() => null);
    // laatste AI-runs (zoektocht-weergave) + strategie-prestaties (7 dagen)
    let aiRuns: { created_at: string; proposals: number; cost_usd_est: number; error: string | null }[] = [];
    let strategyStats: { strategy: string; trades: number; wins: number; winrate: number; pnl_eur: number }[] = [];
    try {
      const r = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/agent_runs?select=created_at,proposals,cost_usd_est,error&order=created_at.desc&limit=20`,
        { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }, cache: "no-store" }
      );
      if (r.ok) aiRuns = await r.json();
    } catch { /* optioneel */ }
    try {
      const weekAgo = Date.now() - 7 * 86400_000;
      const orders = await listOrdersSince(new Date(weekAgo).toISOString()); // Fase 1: volledig venster
      const by = new Map<string, { n: number; w: number; pnl: number }>();
      for (const o of orders) {
        if (o.pnl_eur === null || o.strategy === null || o.strategy === undefined) continue;
        if (Date.parse(o.created_at ?? "") < weekAgo) continue;
        const cur = by.get(o.strategy) ?? { n: 0, w: 0, pnl: 0 };
        cur.n += 1; if (o.pnl_eur > 0) cur.w += 1; cur.pnl += o.pnl_eur;
        by.set(o.strategy, cur);
      }
      strategyStats = [...by.entries()].map(([strategy, v]) => ({
        strategy, trades: v.n, wins: v.w, winrate: Math.round((v.w / v.n) * 100), pnl_eur: Math.round(v.pnl * 100) / 100,
      })).sort((a, b) => b.pnl_eur - a.pnl_eur);
    } catch { /* optioneel */ }

    // ── Fase 1: monitoring-blok — early-warning voor fee-churn ──────────
    // Alles wat de afgelopen 24 uur gebeurde: frequentie, winrate, kosten-
    // uitsplitsing (koers vs fees vs slippage), exit-redenen en guard-
    // blokkades, zodat een terugval in churn direct zichtbaar is.
    const monitor: Record<string, unknown> = { available: false };
    try {
      const since = new Date(Date.now() - 24 * 3600_000).toISOString();
      const orders24h = await listOrdersSince(since);
      const entries24h = orders24h.filter((o) => o.pnl_eur === null);
      const exits24h = orders24h.filter((o) => o.pnl_eur !== null);
      const wins = exits24h.filter((o) => (o.pnl_eur ?? 0) > 0).length;
      const net = exits24h.reduce((a, o) => a + (o.pnl_eur ?? 0), 0);
      const gross = exits24h.reduce((a, o) => a + ((o as { context?: { gross_pnl_eur?: number } }).context?.gross_pnl_eur ?? 0), 0);
      const feesPaid = exits24h.reduce((a, o) => a + ((o as { context?: { fees_eur?: number } }).context?.fees_eur ?? 0), 0);
      const slipPaid = exits24h.reduce((a, o) => a + ((o as { context?: { slippage_eur?: number } }).context?.slippage_eur ?? 0), 0);
      const hold = exits24h
        .map((o) => (o as { context?: { hold_min?: number } }).context?.hold_min)
        .filter((h): h is number => typeof h === "number");
      const exitReasons: Record<string, number> = {};
      for (const o of exits24h) exitReasons[o.reason] = (exitReasons[o.reason] ?? 0) + 1;
      const perPair: Record<string, number> = {};
      for (const o of entries24h) perPair[o.pair] = (perPair[o.pair] ?? 0) + 1;

      const signals24h = await listSignalsSince(since).catch(() => []);
      const outcomes: Record<string, number> = {};
      for (const sig of signals24h) outcomes[sig.outcome] = (outcomes[sig.outcome] ?? 0) + 1;

      const ai = await aiUsageSince(since).catch(() => ({ calls: 0, costUsd: 0, errors: 0 }));

      const openStates = states.filter((s) => s.pair !== POT_PAIR && s.status !== "flat");
      const exposureNotional = openStates.reduce((a, s) => a + (s.size && s.entry_price ? s.size * s.entry_price : 0), 0);

      monitor.available = true;
      monitor.trades_24h = {
        entries: entries24h.length,
        entries_per_pair: perPair,
        closed: exits24h.length,
        winrate_pct: exits24h.length ? Math.round((wins / exits24h.length) * 100) : null,
        exit_reasons: exitReasons,
        avg_hold_min: hold.length ? Math.round(hold.reduce((a, b) => a + b, 0) / hold.length) : null,
        pnl: {
          net_eur: Math.round(net * 100) / 100,
          gross_eur: Math.round(gross * 100) / 100,
          fees_eur: Math.round(feesPaid * 100) / 100,
          slippage_eur: Math.round(slipPaid * 100) / 100,
        },
      };
      monitor.signals_24h = outcomes;
      monitor.ai_24h = ai;
      monitor.exposure = {
        open_positions: openStates.length,
        notional_eur: Math.round(exposureNotional * 100) / 100,
      };
      monitor.daily_loss = potRow
        ? {
            day: potRow.day,
            day_start_equity: potRow.day_start_equity,
            limit_pct: potRow.day ? await currentLimitPct(potRow.day) : 10,
            current_pct: potRow.day_start_equity > 0
              ? Math.round(((potRow.cash + exposureNotional) / potRow.day_start_equity - 1) * 1000) / 10
              : null,
            halted: potRow.halted,
          }
        : null;
    } catch { /* monitor is optioneel */ }

    return NextResponse.json({
      configured: true,
      monitor,
      initialized: states.length > 0,
      pot: potRow
        ? { cash: potRow.cash, day_start_equity: potRow.day_start_equity, halted: potRow.halted }
        : null,
      states: states.filter((s) => s.pair !== POT_PAIR),
      orders, blofin,
      agents: signals ? {
        signals, news, newsList, aiStats, aiLast, aiRuns, strategyStats,
        executeMode: aiExecuteEnabled,
      } : null,
    });
  } catch (e) {
    return NextResponse.json({ configured: true, error: String(e instanceof Error ? e.message : e) });
  }
}
