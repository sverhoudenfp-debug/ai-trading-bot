// ── Agent-database: signalen, nieuws-status en strategie-versies ────────
// De drie agents (nieuws, analyse, orders) praten NIET direct met elkaar:
// ze lezen en schrijven elkaars status via deze tabellen in Supabase.
// Zelfde REST-stijl als lib/paper/store.ts (service_role, server-side only).

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

// ── Signaal (analyse-agent → order-agent) ──────────────────────────────

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
}

export async function insertSignal(sig: {
  pair: string;
  side: "buy" | "sell";
  kind: "entry" | "exit";
  reason: string;
  strategy_version: string;
}): Promise<void> {
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

/** Onverbruikte signalen van de afgelopen `min` minuten (voor dedup in de analyse-agent). */
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
export async function markSignal(
  id: number,
  outcome: string,
  outcomeReason: string
): Promise<void> {
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

/** Laatste N signalen voor het dashboard (incl. uitkomst). */
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
  };
}

// ── Nieuws-status (nieuws-agent → order-agent) ─────────────────────────

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
