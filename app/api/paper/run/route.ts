// ── Orchestrator: de cron-wekker van cron-job.org tikt hier ──────────────
// Eén tick = de agents achter elkaar, die uitsluitend via de database
// communiceren (elk leest de laatste status van de ander):
//   1. nieuws-agent   — RSS-radar, max 1x per 10 min (throttle)
//   2. AI-agent       — Claude Haiku: nieuws + koersanalyse gecombineerd
//                       (alleen als ANTHROPIC_API_KEY is ingesteld)
//   3. order-agent    — signalen + nieuws-status lezen, veiligheidscheck,
//                       risicoregels, uitvoeren + Blofin-spiegel
//
// Modus:
//   • Zonder ANTHROPIC_API_KEY → oude regel-strategie blijft handelen.
//   • Met key maar zonder AI_PROPOSALS_EXECUTE=on → TESTMODUS: de AI logt
//     voorstellen (outcome 'logged_test'), de regel-strategie handelt.
//   • Met AI_PROPOSALS_EXECUTE=on → de AI-voorstellen worden door het
//     vaste veiligheids-laagje gekeurd en daarna pas uitgevoerd; de
//     regel-strategie gaat op dat moment uit.
//
// Faalt één agent, dan lopen de anderen door. De order-agent past altijd
// de risicoregels toe. Beveiliging: ?token=<PAPER_TOKEN>. Nog steeds
// géén echt geld — fase 3 start pas na een goed verlopen fase 2.

import { NextRequest, NextResponse } from "next/server";
import { newsAgent } from "@/lib/agents/news";
import { analyzeAgent } from "@/lib/agents/analyze";
import { orderAgent } from "@/lib/agents/orders";
import { aiAgent } from "@/lib/agents/ai";
import { aiExecuteEnabled } from "@/lib/agents/config";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!process.env.PAPER_TOKEN || token !== process.env.PAPER_TOKEN) {
    return NextResponse.json({ error: "onbevoegd — token vereist" }, { status: 401 });
  }
  try {
    // 1. nieuws-agent (throttled; fout = doorgaan met laatste status)
    const news = await newsAgent();

    // 2. AI-agent (alleen met API-key; eigen throttle op basis van interval)
    let ai: Awaited<ReturnType<typeof aiAgent>> | null = null;
    if (process.env.ANTHROPIC_API_KEY) {
      ai = await aiAgent();
    }

    // 3. regel-strategie: fallback zónder key; schaduw-meeloper in
    //    testmodus; uit zodra de AI echt stuurt.
    let analyze: Awaited<ReturnType<typeof analyzeAgent>> | null = null;
    let analyzeError: string | null = null;
    const ruleMode = !process.env.ANTHROPIC_API_KEY || !aiExecuteEnabled;
    if (ruleMode) {
      try {
        analyze = await analyzeAgent();
      } catch (e) {
        analyzeError = String(e instanceof Error ? e.message : e);
      }
    }

    // 4. order-agent (de kern — fout = 500 zodat cron-job.org het ziet)
    const orders = await orderAgent();
    return NextResponse.json({ ok: true, ...orders, news, ai, analyze, analyzeError });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
