// ── FASE 2: research-databank ───────────────────────────────────────────
// Drie tabellen (supabase-phase2-setup.sql):
//   research_jobs      — job-queue (pending/running/completed/failed/cancelled)
//   research_runs      — log per run (model, tokens, kosten, dataset, resultaat)
//   research_candidates— lifecycle-record per geteste strategie
// Alle toegangen zijn try/catch: research mag nóóit breken op een
// database-hikje (de trading-engine heeft hier géén enkele afhankelijkheid op).

const URL_ = process.env.SUPABASE_URL ?? "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function h(extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

export async function tablesReady(): Promise<boolean> {
  return Boolean(URL_ && KEY);
}

// ── jobs ────────────────────────────────────────────────────────────────
export async function createJob(type: string, requestedBy: string): Promise<number | null> {
  if (!URL_ || !KEY) return null;
  try {
    const res = await fetch(`${URL_}/rest/v1/research_jobs`, {
      method: "POST",
      headers: h({ Prefer: "return=representation" }),
      body: JSON.stringify({ type, status: "running", requested_by: requestedBy, started_at: new Date().toISOString() }),
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0]?.id ?? null;
  } catch { return null; }
}

export async function finishJob(id: number | null, status: "completed" | "failed", summary: string): Promise<void> {
  if (!id || !URL_ || !KEY) return;
  try {
    await fetch(`${URL_}/rest/v1/research_jobs?id=eq.${id}`, {
      method: "PATCH",
      headers: h(),
      body: JSON.stringify({ status, ended_at: new Date().toISOString(), summary: summary.slice(0, 2000) }),
    });
  } catch { /* nooit breken */ }
}

// ── runs ────────────────────────────────────────────────────────────────
export interface RunLog {
  run_id: string;
  type: string;                    // baseline | ai-research | full
  started_at: string;
  ended_at: string;
  model: string | null;
  ai_calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd_est: number;
  dataset_days: number;
  pairs: string[];
  strategies_tested: number;
  hypotheses_generated: number;
  candidates_found: number;
  rejected: number;
  insufficient_data: number;
  errors: string[];
}

export async function insertRun(log: RunLog): Promise<void> {
  if (!URL_ || !KEY) return;
  try {
    await fetch(`${URL_}/rest/v1/research_runs`, {
      method: "POST",
      headers: h(),
      body: JSON.stringify(log),
    });
  } catch { /* nooit breken */ }
}

/** AI-kosten van research-runs vandaag (voor het aparte research-budget). */
export async function researchUsageToday(): Promise<{ calls: number; costUsd: number }> {
  if (!URL_ || !KEY) return { calls: 0, costUsd: 0 };
  try {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const res = await fetch(
      `${URL_}/rest/v1/research_runs?created_at=gte.${encodeURIComponent(since)}&select=ai_calls,cost_usd_est`,
      { headers: h() }
    );
    if (!res.ok) return { calls: 0, costUsd: 0 };
    const rows: { ai_calls: number; cost_usd_est: number }[] = await res.json();
    return {
      calls: rows.reduce((a, r) => a + (r.ai_calls ?? 0), 0),
      costUsd: rows.reduce((a, r) => a + (r.cost_usd_est ?? 0), 0),
    };
  } catch { return { calls: 0, costUsd: 0 }; }
}

// ── candidates ──────────────────────────────────────────────────────────
export interface CandidateRecord {
  strategy_id: string;
  name: string;
  version: number;
  status: string;                    // HYPOTHESIS..RESEARCH_CANDIDATE (nooit ACTIVE)
  origin: string;
  hypothesis: string;
  specification: unknown;
  researcher_model: string | null;
  dataset_days: number;
  pairs: string[];
  timeframe: string;
  is_metrics: unknown;
  oos_metrics: unknown;
  walkforward: unknown;
  robustness: unknown;
  overfitting_flags: unknown;
  regime_performance: unknown;
  per_pair: unknown;
  fee_assumptions_pct: number;
  slippage_assumptions_pct: number;
  sample_size: number;
  score: number;
  rejection_reasons: string[];
  research_explanation: string;
}

export async function insertCandidate(c: CandidateRecord): Promise<void> {
  if (!URL_ || !KEY) return;
  try {
    await fetch(`${URL_}/rest/v1/research_candidates`, {
      method: "POST",
      headers: h(),
      body: JSON.stringify({
        ...c,
        specification: JSON.stringify(c.specification),
        is_metrics: JSON.stringify(c.is_metrics),
        oos_metrics: JSON.stringify(c.oos_metrics),
        walkforward: JSON.stringify(c.walkforward),
        robustness: JSON.stringify(c.robustness),
        overfitting_flags: JSON.stringify(c.overfitting_flags),
        regime_performance: JSON.stringify(c.regime_performance),
        per_pair: JSON.stringify(c.per_pair),
      }),
    });
  } catch { /* nooit breken */ }
}

export async function listCandidates(limit = 50): Promise<unknown[]> {
  if (!URL_ || !KEY) return [];
  try {
    const res = await fetch(
      `${URL_}/rest/v1/research_candidates?order=created_at.desc&limit=${limit}&select=id,created_at,name,status,origin,score,sample_size,rejection_reasons,research_explanation,oos_metrics,timeframe,pairs`,
      { headers: h() }
    );
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

export async function listRuns(limit = 20): Promise<unknown[]> {
  if (!URL_ || !KEY) return [];
  try {
    const res = await fetch(
      `${URL_}/rest/v1/research_runs?order=created_at.desc&limit=${limit}`,
      { headers: h() }
    );
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

export async function listJobs(limit = 20): Promise<unknown[]> {
  if (!URL_ || !KEY) return [];
  try {
    const res = await fetch(
      `${URL_}/rest/v1/research_jobs?order=created_at.desc&limit=${limit}`,
      { headers: h() }
    );
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}
