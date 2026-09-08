// ── Publiek status-eindpunt voor het dashboard ─────────────────────────
// Alleen lezen (bot-status + laatste orders + actuele koers). Geen token
// nodig: hier staat niets geheims in.

import { NextResponse } from "next/server";
import { getState, listOrders, supabaseConfigured } from "@/lib/paper/store";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!supabaseConfigured) {
    return NextResponse.json({ configured: false });
  }
  try {
    const [state, orders] = await Promise.all([getState(), listOrders(10)]);
    if (!state) return NextResponse.json({ configured: true, initialized: false });
    return NextResponse.json({ configured: true, initialized: true, state, orders });
  } catch (e) {
    return NextResponse.json({ configured: true, error: String(e instanceof Error ? e.message : e) });
  }
}
