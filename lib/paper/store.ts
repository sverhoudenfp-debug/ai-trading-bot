// ── Supabase-opslag voor paper trading (multi-coin) ────────────────────
// Eén rij per coin in paper_state, orderhistorie in paper_orders.
// We praten direct met de REST-API van Supabase met de service_role key
// (server-side only — nooit naar de browser sturen).

const URL_ = process.env.SUPABASE_URL ?? "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export const supabaseConfigured = Boolean(URL_ && KEY);

function headers(extra?: Record<string, string>) {
  return {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

export interface PaperState {
  pair: string;
  status: "flat" | "long" | "short";
  cash: number;
  entry_price: number | null;
  entry_time: string | null; // ISO
  size: number | null;
  cost: number | null;
  day: string | null; // YYYY-MM-DD (UTC)
  day_start_equity: number;
  halted: boolean;
}

export interface PaperOrder {
  id?: number;
  created_at?: string;
  pair: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  reason: string;
  equity_after: number;
  pnl_eur: number | null;
  pnl_pct: number | null;
}

export async function getStates(): Promise<PaperState[]> {
  const r = await fetch(`${URL_}/rest/v1/paper_state?select=*`, { headers: headers(), cache: "no-store" });
  if (!r.ok) throw new Error(`Supabase paper_state: HTTP ${r.status}`);
  const rows = await r.json();
  return (rows ?? []).map((s: Record<string, unknown>) => ({
    pair: String(s.pair),
    status: s.status as PaperState["status"],
    cash: Number(s.cash),
    entry_price: s.entry_price === null ? null : Number(s.entry_price),
    entry_time: s.entry_time === null ? null : String(s.entry_time),
    size: s.size === null ? null : Number(s.size),
    cost: s.cost === null ? null : Number(s.cost),
    day: s.day === null ? null : String(s.day),
    day_start_equity: Number(s.day_start_equity),
    halted: Boolean(s.halted),
  }));
}

export async function getState(pair: string): Promise<PaperState | null> {
  const rows = await getStates();
  return rows.find((r) => r.pair === pair) ?? null;
}

export async function initState(pair: string): Promise<PaperState> {
  const fresh: PaperState = {
    pair, status: "flat", cash: 1000, entry_price: null, entry_time: null,
    size: null, cost: null, day: null, day_start_equity: 1000, halted: false,
  };
  const r = await fetch(`${URL_}/rest/v1/paper_state`, {
    method: "POST",
    headers: headers({ Prefer: "resolution=merge-duplicates" }),
    body: JSON.stringify(fresh),
  });
  if (!r.ok) throw new Error(`Supabase initState: HTTP ${r.status}`);
  return fresh;
}

export async function saveState(s: PaperState): Promise<void> {
  const r = await fetch(`${URL_}/rest/v1/paper_state?pair=eq.${encodeURIComponent(s.pair)}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ ...s, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`Supabase saveState: HTTP ${r.status}`);
}

export async function insertOrder(o: PaperOrder): Promise<void> {
  const r = await fetch(`${URL_}/rest/v1/paper_orders`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(o),
  });
  if (!r.ok) throw new Error(`Supabase insertOrder: HTTP ${r.status}`);
}

export async function listOrders(limit = 50): Promise<PaperOrder[]> {
  const r = await fetch(
    `${URL_}/rest/v1/paper_orders?order=created_at.desc&limit=${limit}`,
    { headers: headers(), cache: "no-store" }
  );
  if (!r.ok) throw new Error(`Supabase listOrders: HTTP ${r.status}`);
  const rows = await r.json();
  return (rows ?? []).map((x: Record<string, unknown>) => ({
    id: Number(x.id),
    created_at: String(x.created_at),
    pair: String(x.pair),
    side: x.side as "buy" | "sell",
    price: Number(x.price),
    size: Number(x.size),
    reason: String(x.reason),
    equity_after: Number(x.equity_after),
    pnl_eur: x.pnl_eur === null ? null : Number(x.pnl_eur),
    pnl_pct: x.pnl_pct === null ? null : Number(x.pnl_pct),
  }));
}
