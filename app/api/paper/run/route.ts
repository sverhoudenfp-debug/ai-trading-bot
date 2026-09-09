// ── Orchestrator: de cron-wekker van cron-job.org tikt hier ──────────────
// Eén tick = drie agents achter elkaar, die uitsluitend via de database
// communiceren (elk leest de laatste status van de ander):
//   1. nieuws-agent   — max 1x per 10 min nieuws beoordelen (throttle)
//   2. analyse-agent  — signalen berekenen en wegschrijven
//   3. order-agent    — signalen + nieuws-status lezen en uitvoeren
// Faalt één agent, dan lopen de anderen gewoon door (de order-agent past
// altijd de risicoregels toe, met of zonder verse signalen).
//
// Beveiliging: ?token=<PAPER_TOKEN>. Nog steeds géén echt geld — fase 3
// start pas na een goed verlopen fase 2.

import { NextRequest, NextResponse } from "next/server";
import { newsAgent } from "@/lib/agents/news";
import { analyzeAgent } from "@/lib/agents/analyze";
import { orderAgent } from "@/lib/agents/orders";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!process.env.PAPER_TOKEN || token !== process.env.PAPER_TOKEN) {
    return NextResponse.json({ error: "onbevoegd — token vereist" }, { status: 401 });
  }
  try {
    // 1. nieuws-agent (throttled; fout = doorgaan met laatste status)
    const news = await newsAgent();

    // 2. analyse-agent (fout = geen nieuwe signalen; exits blijven werken)
    let analyze: Awaited<ReturnType<typeof analyzeAgent>> | null = null;
    let analyzeError: string | null = null;
    try {
      analyze = await analyzeAgent();
    } catch (e) {
      analyzeError = String(e instanceof Error ? e.message : e);
    }

    // 3. order-agent (de kern — fout = 500 zodat cron-job.org het ziet)
    const orders = await orderAgent();
    return NextResponse.json({ ok: true, ...orders, news, analyze, analyzeError });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
