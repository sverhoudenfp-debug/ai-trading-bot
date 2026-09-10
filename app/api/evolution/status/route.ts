// ── GET /api/evolution/status — publiek leesbaar (dashboard) ────────────
// Toont registry + laatste audits + paper-metrics. Geen schrijfrechten,
// geen execution — puur lezen.

import { NextResponse } from "next/server";
import { listRegistry, listActivations, registryConfigured, listValidationRuns, listPaperMetrics } from "@/lib/evolution/db";
import { VALIDATION_STATUSES } from "@/lib/evolution/lifecycle";

export const dynamic = "force-dynamic";

export async function GET() {
  const configured = await registryConfigured();
  const registry = await listRegistry(100);
  const activations = await listActivations(50);

  // FASE 4 (Deel 36/39): laatste validatie-runs + paper-snapshots per
  // strategie in validatie — puur lezen, géén zware herberekening.
  let validationRuns: unknown[] = [];
  let paperMetrics: Record<string, unknown> = {};
  try {
    validationRuns = await listValidationRuns(50);
    const inValidation = registry.filter(
      (r) => (VALIDATION_STATUSES as string[]).includes(r.status) || r.status === "PAPER_APPROVED"
    );
    for (const r of inValidation.slice(0, 5)) {
      const m = await listPaperMetrics(r.id, 3);
      paperMetrics[`evo/${r.strategy_id}@${r.version}`] = m;
    }
  } catch { /* leesbaar blijft leeg bij fout */ }

  return NextResponse.json({
    configured,
    registry,
    activations,
    validation: { runs: validationRuns, paperMetrics },
    live_trading: "IMPOSSIBLE — geen live-status bestaat in de lifecycle",
  });
}
