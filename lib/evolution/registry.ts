// ── FASE 3: gecontroleerde paper-activatie (Deel 8-9, 23) ───────────────
// De ENIGE code die een strategie PAPER_ACTIVE kan maken. Vereist:
//   1. status PAPER_CANDIDATE (dus: research → VALIDATION GATE geslaagd);
//   2. max MAX_CONCURRENT_CANARIES actieve canary's tegelijk;
//   3. max MAX_ACTIVE_PER_FAMILY actieve versies per familie;
//   4. geen duplicaat-signature actief (family-control);
//   5. atomaire transitie (optimistic concurrency) + audit-rij;
//   6. canary-limieten worden vastgelegd (risk-cap 0,25%, max pairs/dag).
// De AI kan deze functie aanroepen met een candidate — maar ALLEEN code
// beslist. LIVE bestaat hier niet.

import {
  insertRegistryRow, transitionStatus, listRegistry, writeAudit,
  activePaperStrategies, RegistryRow,
} from "./db";
import { MAX_CONCURRENT_CANARIES, MAX_ACTIVE_PER_FAMILY, ROLLBACK_COOLDOWN_HOURS } from "./config";
import { specSignature } from "./mutate";
import type { StrategySpec } from "@/lib/research/spec";

export interface ActivationCheck {
  ok: boolean;
  blockers: string[];
}

export function activationCaps(row: RegistryRow): string[] {
  const caps = [`risk per trade ≤ 0,25% van de pot (canary-cap, hard geclampt in de order-agent)`];
  if (row.canary) caps.push(`max 4 pairs (spec-subset)`, `max 4 entries/dag (canary-frequentielimiet)`);
  caps.push("alle Fase 1-guards blijven onverkort geldig (fee-guard, cooldown, frequenties, daglimiet −5%, run-lock)");
  return caps;
}

/** Controleer of activatie mag — puur, testbaar. */
export function checkActivationConstraints(
  candidate: { family: string; strategy_id: string; version: string; signature: string },
  activeRows: RegistryRow[]
): ActivationCheck {
  const blockers: string[] = [];
  const activeCanaries = activeRows.filter((r) => r.canary);
  if (activeCanaries.length >= MAX_CONCURRENT_CANARIES) {
    blockers.push(`al ${activeCanaries.length} canary actief (max ${MAX_CONCURRENT_CANARIES}): ${activeCanaries.map((r) => `${r.strategy_id}@${r.version}`).join(", ")}`);
  }
  const activeFamily = activeRows.filter((r) => r.family === candidate.family);
  if (activeFamily.length >= MAX_ACTIVE_PER_FAMILY) {
    blockers.push(`familie ${candidate.family} heeft al ${activeFamily.length} actieve versie(s) (max ${MAX_ACTIVE_PER_FAMILY})`);
  }
  const duplicateSig = activeRows.find((r) => {
    if (!r.specification) return false;
    try {
      const spec = typeof r.specification === "string" ? JSON.parse(r.specification) : r.specification;
      return specSignature(spec as StrategySpec) === candidate.signature;
    } catch { return false; }
  });
  if (duplicateSig) {
    blockers.push(`bijna-identieke specificatie al actief: ${duplicateSig.strategy_id}@${duplicateSig.version}`);
  }
  return { ok: blockers.length === 0, blockers };
}

/** Nieuwe versie registreren met immutable-identiteit + audit. */
export async function registerVersion(args: {
  strategyId: string;
  family: string;
  version: string;
  parentStrategyId: string | null;
  parentVersion: string | null;
  originCandidateId: number | null;
  researchRunId: string | null;
  spec: StrategySpec;
  hypothesis: string;
  score: number;
  researchMetrics: unknown;
  initialStatus: "RESEARCH_CANDIDATE" | "REJECTED" | "INSUFFICIENT_DATA";
  performedBy: string;
}): Promise<RegistryRow | null> {
  // family-control vóór insert: bestaat deze exacte versie al?
  const existing = await listRegistry(200);
  if (existing.some((r) => r.strategy_id === args.strategyId && r.version === args.version)) {
    await writeAudit({
      registry_id: -1, action: "duplicate_reject", from_status: null, to_status: null,
      reason: `versie ${args.strategyId}@${args.version} bestaat al — immutable, geen stille wijziging`,
      performed_by: args.performedBy, metrics_at: null,
    });
    return null;
  }
  const row = await insertRegistryRow({
    strategy_id: args.strategyId,
    family: args.family,
    version: args.version,
    parent_strategy_id: args.parentStrategyId,
    parent_version: args.parentVersion,
    origin_candidate_id: args.originCandidateId,
    research_run_id: args.researchRunId,
    specification: args.spec,
    hypothesis: args.hypothesis,
    score: args.score,
    research_metrics: args.researchMetrics,
    status: args.initialStatus,
    canary: true,
    is_legacy: false,
  });
  if (row) {
    await writeAudit({
      registry_id: row.id, action: "register", from_status: null, to_status: args.initialStatus,
      reason: `nieuwe immutable versie ${args.strategyId}@${args.version} (parent: ${args.parentStrategyId ?? "-"}@${args.parentVersion ?? "-"}, run ${args.researchRunId ?? "-"})`,
      performed_by: args.performedBy, metrics_at: null,
    });
  }
  return row;
}

/** Canary-activatie: PAPER_CANDIDATE → PAPER_ACTIVE (atoom, geauditeerd). */
export async function activateCanary(
  row: RegistryRow,
  reason: string,
  performedBy: string
): Promise<{ ok: boolean; row: RegistryRow | null; error?: string; blockers?: string[] }> {
  const active = await activePaperStrategies();
  let signature = "";
  try {
    const spec = typeof row.specification === "string" ? JSON.parse(row.specification) : row.specification;
    signature = specSignature(spec as StrategySpec);
  } catch { signature = ""; }
  const check = checkActivationConstraints(
    { family: row.family, strategy_id: row.strategy_id, version: row.version, signature },
    active
  );
  if (!check.ok) {
    // FASE 4 (Deel 21): is het canary-slot bezet, dan NIET weggooien maar
    // in de wachtrij zetten — de validation-tick bevordert zodra het slot
    // vrijkomt. Familie-conflicten en duplicaten gaan niet in de wachtrij.
    const slotTaken = check.blockers.some((b) => b.includes("canary actief"));
    if (slotTaken && row.status === "PAPER_CANDIDATE") {
      const queued = await transitionStatus(row.id, "PAPER_CANDIDATE", "WAITING_FOR_CANARY_SLOT", {}, {
        reason: `canary-slot bezet — in wachtrij gezet (${check.blockers.join("; ")})`,
        performed_by: performedBy, action: "queue",
      });
      if (queued.ok) {
        return { ok: false, row: queued.row, error: "WAITING_FOR_CANARY_SLOT", blockers: check.blockers };
      }
    }
    await writeAudit({
      registry_id: row.id, action: "activate", from_status: row.status, to_status: row.status,
      reason: `activatie GEWEIGERD: ${check.blockers.join("; ")}`, performed_by: performedBy, metrics_at: row.research_metrics,
    });
    return { ok: false, row, error: "activatie-voorwaarden niet voldaan", blockers: check.blockers };
  }

  const from = row.status === "WAITING_FOR_CANARY_SLOT" ? "WAITING_FOR_CANARY_SLOT" : "PAPER_CANDIDATE";
  const res = await transitionStatus(row.id, from as never, "PAPER_ACTIVE", {
    activated_at: new Date().toISOString(),
    activation_reason: reason,
    canary: true,
  }, { reason, performed_by: performedBy, action: "activate" });
  if (!res.ok) return { ok: false, row, error: res.error };
  return { ok: true, row: res.row };
}

/** Rollback: PAPER_ACTIVE → ROLLED_BACK met cooldown + volledige reden (Deel 13-14). */
export async function rollbackStrategy(
  row: RegistryRow,
  fromStatus: "PAPER_ACTIVE" | "PAPER_VALIDATING",
  triggers: string[],
  performedBy: string
): Promise<{ ok: boolean; error?: string }> {
  const cooldownUntil = new Date(Date.now() + ROLLBACK_COOLDOWN_HOURS * 3_600_000).toISOString();
  const res = await transitionStatus(row.id, fromStatus, "ROLLED_BACK", {
    deactivated_at: new Date().toISOString(),
    rollback_reason: triggers.join("; ").slice(0, 900),
    cooldown_until: cooldownUntil,
  }, {
    reason: `ROLLBACK: ${triggers.join("; ")}`,
    performed_by: performedBy,
    action: "rollback",
  });
  return { ok: res.ok, error: res.error };
}
