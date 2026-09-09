// ── Publiek status-eindpunt voor het dashboard ─────────────────────────
// Alleen lezen (bot-status per coin + laatste orders + agent-activiteit).
// Geen token nodig: hier staat niets geheims in.

import { NextResponse } from "next/server";
import { getStates, listOrders, supabaseConfigured, POT_PAIR } from "@/lib/paper/store";
import { snapshot as blofinSnapshot } from "@/lib/exchange/blofin";
import { listSignals, latestNewsAlert } from "@/lib/agents/db";

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

    return NextResponse.json({
      configured: true,
      initialized: states.length > 0,
      pot: potRow
        ? { cash: potRow.cash, day_start_equity: potRow.day_start_equity, halted: potRow.halted }
        : null,
      states: states.filter((s) => s.pair !== POT_PAIR),
      orders, blofin,
      agents: signals ? { signals, news } : null,
    });
  } catch (e) {
    return NextResponse.json({ configured: true, error: String(e instanceof Error ? e.message : e) });
  }
}
