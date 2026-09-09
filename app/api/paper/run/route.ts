// ── Paper-trading-engine: één "tick" van de bot (alle coins) ────────────
// Dit eindpunt wordt elke 5 minuten door de cron-wekker aangeroepen.
// Per coin: verse candles → risicoregels → signaal → opslaan.
//
// ÉÉN GEDEELDE POT: alle 4 de coins handelen samen uit één virtuele pot
// van €1000 (i.p.v. 4 losse potjes). De pot = som van alle cash-rijen +
// de waarde van open posities. Per positie geldt: max 1% risico van de
// totale pot, max 25% van de pot aan inleg per trade, en samen max 98%.
//
// LONG-ONLY: de short-tak is verwijderd — backtests (sep 2026) lieten
// zien dat shorts in beide testvensters kapitaal vernietigden.
//
// PAPER-LIVE (optioneel): met PAPER_LIVE=blofin spiegelt elke long-entry
// en -exit als market-order naar het Blofin demo-account (1x, cross,
// virtueel geld). Fouten daar breken de interne simulatie nooit.
//
// Beveiliging: ?token=<PAPER_TOKEN>. Nog steeds géén echt geld — fase 3
// start pas na een goed verlopen fase 2.

import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/exchange/marketdata";
import { PAIRS } from "@/lib/exchange/pairs";
import { DEFAULT_PARAMS, prepare, longSignal, exitLongSignal } from "@/lib/strategy";
import { getStates, initState, saveState, insertOrder } from "@/lib/paper/store";
import {
  blofinLive, BLOFIN_INST, setLeverage1x, contractsFor, marketLong, closePosition,
} from "@/lib/exchange/blofin";

export const dynamic = "force-dynamic";

interface TickState {
  pair: string;
  status: "flat" | "long";
  cash: number;
  entry_price: number | null;
  entry_time: string | null;
  size: number | null;
  cost: number | null;
  day: string | null;
  day_start_equity: number;
  halted: boolean;
  updated_at?: string | null;
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!process.env.PAPER_TOKEN || token !== process.env.PAPER_TOKEN) {
    return NextResponse.json({ error: "onbevoegd — token vereist" }, { status: 401 });
  }
  const p = DEFAULT_PARAMS;
  try {
    const out = await tick(p);
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}

async function mirrorBlofin(
  action: "open" | "close",
  pair: string,
  coinSize: number,
  actions: string[]
): Promise<void> {
  if (!blofinLive) return;
  const instId = BLOFIN_INST[pair];
  if (!instId) return;
  try {
    if (action === "open") {
      const contracts = await contractsFor(instId, coinSize);
      if (contracts <= 0) {
        actions.push(`blofin: skipped — ${coinSize.toPrecision(3)} te klein voor minimale ordergrootte`);
        return;
      }
      await setLeverage1x(instId);
      const orderId = await marketLong(instId, contracts);
      actions.push(`blofin demo: LONG ${contracts} contracts ${instId} geplaatst (order ${orderId.slice(-6)})`);
    } else {
      const orderId = await closePosition(instId);
      if (orderId) actions.push(`blofin demo: positie ${instId} gesloten (order ${orderId.slice(-6)})`);
      else actions.push(`blofin demo: geen open positie ${instId} om te sluiten`);
    }
  } catch (e) {
    actions.push(`blofin demo FOUT: ${String(e instanceof Error ? e.message : e)}`);
  }
}

async function tick(p: typeof DEFAULT_PARAMS) {
  const slip = p.slippagePct / 100;
  const fee = p.feePct / 100;

  // ── states laden (init bij eerste run) ─────────────────────────────
  let rows = await getStates();
  if (!rows.length) {
    for (const pair of PAIRS) await initState(pair);
    rows = await getStates();
  }
  const states: TickState[] = PAIRS.map(
    (pair) =>
      (rows.find((r) => r.pair === pair) as TickState | undefined) ?? {
        pair, status: "flat", cash: 0, entry_price: null, entry_time: null,
        size: null, cost: null, day: null, day_start_equity: 0, halted: false,
      }
  );

  // ── verse candles + koersen ─────────────────────────────────────────
  const candlesByPair: Record<string, Awaited<ReturnType<typeof fetchCandles>>> = {};
  for (const pair of PAIRS) candlesByPair[pair] = await fetchCandles(pair, 15, 45);
  const priceOf: Record<string, number> = {};
  for (const pair of PAIRS) {
    const cs = candlesByPair[pair];
    if (cs.length < 300) throw new Error(`te weinig candledata voor ${pair}`);
    priceOf[pair] = cs[cs.length - 1].c;
  }
  const today = new Date().toISOString().slice(0, 10);

  const posValue = (s: TickState) =>
    s.status === "long" && s.size && priceOf[s.pair] ? s.size * priceOf[s.pair] : 0;
  const totalEquity = () => states.reduce((a, s) => a + s.cash + posValue(s), 0);

  // ── nieuwe dag? → daglimiet verversen (globale pot als ijkpunt) ─────
  if (states.some((s) => s.day !== today)) {
    const eq = totalEquity();
    for (const s of states) { s.day = today; s.day_start_equity = eq; s.halted = false; }
  }

  const results: Record<string, unknown>[] = [];
  const feedActions: string[] = [];

  // ── stap 1: open posities beheren (long-only) ───────────────────────
  for (const s of states) {
    const actions: string[] = [];
    const price = priceOf[s.pair];
    if (s.status === "long" && s.entry_price && s.size && s.cost) {
      const candles = candlesByPair[s.pair];
      const closedIdx = candles.length - 2; // laatst gesloten candle
      const sgn = prepare(candles, p);
      const stop = s.entry_price * (1 - p.slPct / 100);
      const target = s.entry_price * (1 + p.tpPct / 100);
      let exitPrice: number;
      let reason = "signaal";
      if (price <= stop) { exitPrice = stop * (1 - slip); reason = "stop-loss"; }
      else if (price >= target) { exitPrice = target * (1 - slip); reason = "take-profit"; }
      else if (exitLongSignal(sgn, candles, closedIdx, p)) { exitPrice = price * (1 - slip); reason = "signaal"; }
      else if (s.entry_time && Date.now() - Date.parse(s.entry_time) >= p.maxHoldBars * 15 * 60 * 1000) {
        exitPrice = price * (1 - slip); reason = "max-houdtijd";
      } else exitPrice = 0;

      if (exitPrice) {
        const proceeds = exitPrice * s.size * (1 - fee);
        const pnl = proceeds - s.cost;
        s.cash += proceeds;
        const closedSize = s.size;
        const closedCost = s.cost;
        s.status = "flat"; s.entry_price = null; s.entry_time = null; s.size = null; s.cost = null;
        await insertOrder({
          pair: s.pair, side: "sell", price: exitPrice, size: closedSize, reason,
          equity_after: totalEquity(), pnl_eur: pnl, pnl_pct: (pnl / closedCost) * 100,
        });
        actions.push(`LONG GESLOTEN (${reason}): ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} EUR`);
        await mirrorBlofin("close", s.pair, closedSize, actions);
        feedActions.push(`${s.pair}: ${actions[actions.length - 1]}`);
      }
    }
    results.push({
      pair: s.pair, price,
      status: s.halted ? "gepauzeerd (daglimiet)" : s.status,
      position: posValue(s) > 0 ? { size: s.size, entry: s.entry_price, value: posValue(s) } : null,
      actions,
    });
  }

  // ── stap 2: daglimiet check (globale pot) ───────────────────────────
  const eqNow = totalEquity();
  const dayStart = states[0].day_start_equity || eqNow;
  if (dayStart > 0 && eqNow / dayStart - 1 <= -p.dailyLossLimitPct / 100) {
    for (const s of states) {
      if (s.status === "long" && s.size && s.entry_price && s.cost) {
        const price = priceOf[s.pair];
        const proceeds = price * (1 - slip) * s.size * (1 - fee);
        const pnl = proceeds - s.cost;
        s.cash += proceeds;
        const closedSize = s.size;
        await insertOrder({
          pair: s.pair, side: "sell", price: price * (1 - slip), size: closedSize,
          reason: "daglimiet", equity_after: 0, pnl_eur: pnl, pnl_pct: (pnl / s.cost) * 100,
        });
        s.status = "flat"; s.entry_price = null; s.entry_time = null; s.size = null; s.cost = null;
        const acts: string[] = [];
        await mirrorBlofin("close", s.pair, closedSize, acts);
        feedActions.push(`${s.pair}: gesloten wegens DAGLIMIET (${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} EUR)`);
      }
      s.halted = true;
    }
    feedActions.push(`⚠ DAGLIMIET GERAKT — bot staat vandaag pauze`);
  }

  // ── stap 3: nieuwe entries (uit de gedeelde pot) ────────────────────
  const openCosts = states.reduce((a, s) => a + (s.cost ?? 0), 0);
  const totalCash = states.reduce((a, s) => a + s.cash, 0);
  for (const s of states) {
    if (s.status !== "flat" || s.halted) continue;
    const candles = candlesByPair[s.pair];
    const closedIdx = candles.length - 2;
    const sgn = prepare(candles, p);
    const price = priceOf[s.pair];
    if (!longSignal(sgn, candles, closedIdx, p)) continue;

    const entry = price * (1 + slip);
    const eq = totalEquity();
    const riskAmount = (eq * p.riskPerTrade) / 100;
    let size = riskAmount / (entry * (p.slPct / 100));
    // cap: max 25% van de pot per trade, samen max 98% van de cash
    const capNotional = Math.min(totalCash * 0.25, (totalCash - openCosts) * 0.98);
    size = Math.min(size, capNotional / entry);
    const cost = entry * size * (1 + fee);
    // De kas is gezamenlijk: deze rij mag negatief zolang de pot als
    // geheel ruim positief blijft (cap hierboven bewaakt dat al).
    const potAfter = totalEquity() - cost;
    if (size > 0 && cost > 0 && potAfter > 0) {
      s.cash -= cost;
      s.status = "long";
      s.entry_price = entry; s.entry_time = new Date().toISOString();
      s.size = size; s.cost = cost;
      await insertOrder({
        pair: s.pair, side: "buy", price: entry, size,
        reason: "long: RSI-dip + stijgende trend",
        equity_after: totalEquity(), pnl_eur: null, pnl_pct: null,
      });
      const acts: string[] = [];
      await mirrorBlofin("open", s.pair, size, acts);
      const r = results.find((x) => x.pair === s.pair) as Record<string, unknown>;
      r.actions = [...((r.actions as string[]) ?? []), `LONG ${size.toFixed(6)} @ ${entry.toFixed(2)} EUR`, ...acts];
      r.status = "long";
      feedActions.push(`${s.pair}: LONG ${size.toFixed(6)} @ ${entry.toFixed(2)} EUR${acts.length ? ` · ${acts[0]}` : ""}`);
    }
  }

  await Promise.all(states.map((s) => saveState(s as never)));
  return { pot: totalEquity(), pairs: results, actions: feedActions };
}
