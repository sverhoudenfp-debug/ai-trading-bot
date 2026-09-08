// ── Publiek status-eindpunt voor het dashboard ─────────────────────────
// Alleen lezen (bot-status per coin + laatste orders). Geen token nodig:
// hier staat niets geheims in.

import { NextResponse } from "next/server";
import { getStates, listOrders, supabaseConfigured } from "@/lib/paper/store";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!supabaseConfigured) {
    return NextResponse.json({ configured: false });
  }
  try {
    const [states, orders] = await Promise.all([getStates(), listOrders(50)]);
    return NextResponse.json({ configured: true, initialized: states.length > 0, states, orders });
  } catch (e) {
    return NextResponse.json({ configured: true, error: String(e instanceof Error ? e.message : e) });
  }
}
