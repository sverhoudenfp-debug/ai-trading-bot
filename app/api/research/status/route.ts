// ── GET /api/research/status — research-resultaten lezen ────────────────
// Publiek leesbaar (bevat alléén metrics/hypotheses — geen secrets, geen
// tokens, geen exchange-gegevens), net als het bestaande paper-status-
// endpoint. De RUN-endpoint is de enige die token vereist.

import { NextResponse } from "next/server";
import { listCandidates, listRuns, listJobs, tablesReady } from "@/lib/research/db";
import { RESEARCH_MAX_AI_CALLS_PER_DAY, RESEARCH_MAX_COST_USD_PER_DAY } from "@/lib/research/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const ready = await tablesReady();
  if (!ready) {
    return NextResponse.json({
      configured: false,
      note: "supabase-phase2-setup.sql nog niet gedraaid — resultaten staan dan nog lokaal in de run-response; draai de migration voor persistente research-historie",
      budget: { max_calls_per_day: RESEARCH_MAX_AI_CALLS_PER_DAY, max_cost_usd_per_day: RESEARCH_MAX_COST_USD_PER_DAY },
    });
  }
  const [runs, jobs, candidates] = await Promise.all([listRuns(20), listJobs(20), listCandidates(50)]);
  return NextResponse.json({
    configured: true,
    runs,
    jobs,
    candidates,
    budget: { max_calls_per_day: RESEARCH_MAX_AI_CALLS_PER_DAY, max_cost_usd_per_day: RESEARCH_MAX_COST_USD_PER_DAY },
  });
}
