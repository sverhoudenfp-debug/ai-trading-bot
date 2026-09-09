// ── Los eindpunt voor de order-agent ────────────────────────────────────
// ?dry=1 → testmodus: alles doorrekenen, niets uitvoeren of wegschrijven.
import { NextRequest, NextResponse } from "next/server";
import { orderAgent } from "@/lib/agents/orders";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!process.env.PAPER_TOKEN || token !== process.env.PAPER_TOKEN) {
    return NextResponse.json({ error: "onbevoegd — token vereist" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  try {
    const r = await orderAgent(dry);
    return NextResponse.json({ ok: true, dry, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
