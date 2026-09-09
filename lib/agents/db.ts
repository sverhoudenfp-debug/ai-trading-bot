// ── Agent-database: signalen, nieuws-status, strategie-versies, AI-logs ─
// De agents praten NIET direct met elkaar: ze lezen en schrijven elkaars
// status via deze tabellen in Supabase. Zelfde REST-stijl als
// lib/paper/store.ts (service_role, server-side only).

const URL_ = process.env.SUPABASE_URL ?? "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function headers(extra?: Record<string, string>) {
  return {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

// ── Signaal (analyse-agent / AI-agent → order-agent) ────────────────────

export interface TradeSignal {
  id: number;
  created_at: string;
  pair: string;
  side: "buy" | "sell";
  kind: "entry" | "exit";
  reason: string;
  strategy_version: string;
  outcome: string;
  outcome_reason: string | null;
  consumed: boolean;
  consumed_at: string | null;
  ai_explanation?: string | null;
  timeframe?: string | null;
  sl_pct?: number | null;
  tp_pct?: number | null;
  risk_pct?: number | null;
  proposed_by?: string | null;
  confidence?: string | null;
}

export interface NewSignal {
  pair: string;
  side: "buy" | "sell";
  kind: "entry" | "exit";
  reason: string;
  strategy_version: string;
  ai_explanation?: string | null;
  timeframe?: string | null;
  sl_pct?: number | null;
  tp_pct?: number | null;
  risk_pct?: number | null;
  proposed_by?: string;
  confidence?: string | null;
  consumed?: boolean;
  outcome?: string;
}

export async function insertSignal(sig: NewSignal): Promise<void> {
  const r = await fetch(`${URL_}/rest/v1/trade_signals`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(sig),
  });
  if (!r.ok) throw new Error(`Supabase insertSignal: HTTP ${r.status}`);
}

/** Onverbruikte signalen die nog vers zijn (binnen `freshMin` minuten). */
export async function freshUnconsumedSignals(freshMin: number): Promise<TradeSignal[]> {
  const since = new Date(Date.now() - freshMin * 60_000).toISOString();
  const r = await fetch(
    `${URL_}/rest/v1/trade_signals?select=*&consumed=eq.false&created_at=gte.${since}&order=created_at.asc`,
    { headers: headers(), cache: "no-store" }
  );
  if (!r.ok) throw new Error(`Supabase freshUnconsumedSignals: HTTP ${r.status}`);
  const rows = (await r.json()) ?? [];
  return rows.map(mapSignal);
}

/** Onverbruikte signalen van de afgelopen `min` minuten (voor dedup). */
export async function recentUnconsumedSignals(min: number): Promise<TradeSignal[]> {
  const since = new Date(Date.now() - min * 60_000).toISOString();
  const r = await fetch(
    `${URL_}/rest/v1/trade_signals?select=*&consumed=eq.false&created_at=gte.${since}`,
    { headers: headers(), cache: "no-store" }
  );
  if (!r.ok) throw new Error(`Supabase recentUnconsumedSignals: HTTP ${r.status}`);
  const rows = (await r.json()) ?? [];
  return rows.map(mapSignal);
}

/** Order-agent markeert wat er met een signaal is gebeurd. */
export async function markSignal(id: number, outcome: string, outcomeReason: string): Promise<void> {
  const r = await fetch(`${URL_}/rest/v1/trade_signals?id=eq.${id}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({
      outcome,
      outcome_reason: outcomeReason,
      consumed: true,
      consumed_at: new Date().toISOString(),
    }),
  });
  if (!r.ok) throw new Error(`Supabase markSignal: HTTP ${r.status}`);
}

/** Laatste N signalen voor het dashboard (incl. uitkomst + AI-velden). */
export async function listSignals(limit = 15): Promise<TradeSignal[]> {
  const r = await fetch(
    `${URL_}/rest/v1/trade_signals?select=*&order=created_at.desc&limit=${limit}`,
    { headers: headers(), cache: "no-store" }
  );
  if (!r.ok) throw new Error(`Supabase listSignals: HTTP ${r.status}`);
  const rows = (await r.json()) ?? [];
  return rows.map(mapSignal);
}

function mapSignal(x: Record<string, unknown>): TradeSignal {
  return {
    id: Number(x.id),
    created_at: String(x.created_at),
    pair: String(x.pair),
    side: x.side as "buy" | "sell",
    kind: x.kind as "entry" | "exit",
    reason: String(x.reason),
    strategy_version: String(x.strategy_version ?? "v1.0"),
    outcome: String(x.outcome ?? "pending"),
    outcome_reason: x.outcome_reason === null || x.outcome_reason === undefined ? null : String(x.outcome_reason),
    consumed: Boolean(x.consumed),
    consumed_at: x.consumed_at ? String(x.consumed_at) : null,
    ai_explanation: x.ai_explanation === null || x.ai_explanation === undefined ? null : String(x.ai_explanation),
    timeframe: x.timeframe === null || x.timeframe === undefined ? null : String(x.timeframe),
    sl_pct: x.sl_pct === null || x.sl_pct === undefined ? null : Number(x.sl_pct),
    tp_pct: x.tp_pct === null || x.tp_pct === undefined ? null : Number(x.tp_pct),
    risk_pct: x.risk_pct === null || x.risk_pct === undefined ? null : Number(x.risk_pct),
    proposed_by: x.proposed_by === null || x.proposed_by === undefined ? null : String(x.proposed_by),
    confidence: x.confidence === null || x.confidence === undefined ? null : String(x.confidence),
  };
}

// ── Nieuws-status (nieuws-agent / AI-agent → order-agent + dashboard) ────

export interface NewsAlert {
  id: number;
  created_at: string;
  level: "ok" | "caution" | "high" | "unknown";
  reason: string;
  source: string;
  valid_until: string;
}

export async function insertNewsAlert(a: {
  level: "ok" | "caution" | "high" | "unknown";
  reason: string;
  source: string;
  valid_until: string;
}): Promise<void> {
  const r = await fetch(`${URL_}/rest/v1/news_alerts`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(a),
  });
  if (!r.ok) throw new Error(`Supabase insertNewsAlert: HTTP ${r.status}`);
}

export async function latestNewsAlert(): Promise<NewsAlert | null> {
  const r = await fetch(
    `${URL_}/rest/v1/news_alerts?select=*&order=created_at.desc&limit=1`,
    { headers: headers(), cache: "no-store" }
  );
  if (!r.ok) throw new Error(`Supabase latestNewsAlert: HTTP ${r.status}`);
  const rows = (await r.json()) ?? [];
  if (!rows.length) return null;
  const x = rows[0];
  return {
    id: Number(x.id),
    created_at: String(x.created_at),
    level: x.level as NewsAlert["level"],
    reason: String(x.reason),
    source: String(x.source ?? ""),
    valid_until: String(x.valid_until),
  };
}

// ── AI-run logging (kosten-inzicht) ─────────────────────────────────────

export async function insertAgentRun(r: {
  model: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  cost_usd_est: number;
  proposals: number;
  error: string | null;
}): Promise<void> {
  const res = await fetch(`${URL_}/rest/v1/agent_runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(r),
  });
  if (!res.ok) throw new Error(`Supabase insertAgentRun: HTTP ${res.status}`);
}

/** Laatste AI-run (voor throttling). */
export async function lastAgentRun(): Promise<{ created_at: string; error: string | null } | null> {
  const r = await fetch(
    `${URL_}/rest/v1/agent_runs?select=created_at,error&order=created_at.desc&limit=1`,
    { headers: headers(), cache: "no-store" }
  );
  if (!r.ok) throw new Error(`Supabase lastAgentRun: HTTP ${r.status}`);
  const rows = (await r.json()) ?? [];
  if (!rows.length) return null;
  return { created_at: String(rows[0].created_at), error: rows[0].error === null ? null : String(rows[0].error) };
}

/** AI-statistieken van de laatste 24 uur (dashboard). */
export async function aiStats24h(): Promise<{
  calls: number; errors: number; proposals: number; costUsd: number;
} | null> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const r = await fetch(
    `${URL_}/rest/v1/agent_runs?select=calls:count,input_tokens,cache_read_tokens,output_tokens,cost_usd_est,proposals,error&created_at=gte.${since}`,
    { headers: headers(), cache: "no-store" }
  );
  if (!r.ok) return null; // tabel nog niet aanwezig → dashboard zonder stats
  const rows = (await r.json()) ?? [];
  if (!rows.length) return { calls: 0, errors: 0, proposals: 0, costUsd: 0 };
  let calls = 0, errors = 0, proposals = 0, costUsd = 0;
  for (const x of rows) {
    calls += 1;
    if (x.error) errors += 1;
    proposals += Number(x.proposals ?? 0);
    costUsd += Number(x.cost_usd_est ?? 0);
  }
  return { calls, errors, proposals, costUsd };
}
