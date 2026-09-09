// ── Publiek status-eindpunt voor het dashboard ─────────────────────────
// Alleen lezen (bot-status per coin + laatste orders). Geen token nodig:
// hier staat niets geheims in.

import { NextResponse } from "next/server";
import { getStates, listOrders, supabaseConfigured } from "@/lib/paper/store";
import { snapshot as blofinSnapshot } from "@/lib/exchange/blofin";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!supabaseConfigured) {
    return NextResponse.json({ configured: false });
  }
  try {
    const [states, orders, blofin] = await Promise.all([
      getStates(), listOrders(50), blofinSnapshot(),
    ]);
    return NextResponse.json({ configured: true, initialized: states.length > 0, states, orders, blofin });
  } catch (e) {
    return NextResponse.json({ configured: true, error: String(e instanceof Error ? e.message : e) });
  }
}
