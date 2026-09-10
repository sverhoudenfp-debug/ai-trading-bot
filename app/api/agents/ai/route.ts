// ── Los eindpunt voor de gecombineerde AI-agent (handmatig te triggeren) ─
import { NextRequest, NextResponse } from "next/server";
import { aiAgent } from "@/lib/agents/ai";
import { tokenOk } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!tokenOk(req)) {
    return NextResponse.json({ error: "onbevoegd — token vereist" }, { status: 401 });
  }
  const r = await aiAgent();
  return NextResponse.json(r);
}
