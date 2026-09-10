// ── FASE 4: paper validation tick (Deel 27/28) ─────────────────────────────
// Eén gebonden tick: evalueert alle strategieën in een validatie-status,
// max 1× per 12u (execution-lock via paper_validation_runs.execution_id,
// uniek per strategie per Amsterdamse dag — dubbele runs zijn DB-niveau
// onmogelijk). Bevordert daarna wachtende canary-candidates (Deel 21).
// Blokkeert nóóit de order-flow: try/catch overal, fail-closed.

import {
  listRegistry, RegistryRow,
  insertValidationRun, completeValidationRun, listWaitingForSlot,
} from "@/lib/evolution/db";
import { VALIDATION_STATUSES } from "@/lib/evolution/lifecycle";
import { validateStrategy, ValidationReport } from "./validate";
import { listOrdersSince, getStates } from "@/lib/paper/store";
import { activateCanary } from "@/lib/evolution/registry";
import { clearRegistryCache } from "@/lib/evolution/live";
import { VAL_TICK_MIN_INTERVAL_MIN } from "./config";

let lastAttempt = 0;

export interface TickResult {
  skipped: boolean;
  reason?: string;
  validated: { strategy: string; verdict: string; trades: number; netPnl: number; statusChanged: string | null }[];
  queuePromotions: { strategy: string }[];
  errors: string[];
}

/** Amsterdamse datum (YYYY-MM-DD) — de bot draait op Europe/Amsterdam. */
function amsterdamDate(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(d);
}

export async function validationTick(opts: { now?: Date; force?: boolean } = {}): Promise<TickResult> {
  const now = opts.now ?? new Date();
  const out: TickResult = { skipped: false, validated: [], queuePromotions: [], errors: [] };

  if (!opts.force && Date.now() - lastAttempt < VAL_TICK_MIN_INTERVAL_MIN * 60_000) {
    return { skipped: true, reason: "recent al gedraaid", validated: [], queuePromotions: [], errors: [] };
  }
  lastAttempt = Date.now();

  // ── registry ophalen (fail-closed bij onbereikbaar) ──
  let registry: RegistryRow[] = [];
  try {
    registry = await listRegistry(200);
  } catch (e) {
    out.errors.push(`registry onbereikbaar (fail-closed): ${String(e instanceof Error ? e.message : e)}`);
    return { ...out, skipped: true, reason: "registry onbereikbaar" };
  }

  const inValidation = registry.filter((r) =>
    (VALIDATION_STATUSES as string[]).includes(r.status) && !r.is_legacy
  );
  const activeCanaries = registry.filter((r) => r.status === "PAPER_ACTIVE" && r.canary);

  // ── per strategie: lock → valideren → rapport wegschrijven ──
  const day = amsterdamDate(now);
  let states: { pair: string; status?: string; strategy?: string | null; size?: number | null }[] = [];
  try { states = await getStates(); } catch { /* integrity-check vangt dit op */ }

  for (const row of inValidation) {
    const key = `evo/${row.strategy_id}@${row.version}`;
    const executionId = `val-${row.id}-${day}`;
    const lock = await insertValidationRun({
      execution_id: executionId, registry_id: row.id, strategy_key: key, verdict: "RUNNING",
    });
    if (!lock.ok) {
      // idempotent: vandaag al gevalideerd (of tabel niet gemigreerd → fail-closed skip)
      continue;
    }
    const started = Date.now();
    try {
      const activatedIso = row.activated_at ?? row.created_at;
      const orders = (await listOrdersSince(activatedIso))
        .filter((o) => (o.strategy ?? "").startsWith(key));
      const report: ValidationReport = await validateStrategy({
        row, orders, allStates: states, registry, now, performedBy: "validation-tick",
      });
      await completeValidationRun(executionId, report.verdict, {
        verdict: report.verdict,
        metrics: report.metrics,
        drift: { worst: report.drift.worstLevel, dims: report.drift.dimensions },
        expected: report.expected,
        integrity: report.integrity.issues,
        confidence: report.confidence,
        gate: report.gate.criteria,
        aiExit: report.aiExit,
        baseline: report.baselineComparison,
        statusChanged: report.statusChanged,
      }, Date.now() - started);
      out.validated.push({
        strategy: key,
        verdict: report.verdict,
        trades: report.metrics.closed,
        netPnl: report.metrics.netPnl,
        statusChanged: report.statusChanged ? `${report.statusChanged.from}→${report.statusChanged.to}` : null,
      });
      if (report.statusChanged) clearRegistryCache();
    } catch (e) {
      out.errors.push(`validatie-fout ${key}: ${String(e instanceof Error ? e.message : e)}`);
      await completeValidationRun(executionId, "ERROR", { error: String(e instanceof Error ? e.message : e) }, Date.now() - started);
    }
  }

  // ── canary-queue (Deel 21): slot vrij → oudste wachtende candidate ──
  if (activeCanaries.length === 0 || activeCanaries.filter((r) => r.status === "PAPER_ACTIVE").length === 0) {
    const waiting = await listWaitingForSlot(VAL_QUEUE_LIMIT);
    if (waiting.length) {
      const target = waiting[0];
      // opnieuw checken tegen de actuele registry (constraint-check zit in activateCanary)
      const res = await activateCanary(
        target,
        "canary-slot vrijgekomen — oudste wachtende candidate geactiveerd (queue)",
        "validation-tick"
      );
      if (res.ok) {
        out.queuePromotions.push({ strategy: `evo/${target.strategy_id}@${target.version}` });
        clearRegistryCache();
      }
      // niet activeren = gewoon wachten; géén geforceerde activatie (Deel 31)
    }
  }

  return out;
}

const VAL_QUEUE_LIMIT = 3;

