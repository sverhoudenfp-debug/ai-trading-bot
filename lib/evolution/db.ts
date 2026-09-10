// ── FASE 3: strategy-registry DB-laag ─────────────────────────────────
// strategy_registry (immutable versions) + strategy_activations (audit)
// + strategy_paper_metrics (monitoring-snapshots). Tabellen uit
// supabase-phase3-setup.sql.
//
// VEILIGHEID (Deel 23/25):
//  • ATOMAIR: status-overgangen via PATCH met status=eq.<oude>-filter
//    (optimistic concurrency) — twee gelijktijdige acties kunnen nooit
//    beide slagen; een versie kan nooit dubbel activeren.
//  • FAIL-CLOSED: is de registry onbereikbaar → null/lege lijsten →
//    géén nieuwe activering, géén signalen; bestaand risicobeheer loopt door.
//  • Elke overgang schrijft een audit-rij (who/when/what/why/metrics).

import { RegistryStatus, transitionAllowed, reactivationBlocked } from "./lifecycle";

const URL_ = process.env.SUPABASE_URL ?? "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function h(extra?: Record<string, string>): Record<string, string> {
  return { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...extra };
}

export interface RegistryRow {
  id: number;
  created_at: string;
  strategy_id: string;          // slug van de versie (bijv. rsi-dip-volfilter)
  family: string;               // bijv. RSI-MEAN-REVERSION
  version: string;              // semver, bijv. 2.0.0
  parent_strategy_id: string | null;
  parent_version: string | null;
  origin_candidate_id: number | null;   // research_candidates.id
  research_run_id: string | null;
  specification: unknown;       // StrategySpec (data, geen code)
  hypothesis: string | null;
  score: number | null;
  research_metrics: unknown;   // snapshot: is/oos/wf/robustness/flags/perPair
  status: RegistryStatus;
  canary: boolean;
  is_legacy: boolean;
  activated_at: string | null;
  deactivated_at: string | null;
  activation_reason: string | null;
  rollback_reason: string | null;
  cooldown_until: string | null;
}

export async function registryConfigured(): Promise<boolean> {
  if (!URL_ || !KEY) return false;
  // daadwerkelijk pollen: pas true als de TABEL bestaat (HTTP 200).
  // Een 404 (migration nog niet gedraaid) of netwerkfout = NOT configured
  // → UI toont de migration-waarschuwing, activatie blijft fail-closed.
  try {
    const res = await fetch(`${URL_}/rest/v1/strategy_registry?select=id&limit=1`, { headers: h(), cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listRegistry(limit = 100): Promise<RegistryRow[]> {
  if (!URL_ || !KEY) return [];
  try {
    const res = await fetch(`${URL_}/rest/v1/strategy_registry?order=created_at.desc&limit=${limit}`, { headers: h(), cache: "no-store" });
    if (!res.ok) return [];
    return (await res.json()) as RegistryRow[];
  } catch { return []; }
}

export async function getRegistryRow(id: number): Promise<RegistryRow | null> {
  if (!URL_ || !KEY) return null;
  try {
    const res = await fetch(`${URL_}/rest/v1/strategy_registry?id=eq.${id}`, { headers: h(), cache: "no-store" });
    if (!res.ok) return null;
    const rows = await res.json();
    return (rows as RegistryRow[])[0] ?? null;
  } catch { return null; }
}

export async function activePaperStrategies(): Promise<RegistryRow[]> {
  if (!URL_ || !KEY) return [];
  try {
    const res = await fetch(`${URL_}/rest/v1/strategy_registry?status=eq.PAPER_ACTIVE`, { headers: h(), cache: "no-store" });
    if (!res.ok) return [];
    return (await res.json()) as RegistryRow[];
  } catch { return []; }
}

// ── audit trail (Deel 39) ───────────────────────────────────────────────
export interface ActivationAudit {
  registry_id: number;
  action: string;               // promote | activate | validate_pass | validate_fail | rollback | deactivate | cooldown | duplicate_reject | conflict_skip
  from_status: string | null;
  to_status: string | null;
  reason: string;
  performed_by: string;         // evolution-engine | elara | cron | manual
  metrics_at: unknown;
}
export async function writeAudit(a: ActivationAudit): Promise<void> {
  if (!URL_ || !KEY) return;
  try {
    await fetch(`${URL_}/rest/v1/strategy_activations`, {
      method: "POST",
      headers: h(),
      body: JSON.stringify(a),
    });
  } catch { /* audit faalt nooit de hoofdflow */ }
}

export async function listActivations(limit = 50): Promise<unknown[]> {
  if (!URL_ || !KEY) return [];
  try {
    const res = await fetch(`${URL_}/rest/v1/strategy_activations?order=created_at.desc&limit=${limit}`, { headers: h() });
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

// ── nieuwe versie registreren (immutable) ──────────────────────────────
export async function insertRegistryRow(row: Partial<RegistryRow> & {
  strategy_id: string; family: string; version: string; status: RegistryStatus;
}): Promise<RegistryRow | null> {
  if (!URL_ || !KEY) return null;
  try {
    const res = await fetch(`${URL_}/rest/v1/strategy_registry`, {
      method: "POST",
      headers: h({ Prefer: "return=representation" }),
      body: JSON.stringify({
        ...row,
        specification: row.specification === undefined ? null : JSON.stringify(row.specification),
        research_metrics: row.research_metrics === undefined ? null : JSON.stringify(row.research_metrics),
      }),
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return (rows as RegistryRow[])[0] ?? null;
  } catch { return null; }
}

/**
 * ATOMAIRE status-overgang: PATCH die alléén slaat als de status nóg de
 * verwachte oude is (optimistic concurrency). Verbruikt ook de lifecycle-
 * regels en het rollback-verbod. Retourneert de nieuwe rij of null.
 */
export async function transitionStatus(
  id: number,
  from: RegistryStatus,
  to: RegistryStatus,
  patch: Partial<RegistryRow> = {},
  audit?: { reason: string; performed_by: string; action: string }
): Promise<{ ok: boolean; row: RegistryRow | null; error?: string }> {
  if (!URL_ || !KEY) return { ok: false, row: null, error: "registry niet geconfigureerd (fail-closed)" };
  if (reactivationBlocked(from) && (to === "PAPER_ACTIVE" || to === "PAPER_CANDIDATE" || to === "VALIDATION_PENDING")) {
    return { ok: false, row: null, error: `re-activatie van status ${from} is verboden (nieuwe versie vereist)` };
  }
  if (!transitionAllowed(from, to)) {
    return { ok: false, row: null, error: `ongeldige transitie ${from} → ${to}` };
  }
  try {
    const res = await fetch(`${URL_}/rest/v1/strategy_registry?id=eq.${id}&status=eq.${from}`, {
      method: "PATCH",
      headers: h({ Prefer: "return=representation" }),
      body: JSON.stringify({ status: to, ...patch }),
    });
    if (!res.ok) return { ok: false, row: null, error: `PATCH faalde (${res.status})` };
    const rows = await res.json();
    const row = (rows as RegistryRow[])[0] ?? null;
    if (!row) return { ok: false, row: null, error: `transitie ${from} → ${to} verloor de race (atomaire guard)` };
    if (audit) {
      await writeAudit({ registry_id: id, from_status: from, to_status: to, metrics_at: row.research_metrics, ...audit });
    }
    return { ok: true, row };
  } catch (e) {
    return { ok: false, row: null, error: String(e instanceof Error ? e.message : e) };
  }
}

// ── paper-metrics snapshots ─────────────────────────────────────────────
export async function insertPaperMetrics(m: Record<string, unknown> & { registry_id: number }): Promise<void> {
  if (!URL_ || !KEY) return;
  try {
    await fetch(`${URL_}/rest/v1/strategy_paper_metrics`, {
      method: "POST",
      headers: h(),
      body: JSON.stringify({ ...m, metrics: JSON.stringify((m as { metrics?: unknown }).metrics ?? null) }),
    });
  } catch { /* nooit breken */ }
}

export async function listPaperMetrics(registryId: number, limit = 50): Promise<unknown[]> {
  if (!URL_ || !KEY) return [];
  try {
    const res = await fetch(`${URL_}/rest/v1/strategy_paper_metrics?registry_id=eq.${registryId}&order=created_at.desc&limit=${limit}`, { headers: h() });
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

// ── FASE 4: paper_validation_runs — gebonden, idempotente validatie-runs ──
// execution_id is UNIEK (DB-constraint): één run per strategie per dag
// (Amsterdamse datum) — dubbele runs zijn fysiek onmogelijk.
export interface ValidationRunRow {
  id: number;
  created_at: string;
  execution_id: string;        // bijv. val-12-2026-09-10
  registry_id: number;
  strategy_key: string | null;
  verdict: string;
  report: unknown;             // volledig JSON-rapport
  duration_ms: number | null;
}

/** Insert met unique-guard: false = run bestaat al (of tabel niet geconfigureerd). */
export async function insertValidationRun(row: {
  execution_id: string; registry_id: number; strategy_key: string; verdict: string;
}): Promise<{ ok: boolean; reason?: string }> {
  if (!URL_ || !KEY) return { ok: false, reason: "niet geconfigureerd (fail-closed)" };
  try {
    const res = await fetch(`${URL_}/rest/v1/paper_validation_runs`, {
      method: "POST",
      headers: h(),
      body: JSON.stringify({ ...row, report: null, duration_ms: null }),
    });
    if (res.status === 409) return { ok: false, reason: "run bestaat al voor vandaag (idempotent)" };
    if (!res.ok) return { ok: false, reason: `insert faalde (${res.status}) — tabel bestaat? supabase-phase4-setup.sql` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e instanceof Error ? e.message : e) };
  }
}

/** Update de run met het definitieve rapport (na de berekening). */
export async function completeValidationRun(executionId: string, verdict: string, report: unknown, durationMs: number): Promise<void> {
  if (!URL_ || !KEY) return;
  try {
    await fetch(`${URL_}/rest/v1/paper_validation_runs?execution_id=eq.${encodeURIComponent(executionId)}`, {
      method: "PATCH",
      headers: h(),
      body: JSON.stringify({ verdict, report: JSON.stringify(report), duration_ms: Math.round(durationMs) }),
    });
  } catch { /* nooit breken */ }
}

export async function listValidationRuns(limit = 50): Promise<ValidationRunRow[]> {
  if (!URL_ || !KEY) return [];
  try {
    const res = await fetch(`${URL_}/rest/v1/paper_validation_runs?order=created_at.desc&limit=${limit}`, { headers: h() });
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

/** Wachtende canary-candidates (Deel 21-queue), oudste eerst. */
export async function listWaitingForSlot(limit = 10): Promise<RegistryRow[]> {
  if (!URL_ || !KEY) return [];
  try {
    const res = await fetch(`${URL_}/rest/v1/strategy_registry?status=eq.WAITING_FOR_CANARY_SLOT&order=created_at.asc&limit=${limit}`, { headers: h() });
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}
