// ── Los eindpunt voor de analyse-agent (handmatig te triggeren) ─────────
import { NextRequest, NextResponse } from "next/server";
import { analyzeAgent } from "@/lib/agents/analyze";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!process.env.PAPER_TOKEN || token !== process.env.PAPER_TOKEN) {
    return NextResponse.json({ error: "onbevoegd — token vereist" }, { status: 401 });
  }
  try {
    const r = await analyzeAgent();
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
