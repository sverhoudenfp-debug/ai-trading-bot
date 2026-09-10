// ── GET /api/evolution/status — publiek leesbaar (dashboard) ────────────
// Toont registry + laatste audits + paper-metrics. Geen schrijfrechten,
// geen execution — puur lezen.

import { NextResponse } from "next/server";
import { listRegistry, listActivations, registryConfigured } from "@/lib/evolution/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const configured = await registryConfigured();
  const registry = await listRegistry(100);
  const activations = await listActivations(50);
  return NextResponse.json({
    configured,
    registry,
    activations,
    live_trading: "IMPOSSIBLE — geen live-status bestaat in de lifecycle",
  });
}
