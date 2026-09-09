// ── Los eindpunt voor de gecombineerde AI-agent (handmatig te triggeren) ─
import { NextRequest, NextResponse } from "next/server";
import { aiAgent } from "@/lib/agents/ai";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!process.env.PAPER_TOKEN || token !== process.env.PAPER_TOKEN) {
    return NextResponse.json({ error: "onbevoegd — token vereist" }, { status: 401 });
  }
  const r = await aiAgent();
  return NextResponse.json(r);
}
