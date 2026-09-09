// ── Los eindpunt voor de nieuws-agent (handmatig te triggeren) ──────────
import { NextRequest, NextResponse } from "next/server";
import { newsAgent } from "@/lib/agents/news";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!process.env.PAPER_TOKEN || token !== process.env.PAPER_TOKEN) {
    return NextResponse.json({ error: "onbevoegd — token vereist" }, { status: 401 });
  }
  const r = await newsAgent();
  return NextResponse.json(r);
}
