// ── Orchestrator: de cron-wekker van cron-job.org tikt hier ──────────────
// Eén tick = de agents achter elkaar, die uitsluitend via de database
// communiceren (elk leest de laatste status van de ander):
//   1. nieuws-agent   — RSS-radar (source of truth voor news_alerts),
//                       max 1x per 10 min (throttle)
//   2. AI-agent       — Claude Haiku (budget-bewaakt, strikt gevalideerd)
//   3. regel-strategie— alleen in fallback/testmodus (zonder AI-key)
//   4. order-agent    — atomaire claims + risk-engine + uitvoeren + spiegel
//
// Fase 1-robustheid:
//   • maxDuration expliciet (Vercel)
//   • execution-id + start/eind-tijden + timings per agent
//   • per-agent foutafhandeling: één falende externe API laat de rest
//     gewoon draaien; alleen een falende order-agent is een echte 500
//     (de cron moet zien dat de kern niet liep)
//   • de order-agent claimt intern een atomaire run-lock — een tweede
//     gelijktijdige tick wordt netjes overgeslagen
//
// Modus (onveranderd): AI_PROPOSALS_EXECUTE=on → AI stuurt (paper!);
// zonder key → regel-strategie; testmodus → voorstellen alleen gelogd.
// Nog steeds géén echt geld — PAPER/DEMO alléén.

import { NextRequest, NextResponse } from "next/server";
import { newsAgent } from "@/lib/agents/news";
import { analyzeAgent } from "@/lib/agents/analyze";
import { orderAgent } from "@/lib/agents/orders";
import { aiAgent } from "@/lib/agents/ai";
import { aiExecuteEnabled } from "@/lib/agents/config";
import { tokenOk } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!tokenOk(req)) {
    return NextResponse.json({ error: "onbevoegd — token vereist" }, { status: 401 });
  }
  const executionId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const timings: Record<string, number> = {};
  const errors: Record<string, string> = {};

  const t0 = Date.now();
  // 1. nieuws-agent (throttled; fout = doorgaan met laatste status)
  const news = await newsAgent().catch((e) => {
    errors.news = String(e instanceof Error ? e.message : e);
    return { ran: false, level: "unknown", reason: "nieuws-agent crashte", headlines: [] };
  });
  timings.news_ms = Date.now() - t0;

  // 2. AI-agent (alleen met API-key; eigen budget- + interval-throttle)
  const t1 = Date.now();
  let ai: Awaited<ReturnType<typeof aiAgent>> | null = null;
  if (process.env.ANTHROPIC_API_KEY) {
    ai = await aiAgent().catch((e) => {
      errors.ai = String(e instanceof Error ? e.message : e);
      return { ran: false, proposals: 0, level: "unknown", error: errors.ai };
    });
  }
  timings.ai_ms = Date.now() - t1;

  // 3. regel-strategie: fallback zónder key; schaduw-meeloper in testmodus;
  //    uit zodra de AI echt stuurt.
  const t2 = Date.now();
  let analyze: Awaited<ReturnType<typeof analyzeAgent>> | null = null;
  const ruleMode = !process.env.ANTHROPIC_API_KEY || !aiExecuteEnabled;
  if (ruleMode) {
    try {
      analyze = await analyzeAgent();
    } catch (e) {
      errors.analyze = String(e instanceof Error ? e.message : e);
    }
  }
  timings.analyze_ms = Date.now() - t2;

  // 4. order-agent (de kern — fout = 500 zodat cron-job.org het ziet)
  const t3 = Date.now();
  try {
    const orders = await orderAgent(false, executionId);
    timings.orders_ms = Date.now() - t3;
    return NextResponse.json({
      ...orders,
      execution_id: executionId,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      timings,
      errors: Object.keys(errors).length ? errors : undefined,
      news,
      ai,
      analyze,
    });
  } catch (e) {
    timings.orders_ms = Date.now() - t3;
    return NextResponse.json({
      ok: false,
      execution_id: executionId,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      timings,
      errors,
      error: String(e instanceof Error ? e.message : e),
    }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
