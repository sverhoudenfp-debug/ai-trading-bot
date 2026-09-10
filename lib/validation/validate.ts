// ── FASE 4: validatie-orchestrator per strategy-versie ────────────────────
// Koppelt alle pure modules aan elkaar en op de registry:
//   metrics → drift → integrity → confidence → approval gate → verdict.
// Hiertoe horen ook de statusovergangen (met audit):
//   PAPER_ACTIVE → VALIDATION_EARLY → VALIDATION_PROGRESS → VALIDATION_READY → PAPER_APPROVED
//   of → FAILED (na voldoende data) of → ROLLED_BACK (via de bestaande monitor).
// NOOIT een route naar LIVE; canTradePaper blijft alléén PAPER_ACTIVE.

import type { RegistryRow } from "@/lib/evolution/db";
import { transitionStatus, insertPaperMetrics } from "@/lib/evolution/db";
import type { PaperOrderExt } from "@/lib/paper/store";
import { computeFullPaperMetrics, aiExitVerdict, FullPaperMetrics } from "./metrics";
import { computeDrift, expectedProfileFrom, DriftReport, ExpectedProfile } from "./drift";
import { checkDataIntegrity, IntegrityReport } from "./integrity";
import { confidenceReport, ConfidenceReport } from "./confidence";
import { runApprovalGate, ApprovalGateResult, ValidationVerdict } from "./approve";
import { MIN_HOLD_MIN } from "@/lib/risk/config";

export interface ValidationReport {
  strategyKey: string;
  verdict: ValidationVerdict;
  metrics: FullPaperMetrics;
  drift: DriftReport;
  expected: ExpectedProfile;
  integrity: IntegrityReport;
  confidence: ConfidenceReport;
  gate: ApprovalGateResult;
  aiExit: ReturnType<typeof aiExitVerdict>;
  statusChanged: { from: string; to: string } | null;
  baselineComparison: string;
}

/** Pure kern: alles berekenen zonder I/O (afzien van de statusmutatie). */
export function buildValidationReport(args: {
  row: RegistryRow;
  orders: PaperOrderExt[];       // alleen de orders van DEZE strategie sinds activated_at
  allStates: { pair: string; status?: string; strategy?: string | null; size?: number | null }[];
  registry: RegistryRow[];
  now?: Date;
}): Omit<ValidationReport, "statusChanged"> {
  const now = args.now ?? new Date();
  const key = `evo/${args.row.strategy_id}@${args.row.version}`;
  const activatedAt = args.row.activated_at ?? now.toISOString();

  const metrics = computeFullPaperMetrics({ orders: args.orders, activatedAt, now });
  const expected = expectedProfileFrom(args.row);
  const drift = computeDrift(expected, metrics, MIN_HOLD_MIN);
  const integrity = checkDataIntegrity({
    orders: args.orders, allStates: args.allStates, registry: args.registry, strategyKey: key,
  });
  const observationDays = metrics.observationHours / 24;
  const confidence = confidenceReport({
    pnls: args.orders
      .filter((o) => o.pnl_eur !== null && o.pnl_eur !== undefined)
      .map((o) => o.pnl_eur ?? 0),
    trades: metrics.closed,
    observationDays,
    activeDays: metrics.activeDays,
  });
  const gate = runApprovalGate({ metrics, drift, integrity, confidence, expected, minHoldFloorMin: MIN_HOLD_MIN });
  const aiExit = aiExitVerdict(metrics);

  // ── Deel 16: paper vs baseline (parent) — rapportage, geen harde eis ──
  const parent = args.registry.find(
    (r) => r.strategy_id === args.row.parent_strategy_id && r.version === args.row.parent_version
  ) ?? args.registry.find((r) => r.is_legacy && r.strategy_id === args.row.parent_strategy_id);
  const parentRm = (parent?.research_metrics ?? null) as { oos?: { expectancyEur?: number; netPnl?: number } } | null;
  const baselineComparison = parentRm?.oos
    ? `parent ${args.row.parent_strategy_id ?? "-"}: backtest-OOS exp €${parentRm.oos.expectancyEur ?? 0}/trade, netto €${parentRm.oos.netPnl ?? 0} || deze versie in PAPER: exp €${metrics.expectancyEur}/trade, netto €${metrics.netPnl} — paper hoeft buy&hold nu nog niet te verslaan, dit is de vergelijking`
    : "geen parent/baseline beschikbaar voor vergelijking";

  return { strategyKey: key, verdict: gate.verdict, metrics, drift, expected, integrity, confidence, gate, aiExit, baselineComparison };
}

/**
 * Volledige run incl. statusmutatie + snapshot-opslag.
 * De caller (tick) zorgt voor lock/idempotency; deze functie is zelf
 * ook veilig: alle overgangen atomair via transitionStatus.
 */
export async function validateStrategy(args: {
  row: RegistryRow;
  orders: PaperOrderExt[];
  allStates: { pair: string; status?: string; strategy?: string | null; size?: number | null }[];
  registry: RegistryRow[];
  now?: Date;
  performedBy?: string;
}): Promise<ValidationReport> {
  const now = args.now ?? new Date();
  const report = buildValidationReport({ ...args, now });
  let statusChanged: { from: string; to: string } | null = null;

  const from = args.row.status;
  // rollback-triggers blijven in de monitor (elke order-run); hier de
  // Fase 4-oordeelladder. FADECLOSED bij integriteit: bij CRITICAL issues
  // géén promotie — terug naar meten of FAILED, nooit verder omhoog.
  let to: string | null = null;
  let auditAction = "validate";
  if (report.integrity.ok === false) {
    // integriteitsprobleem: strategie bevriest in de huidige meetstatus;
    // activatie van NIEUWE strategies is al fail-closed in de registry-check
    to = null;
  } else if (report.verdict === "PAPER_APPROVED") {
    to = from === "VALIDATION_READY" ? "PAPER_APPROVED"
      : from === "PAPER_VALIDATING" || from === "VALIDATION_PROGRESS" ? "VALIDATION_READY" : null;
  } else if (report.verdict === "FAILED") {
    to = "FAILED";
    auditAction = "fail";
  } else if (report.verdict === "VALIDATION_READY") {
    to = "VALIDATION_READY";
  } else if (report.verdict === "VALIDATION_PROGRESS" || report.verdict === "INSUFFICIENT_DATA") {
    to = from === "PAPER_ACTIVE" ? "VALIDATION_EARLY" : null;
    if (from === "VALIDATION_PROGRESS" && report.verdict === "INSUFFICIENT_DATA") to = "VALIDATION_PROGRESS";
  } else if (report.verdict === "VALIDATION_EARLY") {
    to = from === "PAPER_ACTIVE" ? "VALIDATION_EARLY" : null;
  }

  if (to && to !== from) {
    const res = await transitionStatus(args.row.id, from as never, to as never, {}, {
      reason: `paper-validation ${report.verdict}: ${report.gate.blockers.length ? report.gate.blockers.slice(0, 2).join("; ") : report.confidence.note}`,
      performed_by: args.performedBy ?? "paper-validation-tick",
      action: auditAction,
    });
    if (res.ok) statusChanged = { from, to };
  }

  // snapshot in strategy_paper_metrics (Fase 3-tabel hergebruikt, Deel 38)
  await insertPaperMetrics({
    registry_id: args.row.id,
    strategy_key: report.strategyKey,
    state: report.verdict,
    drift: JSON.stringify({
      worst: report.drift.worstLevel,
      dims: report.drift.dimensions.map((d) => ({ d: d.dimension, lvl: d.level, exp: d.expected, act: d.actual })),
      baseline: report.baselineComparison,
    }),
    metrics: report.metrics,
    triggers: JSON.stringify(report.gate.blockers),
    warnings: JSON.stringify([
      ...report.drift.dimensions.filter((d) => d.level !== "NORMAL").map((d) => `${d.level}: ${d.dimension} ${d.expected}→${d.actual} (${d.note})`),
      ...(report.aiExit.level !== "OK" ? [report.aiExit.reason] : []),
      ...report.integrity.issues.map((i) => `${i.severity}: ${i.check} — ${i.detail}`),
    ]),
  });

  return { ...report, statusChanged };
}
