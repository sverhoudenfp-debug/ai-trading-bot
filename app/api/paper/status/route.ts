// ── Publiek status-eindpunt voor het dashboard ─────────────────────────
// Alleen lezen (bot-status per coin + laatste orders + agent-activiteit).
// Geen token nodig: hier staat niets geheims in.

import { NextResponse } from "next/server";
import { getStates, listOrders, supabaseConfigured, POT_PAIR } from "@/lib/paper/store";
import { snapshot as blofinSnapshot } from "@/lib/exchange/blofin";
import { listSignals, latestNewsAlert, aiStats24h, lastAgentRun } from "@/lib/agents/db";
import { aiExecuteEnabled } from "@/lib/agents/config";

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
    try {
      [signals, news] = await Promise.all([listSignals(20), latestNewsAlert()]);
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
      const orders = await listOrders(100);
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

    return NextResponse.json({
      configured: true,
      initialized: states.length > 0,
      pot: potRow
        ? { cash: potRow.cash, day_start_equity: potRow.day_start_equity, halted: potRow.halted }
        : null,
      states: states.filter((s) => s.pair !== POT_PAIR),
      orders, blofin,
      agents: signals ? {
        signals, news, aiStats, aiLast, aiRuns, strategyStats,
        executeMode: aiExecuteEnabled,
      } : null,
    });
  } catch (e) {
    return NextResponse.json({ configured: true, error: String(e instanceof Error ? e.message : e) });
  }
}
