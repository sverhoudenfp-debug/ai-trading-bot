// ── POST /api/research/run — research-run starten (token-vereist) ────────
// Aparte route, los van de trading-cron: research draait alleen expliciet
// (via deze route of het lokale script), nooit per dashboard-refresh.
// De run is gesynchroniseerd en begrensd (budget + dataset-limieten);
// maxDuration staat expliciet zodat Vercel de route niet half afbreekt.

import { NextRequest, NextResponse } from "next/server";
import { tokenOk } from "@/lib/auth";
import { runResearchPipeline } from "@/lib/research/researcher";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!tokenOk(req)) {
    return NextResponse.json({ error: "onbevoegd — token vereist" }, { status: 401 });
  }
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") === "full" ? "full" : "baseline";
  try {
    const result = await runResearchPipeline({
      mode,
      requestedBy: req.headers.get("x-requested-by") ?? "dashboard",
    });
    return NextResponse.json({ ok: true, mode, result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e instanceof Error ? e.message : e) },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  return NextResponse.json({ error: "POST vereist (mode=baseline|full)" }, { status: 405 });
}
