// ── Paper-trading-engine: één "tick" van de bot (alle coins) ────────────
// Dit eindpunt wordt elke 5 minuten door de cron-wekker aangeroepen.
// Per coin: verse candles → risicoregels → signaal → opslaan.
//
// ÉÉN POT: alle cash zit in één aparte database-rij (pair = "__POT__").
// De coin-rijen bewaren alleen hun open positie. Elke trade betaalt uit
// dezelfde pot en brengt de opbrengst er ook in terug. Per trade geldt:
// max 1% risico van de totale pot, max 25% van de pot per positie, en
// samen max 98% van de kas. De daglimiet (-3%) geldt voor de hele pot.
//
// LONG-ONLY: shorts staan er wel in (allowShorts-vlag) maar zijn standaard
// UIT — data van 9 sep 2026: 40-44% winrate, verlies op elk venster.
//
// PAPER-LIVE (optioneel): met PAPER_LIVE=blofin spiegelt elke entry en
// exit als market-order naar het Blofin demo-account (1x, cross,
// virtueel geld). Fouten daar breken de interne simulatie nooit.
//
// Beveiliging: ?token=<PAPER_TOKEN>. Nog steeds géén echt geld — fase 3
// start pas na een goed verlopen fase 2.

import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/exchange/marketdata";
import { PAIRS } from "@/lib/exchange/pairs";
import {
  DEFAULT_PARAMS, prepare, longSignal, exitLongSignal,
  shortSignal, exitShortSignal,
} from "@/lib/strategy";
import { getStates, initState, saveState, insertOrder, POT_PAIR, PaperState } from "@/lib/paper/store";
import {
  blofinLive, BLOFIN_INST, setLeverage1x, contractsFor, marketLong, marketShort, closePosition,
} from "@/lib/exchange/blofin";

export const dynamic = "force-dynamic";

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
  action: "open" | "open_short" | "close",
  pair: string,
  coinSize: number,
  actions: string[]
): Promise<void> {
  if (!blofinLive) return;
  const instId = BLOFIN_INST[pair];
  if (!instId) return;
  try {
    if (action === "open" || action === "open_short") {
      const contracts = await contractsFor(instId, coinSize);
      if (contracts <= 0) {
        actions.push(`blofin: skipped — ${coinSize.toPrecision(3)} te klein voor minimale ordergrootte`);
        return;
      }
      await setLeverage1x(instId);
      if (action === "open") {
        const orderId = await marketLong(instId, contracts);
        actions.push(`blofin demo: LONG ${contracts} contracts ${instId} geplaatst (order ${orderId.slice(-6)})`);
      } else {
        const orderId = await marketShort(instId, contracts);
        actions.push(`blofin demo: SHORT ${contracts} contracts ${instId} geplaatst (order ${orderId.slice(-6)})`);
      }
    } else {
      const orderId = await closePosition(instId);
      if (orderId) actions.push(`blofin demo: positie ${instId} gesloten (order ${orderId.slice(-6)})`);
      else actions.push(`blofin demo: geen open positie ${instId} om te sluiten`);
    }
  } catch (e) {
    actions.push(`blofin demo FOUT: ${String(e instanceof Error ? e.message : e)}`);
  }
}

const freshState = (pair: string): PaperState => ({
  pair, status: "flat", cash: 0, entry_price: null, entry_time: null,
  size: null, cost: null, day: null, day_start_equity: 0, halted: false,
});

async function tick(p: typeof DEFAULT_PARAMS) {
  const slip = p.slippagePct / 100;
  const fee = p.feePct / 100;

  // ── rijen laden + de ENE pot-rij garanderen ─────────────────────────
  let rows = await getStates();

  // pot-rij bestaat nog niet? → migreer: alle losse kasjes samenvoegen
  if (!rows.some((r) => r.pair === POT_PAIR)) {
    const migrateCash = rows.filter((r) => (PAIRS as readonly string[]).includes(r.pair))
      .reduce((a, r) => a + r.cash, 0);
    const potCash = migrateCash > 0 ? migrateCash : 1000;
    await initState(POT_PAIR, potCash, potCash);
    for (const r of rows) {
      if ((PAIRS as readonly string[]).includes(r.pair) && r.cash !== 0) {
        r.cash = 0;
        await saveState(r);
      }
    }
    rows = await getStates();
  }

  const pot = rows.find((r) => r.pair === POT_PAIR)!;
  const states: PaperState[] = [];
  for (const pair of PAIRS) {
    let s = rows.find((r) => r.pair === pair);
    if (!s) s = await initState(pair, 0); // nieuwe coin: positie-rij (cash zit in de pot)
    states.push(s);
  }

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

  const posValue = (s: PaperState) => {
    if (!s.size || !s.entry_price || !priceOf[s.pair]) return 0;
    if (s.status === "long") return s.size * priceOf[s.pair];
    if (s.status === "short") return s.size * (2 * s.entry_price - priceOf[s.pair]);
    return 0;
  };
  // totale pot = kas in de pot-rij + waarde van alle open posities
  const totalEquity = () => pot.cash + states.reduce((a, s) => a + posValue(s), 0);

  // ── nieuwe dag? → daglimiet verversen (op de pot) ────────────────────
  if (pot.day !== today) {
    pot.day = today;
    pot.day_start_equity = totalEquity();
    pot.halted = false;
  }

  const results: Record<string, unknown>[] = [];
  const feedActions: string[] = [];

  // ── stap 1: open posities beheren ───────────────────────────────────
  for (const s of states) {
    const actions: string[] = [];
    const price = priceOf[s.pair];
    if ((s.status === "long" || s.status === "short") && s.entry_price && s.size && s.cost) {
      const candles = candlesByPair[s.pair];
      const closedIdx = candles.length - 2; // laatst gesloten candle
      const sgn = prepare(candles, p);
      const isLong = s.status === "long";
      const stop = s.entry_price * (isLong ? 1 - p.slPct / 100 : 1 + p.slPct / 100);
      const target = s.entry_price * (isLong ? 1 + p.tpPct / 100 : 1 - p.tpPct / 100);
      let exitPrice: number;
      let reason = "signaal";
      if (isLong ? price <= stop : price >= stop) { exitPrice = stop * (isLong ? 1 - slip : 1 + slip); reason = "stop-loss"; }
      else if (isLong ? price >= target : price <= target) { exitPrice = target * (isLong ? 1 - slip : 1 + slip); reason = "take-profit"; }
      else if (isLong ? exitLongSignal(sgn, candles, closedIdx, p) : exitShortSignal(sgn, candles, closedIdx, p)) {
        exitPrice = price * (isLong ? 1 - slip : 1 + slip); reason = "signaal";
      } else if (s.entry_time && Date.now() - Date.parse(s.entry_time) >= p.maxHoldBars * 15 * 60 * 1000) {
        exitPrice = price * (isLong ? 1 - slip : 1 + slip); reason = "max-houdtijd";
      } else exitPrice = 0;

      if (exitPrice) {
        const proceeds = isLong
          ? exitPrice * s.size * (1 - fee)
          : s.entry_price * s.size + (s.entry_price - exitPrice) * s.size - exitPrice * s.size * fee;
        const pnl = proceeds - s.cost;
        pot.cash += proceeds; // opbrengst terug in de pot
        const closedSize = s.size;
        const closedCost = s.cost;
        s.status = "flat"; s.entry_price = null; s.entry_time = null; s.size = null; s.cost = null;
        await insertOrder({
          pair: s.pair, side: isLong ? "sell" : "buy", price: exitPrice, size: closedSize, reason,
          equity_after: totalEquity(), pnl_eur: pnl, pnl_pct: (pnl / closedCost) * 100,
        });
        actions.push(`${isLong ? "LONG" : "SHORT"} GESLOTEN (${reason}): ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} EUR`);
        await mirrorBlofin("close", s.pair, closedSize, actions);
        feedActions.push(`${s.pair}: ${actions[actions.length - 1]}`);
      }
    }
    results.push({
      pair: s.pair, price,
      status: pot.halted ? "gepauzeerd (daglimiet)" : s.status,
      position: posValue(s) > 0 ? { size: s.size, entry: s.entry_price, value: posValue(s) } : null,
      actions,
    });
  }

  // ── stap 2: daglimiet check (op de pot) ─────────────────────────────
  const eqNow = totalEquity();
  const dayStart = pot.day_start_equity || eqNow;
  if (dayStart > 0 && eqNow / dayStart - 1 <= -p.dailyLossLimitPct / 100) {
    for (const s of states) {
      if ((s.status === "long" || s.status === "short") && s.size && s.entry_price && s.cost) {
        const price = priceOf[s.pair];
        const isLong = s.status === "long";
        const proceeds = isLong
          ? price * (1 - slip) * s.size * (1 - fee)
          : s.entry_price * s.size + (s.entry_price - price * (1 + slip)) * s.size - price * (1 + slip) * s.size * fee;
        const pnl = proceeds - s.cost;
        pot.cash += proceeds;
        const closedSize = s.size;
        await insertOrder({
          pair: s.pair, side: isLong ? "sell" : "buy", price: price * (isLong ? 1 - slip : 1 + slip),
          size: closedSize, reason: "daglimiet", equity_after: 0,
          pnl_eur: pnl, pnl_pct: (pnl / s.cost) * 100,
        });
        s.status = "flat"; s.entry_price = null; s.entry_time = null; s.size = null; s.cost = null;
        await mirrorBlofin("close", s.pair, closedSize, feedActions);
        feedActions.push(`${s.pair}: gesloten wegens DAGLIMIET (${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} EUR)`);
      }
    }
    pot.halted = true;
    feedActions.push(`⚠ DAGLIMIET GERAKT — bot staat vandaag pauze`);
  }

  // ── stap 3: nieuwe entries (betaald uit de ENE pot) ─────────────────
  const openCosts = states.reduce((a, s) => a + (s.cost ?? 0), 0);
  for (const s of states) {
    if (s.status !== "flat" || pot.halted) continue;
    const candles = candlesByPair[s.pair];
    const closedIdx = candles.length - 2;
    const sgn = prepare(candles, p);
    const price = priceOf[s.pair];
    const goLong = longSignal(sgn, candles, closedIdx, p);
    const goShort = p.allowShorts && shortSignal(sgn, candles, closedIdx, p);
    if (!goLong && !goShort) continue;

    const isLong = !!goLong;
    const entry = price * (1 + (isLong ? slip : -slip));
    const eq = totalEquity();
    const riskAmount = (eq * p.riskPerTrade) / 100;
    let size = riskAmount / (entry * (p.slPct / 100));
    // cap: max 25% van de pot per trade, samen max 98% van de kas
    const capNotional = Math.min(pot.cash * 0.25, (pot.cash - openCosts) * 0.98);
    size = Math.min(size, capNotional / entry);
    const cost = entry * size * (1 + fee);
    const potAfter = totalEquity() - cost;
    if (size <= 0 || cost <= 0 || potAfter <= 0) continue;

    pot.cash -= cost; // betaald uit de gedeelde pot
    s.status = isLong ? "long" : "short";
    s.entry_price = entry; s.entry_time = new Date().toISOString();
    s.size = size; s.cost = cost;
    await insertOrder({
      pair: s.pair, side: isLong ? "buy" : "sell", price: entry, size,
      reason: isLong ? "long: RSI-dip + stijgende trend" : "short: RSI-pomp + dalende trend",
      equity_after: totalEquity(), pnl_eur: null, pnl_pct: null,
    });
    const acts: string[] = [];
    await mirrorBlofin(isLong ? "open" : "open_short", s.pair, size, acts);
    const r = results.find((x) => x.pair === s.pair) as Record<string, unknown>;
    r.actions = [...((r.actions as string[]) ?? []), `${isLong ? "LONG" : "SHORT"} ${size.toFixed(6)} @ ${entry.toFixed(2)} EUR`, ...acts];
    r.status = isLong ? "long" : "short";
    feedActions.push(`${s.pair}: ${isLong ? "LONG" : "SHORT"} ${size.toFixed(6)} @ ${entry.toFixed(2)} EUR${acts.length ? ` · ${acts[0]}` : ""}`);
  }

  // ── opslaan: alle positie-rijen + de pot-rij ──────────────────────────
  await Promise.all([...states.map((s) => saveState(s)), saveState(pot)]);
  return { pot: totalEquity(), pairs: results, actions: feedActions };
}
