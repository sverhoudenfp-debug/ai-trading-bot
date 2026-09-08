// ── Paper-trading-engine: één "tick" van de bot (alle coins) ────────────
// Dit eindpunt wordt elke 5 minuten door de cron-wekker aangeroepen.
// Per coin: verse candles → risicoregels → signaal (long/short) → opslaan.
// Elke coin heeft zijn eigen virtuele potje van €1000.
//
// Beveiliging: ?token=<PAPER_TOKEN>. Nog steeds géén echt geld — fase 3
// start pas na een goed verlopen fase 2.

import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/exchange/marketdata";
import { PAIRS } from "@/lib/exchange/pairs";
import { DEFAULT_PARAMS, prepare, longSignal, shortSignal, exitLongSignal, exitShortSignal } from "@/lib/strategy";
import { getState, initState, saveState, insertOrder } from "@/lib/paper/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!process.env.PAPER_TOKEN || token !== process.env.PAPER_TOKEN) {
    return NextResponse.json({ error: "onbevoegd — token vereist" }, { status: 401 });
  }
  const p = DEFAULT_PARAMS;
  const results: Record<string, unknown>[] = [];

  for (const pair of PAIRS) {
    try {
      results.push(await tickPair(pair, p));
    } catch (e) {
      results.push({ pair, error: String(e instanceof Error ? e.message : e) });
    }
  }
  return NextResponse.json({ ok: true, pairs: results });
}

export async function POST(req: NextRequest) {
  return GET(req);
}

async function tickPair(pair: string, p: typeof DEFAULT_PARAMS) {
  const candles = await fetchCandles(pair, 15, 45);
  if (candles.length < 300) throw new Error("te weinig candledata");

  const lastIdx = candles.length - 1;
  const closedIdx = lastIdx - 1; // laatst gesloten candle → signalen
  const price = candles[lastIdx].c; // huidige koers
  const today = new Date(candles[lastIdx].t * 1000).toISOString().slice(0, 10);

  let s = (await getState(pair)) ?? (await initState(pair));
  const actions: string[] = [];

  const posValue =
    s.status === "long" && s.size
      ? s.size * price
      : s.status === "short" && s.size && s.entry_price
      ? s.size * (2 * s.entry_price - price)
      : 0;
  let equity = s.cash + posValue;

  // Nieuwe dag? → daglimiet verversen
  if (s.day !== today) {
    s.day = today;
    s.day_start_equity = equity;
    s.halted = false;
  }

  const sgn = prepare(candles, p);
  const slip = p.slippagePct / 100;
  const fee = p.feePct / 100;

  // ── Open positie beheren ────────────────────────────────────────────
  if (s.status !== "flat" && s.entry_price && s.size && s.cost) {
    let sellPrice: number | null = null;
    let reason = "";
    let exitPrice: number;

    if (s.status === "long") {
      const stop = s.entry_price * (1 - p.slPct / 100);
      const target = s.entry_price * (1 + p.tpPct / 100);
      if (price <= stop) { exitPrice = stop * (1 - slip); reason = "stop-loss"; }
      else if (price >= target) { exitPrice = target * (1 - slip); reason = "take-profit"; }
      else if (exitLongSignal(sgn, candles, closedIdx, p)) { exitPrice = price * (1 - slip); reason = "signaal"; }
      else if (s.entry_time && Date.now() - Date.parse(s.entry_time) >= p.maxHoldBars * 15 * 60 * 1000) {
        exitPrice = price * (1 - slip); reason = "max-houdtijd";
      } else if (equity / s.day_start_equity - 1 <= -p.dailyLossLimitPct / 100) {
        exitPrice = price * (1 - slip); reason = "daglimiet";
      } else exitPrice = 0;
      if (exitPrice) {
        const proceeds = exitPrice * s.size * (1 - fee);
        const pnl = proceeds - s.cost;
        s.cash += proceeds; equity = s.cash;
        if (reason === "daglimiet") s.halted = true;
        await insertOrder({ pair, side: "sell", price: exitPrice, size: s.size, reason, equity_after: equity,
          pnl_eur: pnl, pnl_pct: (pnl / s.cost) * 100 });
        actions.push(`LONG GESLOTEN (${reason}): ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} EUR`);
        s.status = "flat"; s.entry_price = null; s.entry_time = null; s.size = null; s.cost = null;
        sellPrice = exitPrice; // marker
      }
    } else {
      const stop = s.entry_price * (1 + p.slPct / 100);
      const target = s.entry_price * (1 - p.tpPct / 100);
      if (price >= stop) { exitPrice = stop * (1 + slip); reason = "stop-loss"; }
      else if (price <= target) { exitPrice = target * (1 + slip); reason = "take-profit"; }
      else if (exitShortSignal(sgn, candles, closedIdx, p)) { exitPrice = price * (1 + slip); reason = "signaal"; }
      else if (s.entry_time && Date.now() - Date.parse(s.entry_time) >= p.maxHoldBars * 15 * 60 * 1000) {
        exitPrice = price * (1 + slip); reason = "max-houdtijd";
      } else if (equity / s.day_start_equity - 1 <= -p.dailyLossLimitPct / 100) {
        exitPrice = price * (1 + slip); reason = "daglimiet";
      } else exitPrice = 0;
      if (exitPrice) {
        const entryFee = s.cost - s.entry_price * s.size;
        const pnl = (s.entry_price - exitPrice) * s.size - exitPrice * s.size * fee - entryFee;
        s.cash += s.entry_price * s.size + (s.entry_price - exitPrice) * s.size - exitPrice * s.size * fee;
        equity = s.cash;
        if (reason === "daglimiet") s.halted = true;
        await insertOrder({ pair, side: "buy", price: exitPrice, size: s.size, reason: `short gesloten (${reason})`,
          equity_after: equity, pnl_eur: pnl, pnl_pct: (pnl / s.cost) * 100 });
        actions.push(`SHORT GESLOTEN (${reason}): ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} EUR`);
        s.status = "flat"; s.entry_price = null; s.entry_time = null; s.size = null; s.cost = null;
        sellPrice = exitPrice; // marker
      }
    }
    void sellPrice;
  }

  // ── Nieuwe entry? (long of short) ──────────────────────────────────
  if (s.status === "flat" && !s.halted) {
    const goLong = longSignal(sgn, candles, closedIdx, p);
    const goShort = shortSignal(sgn, candles, closedIdx, p);
    if (goLong || goShort) {
      const entry = goLong ? price * (1 + slip) : price * (1 - slip);
      const riskAmount = (equity * p.riskPerTrade) / 100;
      let size = riskAmount / (entry * (p.slPct / 100));
      size = Math.min(size, (s.cash * 0.99) / entry);
      const cost = entry * size * (1 + fee);
      if (size > 0 && cost <= s.cash * 0.999) {
        s.cash -= cost;
        s.status = goLong ? "long" : "short";
        s.entry_price = entry; s.entry_time = new Date().toISOString();
        s.size = size; s.cost = cost;
        equity = s.cash + (goLong ? size * price : size * (2 * entry - price));
        await insertOrder({ pair, side: goLong ? "buy" : "sell", price: entry, size,
          reason: goLong ? "long: RSI-dip + stijgende trend" : "short: RSI-pomp + dalende trend",
          equity_after: equity, pnl_eur: null, pnl_pct: null });
        actions.push(`${goLong ? "LONG" : "SHORT"} ${size.toFixed(6)} @ ${entry.toFixed(2)} EUR`);
      }
    }
  }

  await saveState(s);
  return {
    pair, price, equity,
    status: s.halted ? "gepauzeerd (daglimiet)" : s.status,
    actions,
  };
}
