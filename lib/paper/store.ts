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

// De gedeelde kas leeft in één aparte rij met pair = POT_PAIR.
// De coin-rijen bewaren alleen hun positie; alle cash zit in de pot.
export const POT_PAIR = "__POT__";

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
  updated_at?: string | null; // laatste bot-tick (cron-levensbewijs)
  // AI-agent: per positie geldende stop-loss/take-profit + gebruikte strategie
  sl_pct?: number | null;
  tp_pct?: number | null;
  strategy?: string | null;
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
  strategy?: string | null;      // welke strategie de trade aangaf
  ai_explanation?: string | null; // korte AI-onderbouwing
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
    updated_at: s.updated_at ? String(s.updated_at) : null,
    sl_pct: s.sl_pct === null || s.sl_pct === undefined ? null : Number(s.sl_pct),
    tp_pct: s.tp_pct === null || s.tp_pct === undefined ? null : Number(s.tp_pct),
    strategy: s.strategy === null || s.strategy === undefined ? null : String(s.strategy),
  }));
}

export async function getState(pair: string): Promise<PaperState | null> {
  const rows = await getStates();
  return rows.find((r) => r.pair === pair) ?? null;
}

export async function initState(pair: string, cash = 1000, dayStartEquity = cash): Promise<PaperState> {
  const fresh: PaperState = {
    pair, status: "flat", cash, entry_price: null, entry_time: null,
    size: null, cost: null, day: null, day_start_equity: dayStartEquity, halted: false,
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

export async function insertOrder(o: PaperOrderExt): Promise<void> {
  const ext = {
    ...(o.timeframe !== undefined ? { timeframe: o.timeframe } : {}),
    ...(o.confidence !== undefined ? { confidence: o.confidence } : {}),
    ...(o.context !== undefined && o.context !== null ? { context: o.context } : {}),
  };
  // Eerst mét de Fase 1-velden (timeframe/confidence/context). Bestaan die
  // kolommen nog niet (migration nog niet gedraaid), dan valt de insert
  // netjes terug op de klassieke velden — de bot verliest géén orders.
  const r = await fetch(`${URL_}/rest/v1/paper_orders`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ ...o, ...ext }),
  });
  if (!r.ok && Object.keys(ext).length) {
    const r2 = await fetch(`${URL_}/rest/v1/paper_orders`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ ...o, timeframe: undefined, confidence: undefined, context: undefined }),
    });
    if (!r2.ok) throw new Error(`Supabase insertOrder: HTTP ${r2.status}`);
    return;
  }
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
    strategy: x.strategy === null || x.strategy === undefined ? null : String(x.strategy),
    ai_explanation: x.ai_explanation === null || x.ai_explanation === undefined ? null : String(x.ai_explanation),
  }));
}

// ═════════════════ FASE 1-TOEVOEGINGEN ═════════════════════════════════

// ── kolom-beschikbaarheid detecteren (graceful vóór de migration) ──────
// Nieuwe jsonb-kolommen bestaan pas nadat supabase-phase1-setup.sql is
// gedraaid. Detecteer één keer per proces of ze er zijn; zo werkt de bot
// ook vóór de migration (zonder snapshots, met logging).
const columnCache = new Map<string, boolean>();
export async function tableHasColumn(table: string, column: string): Promise<boolean> {
  const key = `${table}.${column}`;
  if (columnCache.has(key)) return columnCache.get(key)!;
  try {
    const r = await fetch(`${URL_}/rest/v1/${table}?select=${column}&limit=1`, {
      headers: headers(), cache: "no-store",
    });
    const ok = r.ok; // 400 = kolom bestaat (nog) niet
    columnCache.set(key, ok);
    return ok;
  } catch {
    columnCache.set(key, false);
    return false;
  }
}

// ── PaperOrder-uitbreiding: snapshot + fee-uitsplitsing ────────────────
// context (jsonb) bevat: indicator-snapshot bij entry, en bij exit de
// uitsplitsing gross/fees/slippage/net — de kolom bestaat pas na de
// phase1-migration; insertOrder degradeert netjes zonder.
export interface PaperOrderExt extends PaperOrder {
  timeframe?: string | null;
  confidence?: string | null;
  context?: Record<string, unknown> | null;
}

// ── volledige orderhistorie sinds een tijdstip (GEEN stille afkap) ─────
// Fase 1-fix: performance/leer-queries pakten vroeger af bij een vaste
// limit (100/500) — daarmee "laatste 14 dagen" stiekem "laatste ~500
// orders". Nu: echte paginering over de volledige periode.
export async function listOrdersSince(sinceIso: string, maxPages = 100): Promise<PaperOrderExt[]> {
  const out: PaperOrderExt[] = [];
  const limit = 1000;
  for (let page = 0; page < maxPages; page++) {
    const r = await fetch(
      `${URL_}/rest/v1/paper_orders?created_at=gte.${encodeURIComponent(sinceIso)}&order=created_at.asc&limit=${limit}&offset=${page * limit}`,
      { headers: headers(), cache: "no-store" }
    );
    if (!r.ok) throw new Error(`Supabase listOrdersSince: HTTP ${r.status}`);
    const rows = (await r.json()) ?? [];
    for (const x of rows) {
      out.push({
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
        strategy: x.strategy === null || x.strategy === undefined ? null : String(x.strategy),
        ai_explanation: x.ai_explanation === null || x.ai_explanation === undefined ? null : String(x.ai_explanation),
        timeframe: x.timeframe === null || x.timeframe === undefined ? null : String(x.timeframe),
        confidence: x.confidence === null || x.confidence === undefined ? null : String(x.confidence),
        context: (x.context ?? null) as Record<string, unknown> | null,
      });
    }
    if (rows.length < limit) break; // klaar
  }
  return out;
}


// ── ATOMAIRE RUN-LOCK (concurrentie-bescherming) ───────────────────────
// Twee gelijktijdige cron-runs zijn de bron van dubbele orders. We claimen
// de pot-rij atoom via een conditional PATCH: alleen als entry_time < nu
// wordt entry_time op de toekomst (TTL) gezet. De DB serialiseert de
// UPDATE — de tweede run krijgt 0 rijen terug en stopt.
// De pot-rij gebruikt entry_time nooit voor iets anders (de pot heeft geen
// positie), dus dit veld is hier veilig te gebruiken als lock-veld.
// saveState(pot) aan het eind van de run zet entry_time terug op null →
// lock automatisch vrij. Bij een crash loopt de TTL af (zelfherstellend).
const LOCK_ROW = "1970-01-01T00:00:00+00:00";
export async function claimRunLock(ttlMin = 5): Promise<boolean> {
  const now = Date.now();
  const until = new Date(now + ttlMin * 60_000).toISOString();
  // 1. éénmalige initialisatie als het veld nog null is (idempotent, veilig)
  await fetch(`${URL_}/rest/v1/paper_state?pair=eq.${encodeURIComponent(POT_PAIR)}&entry_time=is.null`, {
    method: "PATCH",
    headers: headers({ Prefer: "return=minimal" }),
    body: JSON.stringify({ entry_time: LOCK_ROW }),
  }).catch(() => undefined);
  // 2. atomaire claim: alleen slagen als entry_time < nu
  const r = await fetch(
    `${URL_}/rest/v1/paper_state?pair=eq.${encodeURIComponent(POT_PAIR)}&entry_time=lt.${encodeURIComponent(new Date(now).toISOString())}`,
    {
      method: "PATCH",
      headers: headers({ Prefer: "return=representation" }),
      body: JSON.stringify({ entry_time: until }),
    }
  );
  if (!r.ok) return true; // lock-tabel niet beschikbaar → liever blijven draaien (risk-guards blijven actief)
  const rows = (await r.json()) ?? [];
  return Array.isArray(rows) && rows.length > 0;
}
