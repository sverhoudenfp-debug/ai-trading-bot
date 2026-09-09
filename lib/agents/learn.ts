// ── Zelflerende laag: dagelijkse strategie-gewichten ───────────────────
// De AI kiest per situatie een strategie; DEZE laag leert van de resultaten.
//
// Leer-principes (SNEL maar veilig tegen ruis/overfitting):
//  1. Dagelijkse cyclus (i.p.v. wekelijks) — aangeroepen door de
//     order-agent, die elke minuut draait; de eerste tick na middernacht
//     UTC start een nieuwe leronde.
//  2. Sliding window van 14 dagen — oude resultanten verwateren vanzelf.
//  3. Laplace-smoothing: (winst + 2) / (trades + 4) — met weinig trades
//     blijft de winrate dicht bij 50%, dus wordt er niet over gereageerd.
//  4. Strategieën met < MIN_TRADES trades krijgen géén nieuw gewicht:
//     nog niks geleerd → neutraal (1.0).
//  5. Gewichten bewegen max ±0.15 per dag richting hun doel (0.5 + winrate)
//     en blijven binnen [0.5, 1.6]. Slechte strategie wordt dus nooit
//     verboden, alleen ontmoedigd — de AI kan een top-setup nog steeds doen.
//  6. De vaste risicobanden (SL/TP/pot-limieten, veiligheidslaag) raken
//     NIET aan: leren = sturen, niet remmen op bescherming.

import { listOrders } from "@/lib/paper/store";

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

const WINDOW_DAYS = 14;   // resultaten venster
const MIN_TRADES = 5;     // minder → nog neutraal
const MAX_STEP = 0.15;    // max verandering per dag
const W_MIN = 0.5;
const W_MAX = 1.6;

export interface StrategyWeights { [strategy: string]: number }

export interface LearnResult {
  version: string;
  weights: StrategyWeights;
  stats: { strategy: string; trades: number; wins: number; winrate: number; weight: number }[];
  note: string;
}

// ── huidige actieve gewichten lezen (fallback: alles 1.0) ──────────────
export async function getActiveWeights(): Promise<LearnResult | null> {
  if (!URL_ || !KEY) return null;
  const r = await fetch(
    `${URL_}/rest/v1/strategy_versions?select=version,created_at,params,note&status=eq.active&order=created_at.desc&limit=1`,
    { headers: headers(), cache: "no-store" }
  );
  if (!r.ok) return null; // tabel er nog niet → neutraal
  const rows = (await r.json()) ?? [];
  if (!rows.length) return null;
  const row = rows[0] as { version: string; created_at: string; params: { weights?: StrategyWeights } | null; note: string | null };
  return {
    version: row.version,
    weights: row.params?.weights ?? {},
    stats: [],
    note: row.note ?? "",
  };
}

// ── één leronde: prestaties per strategie → nieuwe gewichten ───────────
async function learnCycle(): Promise<LearnResult> {
  const version = `learn-${new Date().toISOString().slice(0, 10)}`;

  // gesloten trades uit het venster ophalen
  const since = Date.now() - WINDOW_DAYS * 24 * 3600_000;
  const orders = await listOrders(500);
  const closed = orders.filter(
    (o) =>
      o.pnl_eur !== null &&
      !!o.strategy &&
      Date.parse(o.created_at ?? "") >= since
  );

  // per strategie: trades, winst, gemiddelde pnl
  const by = new Map<string, { trades: number; wins: number; pnl: number }>();
  for (const o of closed) {
    const st = String(o.strategy);
    const v = by.get(st) ?? { trades: 0, wins: 0, pnl: 0 };
    v.trades += 1;
    if ((o.pnl_eur ?? 0) >= 0) v.wins += 1;
    v.pnl += o.pnl_eur ?? 0;
    by.set(st, v);
  }

  // huidige gewichten als startpunt
  const current = (await getActiveWeights())?.weights ?? {};

  const stats: LearnResult["stats"] = [];
  const weights: StrategyWeights = { ...current };
  for (const [strategy, v] of by) {
    if (v.trades < MIN_TRADES) {
      weights[strategy] = clamp(current[strategy] ?? 1, W_MIN, W_MAX);
      stats.push({ strategy, trades: v.trades, wins: v.wins, winrate: v.wins / v.trades, weight: weights[strategy] });
      continue;
    }
    // Laplace-gegladde winrate: weinig trades → dicht bij 0,5
    const winrateSmooth = (v.wins + 2) / (v.trades + 4);
    // doel: 0.5 + winrate → range ~[0.75 .. 1.5] voor winrates 25%..100%
    const target = 0.5 + winrateSmooth;
    const cur = current[strategy] ?? 1;
    const step = Math.max(-MAX_STEP, Math.min(MAX_STEP, target - cur));
    weights[strategy] = clamp(cur + step, W_MIN, W_MAX);
    stats.push({ strategy, trades: v.trades, wins: v.wins, winrate: v.wins / v.trades, weight: weights[strategy] });
  }
  // strategieën zonder nieuwe data houden hun huidige gewicht

  const note =
    stats.length
      ? stats
          .map((s) => `${s.strategy}: ${s.wins}/${s.trades} win (${Math.round(s.winrate * 100)}%) → ×${s.weight.toFixed(2)}`)
          .join(" · ")
      : "nog te weinig gesloten trades in het 14-daagse venster — gewichten ongewijzigd";

  // vorige actieve versie degraderen en nieuwe activeren
  const patch = await fetch(
    `${URL_}/rest/v1/strategy_versions?status=eq.active&version=neq.${version}`,
    { method: "PATCH", headers: headers({ Prefer: "return=minimal" }), body: JSON.stringify({ status: "rolled_back" }) }
  );
  if (!patch.ok) throw new Error(`Supabase learnCycle patch: HTTP ${patch.status}`);

  const post = await fetch(`${URL_}/rest/v1/strategy_versions`, {
    method: "POST",
    headers: headers({ Prefer: "return=minimal" }),
    body: JSON.stringify({
      version,
      params: { weights },
      status: "active",
      activated_at: new Date().toISOString(),
      note,
    }),
  });
  if (!post.ok) throw new Error(`Supabase learnCycle post: HTTP ${post.status}`);

  return { version, weights, stats, note };
}

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

// ── dagelijkse trigger: max één leronde per UTC-dag ────────────────────
// De order-agent draait elke minuut en roept dit; pas na middernacht UTC
// (en alleen als er vandaag nog geen leronde was) draait de cyclus echt.
export async function maybeLearn(): Promise<LearnResult | null> {
  if (!URL_ || !KEY) return null;
  const version = `learn-${new Date().toISOString().slice(0, 10)}`;
  const r = await fetch(
    `${URL_}/rest/v1/strategy_versions?select=id&version=eq.${version}&limit=1`,
    { headers: headers(), cache: "no-store" }
  );
  if (r.ok) {
    const rows = (await r.json()) ?? [];
    if (rows.length) return null; // vandaag al geleerd
  }
  return await learnCycle();
}
