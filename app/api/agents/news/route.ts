// ── Los eindpunt voor de nieuws-agent (handmatig te triggeren) ──────────
import { NextRequest, NextResponse } from "next/server";
import { newsAgent } from "@/lib/agents/news";
import { tokenOk } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!tokenOk(req)) {
    return NextResponse.json({ error: "onbevoegd — token vereist" }, { status: 401 });
  }
  const r = await newsAgent();
  return NextResponse.json(r);
}
