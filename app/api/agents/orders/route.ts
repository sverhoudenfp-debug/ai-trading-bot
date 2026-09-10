// ── Los eindpunt voor de order-agent ────────────────────────────────────
// ?dry=1 → testmodus: alles doorrekenen, niets uitvoeren of wegschrijven.
import { NextRequest, NextResponse } from "next/server";
import { orderAgent } from "@/lib/agents/orders";
import { tokenOk } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!tokenOk(req)) {
    return NextResponse.json({ error: "onbevoegd — token vereist" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  try {
    const r = await orderAgent(dry, `manual-${Date.now()}`);
    return NextResponse.json({ ...r, dry });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
