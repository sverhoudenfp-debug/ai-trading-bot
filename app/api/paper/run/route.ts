// ── Paper-trading-engine: één "tick" van de bot ─────────────────────────
// Dit eindpunt wordt elke 5 minuten door de cron-wekker aangeroepen
// (cron-job.org). Per aanroep:
//   1. verse candles ophalen bij Bitvavo (incl. de nu-vormende candle als
//      "actuele koers")
//   2. status laden uit Supabase (positie, kas, daglimiet)
//   3. risicoregels controleren op de open positie (SL/TP/signaal/houdtijd)
//   4. koopsignaal checken op de laatst GESLOTEN candle
//   5. alles opslaan — de bot "onthoud" zo zijn positie tussen aanroepen door
//
// Beveiliging: ?token=<PAPER_TOKEN> — de token staat als environment variable
// in Vercel en in de cron-job-URL. Zonder juiste token: 401.
//
// NOG ALTIJD GEEN ECHT GELD: alle orders zijn gesimuleerd. Dat verandert pas
// in fase 3 (en alleen na een goed verlopen fase 2).

import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/exchange/marketdata";
import { DEFAULT_PARAMS, prepare, longSignal, exitSignal } from "@/lib/strategy";
import { getState, initState, saveState, insertOrder } from "@/lib/paper/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!process.env.PAPER_TOKEN || token !== process.env.PAPER_TOKEN) {
    return NextResponse.json({ error: "onbevoegd — token vereist" }, { status: 401 });
  }
  return runTick();
}

export async function POST(req: NextRequest) {
  return GET(req);
}

async function runTick() {
  try {
    const p = DEFAULT_PARAMS;
    const candles = await fetchCandles("BTC-EUR", 15, 45);
    if (candles.length < 300) throw new Error("te weinig candledata");

    const lastIdx = candles.length - 1;
    const closedIdx = lastIdx - 1; // laatst gesloten candle → signalen
    const price = candles[lastIdx].c; // huidige koers
    const today = new Date(candles[lastIdx].t * 1000).toISOString().slice(0, 10);

    let s = (await getState()) ?? (await initState());
    const actions: string[] = [];

    // Nieuwe dag? → daglimiet-limiet verversen
    let equity = s.cash + (s.status === "long" && s.size ? s.size * price : 0);
    if (s.day !== today) {
      s.day = today;
      s.day_start_equity = equity;
      s.halted = false;
    }

    const sgn = prepare(candles, p);

    // ── Open positie beheren ──────────────────────────────────────────
    if (s.status === "long" && s.entry_price && s.size && s.cost) {
      const stop = s.entry_price * (1 - p.slPct / 100);
      const target = s.entry_price * (1 + p.tpPct / 100);
      const slip = p.slippagePct / 100;
      const fee = p.feePct / 100;
      let sellPrice: number | null = null;
      let reason = "";

      if (price <= stop) { sellPrice = stop * (1 - slip); reason = "stop-loss"; }
      else if (price >= target) { sellPrice = target * (1 - slip); reason = "take-profit"; }
      else if (exitSignal(sgn, candles, closedIdx, p)) { sellPrice = price * (1 - slip); reason = "signaal"; }
      else if (s.entry_time && Date.now() - Date.parse(s.entry_time) >= p.maxHoldBars * 15 * 60 * 1000) {
        sellPrice = price * (1 - slip); reason = "max-houdtijd";
      } else if (equity / s.day_start_equity - 1 <= -p.dailyLossLimitPct / 100) {
        sellPrice = price * (1 - slip); reason = "daglimiet";
      }

      if (sellPrice !== null) {
        const proceeds = sellPrice * s.size * (1 - fee);
        const pnl = proceeds - s.cost;
        s.cash += proceeds;
        equity = s.cash;
        if (reason === "daglimiet") s.halted = true;
        await insertOrder({
          side: "sell", price: sellPrice, size: s.size, reason,
          equity_after: equity, pnl_eur: pnl, pnl_pct: (pnl / s.cost) * 100,
        });
        actions.push(`VERKOCHT (${reason}): ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} EUR`);
        s.status = "flat"; s.entry_price = null; s.entry_time = null;
        s.size = null; s.cost = null;
      }
    }

    // ── Nieuwe koop? ──────────────────────────────────────────────────
    if (s.status === "flat" && !s.halted) {
      if (longSignal(sgn, candles, closedIdx, p)) {
        const slip = p.slippagePct / 100;
        const fee = p.feePct / 100;
        const entry = price * (1 + slip);
        const riskAmount = (equity * p.riskPerTrade) / 100;
        let size = riskAmount / (entry * (p.slPct / 100));
        size = Math.min(size, (s.cash * 0.99) / entry);
        const cost = entry * size * (1 + fee);
        if (size > 0 && cost <= s.cash * 0.999) {
          s.cash -= cost;
          s.status = "long"; s.entry_price = entry; s.entry_time = new Date().toISOString();
          s.size = size; s.cost = cost;
          equity = s.cash + size * price;
          await insertOrder({
            side: "buy", price: entry, size, reason: "koopsignaal (RSI-dip + trend)",
            equity_after: equity, pnl_eur: null, pnl_pct: null,
          });
          actions.push(`GEKOCHT ${size.toFixed(6)} BTC @ ${entry.toFixed(0)} EUR`);
        }
      }
    }

    await saveState(s);
    return NextResponse.json({
      ok: true, price, equity,
      status: s.halted ? "gepauzeerd (daglimiet)" : s.status,
      halted: s.halted, day: s.day, actions,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
