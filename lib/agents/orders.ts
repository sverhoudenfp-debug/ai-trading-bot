// ── ORDER-AGENT ──────────────────────────────────────────────────────────
// Leest bij elke cron-tick de laatste signalen van de analyse-agent (tabel
// trade_signals) en de laatste risico-status van de nieuws-agent (tabel
// news_alerts). Plaatst een order alléén als:
//   • de analyse-agent een kans ziet, ÉN
//   • de nieuws-agent geen verhoogd risico (level 'high') aangeeft.
// Exits (stop-loss, take-profit, max-houdtijd, daglimiet) worden nooit door
// het nieuws geblokkeerd — risicobeheer gaat altijd voor.
// Verder ongewijzigd: één pot van €1000, max 1% risico per trade, max 25%
// per positie, −3% daglimiet, spiegelen naar het Blofin demo-account.
// Als een signaal wordt geblokkeerd of overgeslagen, wordt dat mét reden
// bij het signaal gelogd (zichtbaar op het dashboard).
//
// dry=true → alles doorrekenen maar niets uitvoeren/wegschrijven (testmodus).

import { fetchCandles } from "@/lib/exchange/marketdata";
import { PAIRS } from "@/lib/exchange/pairs";
import { DEFAULT_PARAMS } from "@/lib/strategy";
import {
  getStates, initState, saveState, insertOrder, POT_PAIR, PaperState,
} from "@/lib/paper/store";
import {
  blofinLive, BLOFIN_INST, setLeverage1x, contractsFor, marketLong, marketShort, closePosition,
} from "@/lib/exchange/blofin";
import { freshUnconsumedSignals, markSignal, TradeSignal } from "./db";
import { currentNewsStatus } from "./news";
import {
  AI_RISK_MIN_PCT, AI_RISK_MAX_PCT, AI_DAY_LIMIT_PCT,
  AI_SL_MIN_PCT, AI_SL_MAX_PCT, AI_TP_MIN_PCT, AI_TP_MAX_PCT, AI_MAX_COST_PCT,
} from "./config";

// ── VEILIGHEIDS-LAAGJE (pure code, geen AI) ─────────────────────────────
// Keurt elk AI-voorstel vóór uitvoering: geldige coin/kant, SL/TP binnen
// de vaste grenzen, risico 5-10% van de pot. Voldoet het voorstel niet →
// blokkeren + loggen met reden. Regel-signalen vallen hier niet onder
// (die komen uit de gekeurde eigen strategie met 1% risico).
export function validateAiProposal(sig: TradeSignal):
  | { ok: true; sl: number; tp: number; risk: number }
  | { ok: false; reason: string } {
  const sl = sig.sl_pct ?? 0;
  const tp = sig.tp_pct ?? 0;
  const risk = sig.risk_pct ?? 0;
  if (!(sl >= AI_SL_MIN_PCT && sl <= AI_SL_MAX_PCT))
    return { ok: false, reason: `stop-loss ${sl}% buiten toegestane ${AI_SL_MIN_PCT}-${AI_SL_MAX_PCT}%` };
  if (!(tp >= AI_TP_MIN_PCT && tp <= AI_TP_MAX_PCT))
    return { ok: false, reason: `take-profit ${tp}% buiten toegestane ${AI_TP_MIN_PCT}-${AI_TP_MAX_PCT}%` };
  if (!(risk >= AI_RISK_MIN_PCT && risk <= AI_RISK_MAX_PCT))
    return { ok: false, reason: `risico ${risk}% buiten toegestane ${AI_RISK_MIN_PCT}-${AI_RISK_MAX_PCT}%` };
  if (!sig.ai_explanation)
    return { ok: false, reason: "geen onderbouwing meegegeven" };
  return { ok: true, sl, tp, risk };
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
      actions.push(orderId
        ? `blofin demo: positie ${instId} gesloten (order ${orderId.slice(-6)})`
        : `blofin demo: geen open positie ${instId} om te sluiten`);
    }
  } catch (e) {
    actions.push(`blofin demo FOUT: ${String(e instanceof Error ? e.message : e)}`);
  }
}

/**
 * De order-agent: één tick. Verwerkt exit-signalen, risico-exits, daglimiet
 * en (mits nieuws-status oké) entry-signalen. Response-vorm is bewust
 * gelijk aan de oude /api/paper/run-tick: { pot, pairs, actions }.
 */
export async function orderAgent(dry = false): Promise<{
  pot: number;
  pairs: Record<string, unknown>[];
  actions: string[];
  news: { level: string; reason: string; fresh: boolean };
  signalsProcessed: Record<string, unknown>[];
}> {
  const p = DEFAULT_PARAMS;
  const slip = p.slippagePct / 100;
  const fee = p.feePct / 100;

  // ── rijen laden + de ENE pot-rij garanderen (idempotente migratie) ──
  let rows = await getStates();
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
    if (!s) s = await initState(pair, 0);
    states.push(s);
  }

  // ── verse candles + koersen (net als eerst: zelfde bron, zelfde check) ──
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
  const totalEquity = () => pot.cash + states.reduce((a, s) => a + posValue(s), 0);

  // ── nieuwe dag? → daglimiet verversen (op de pot) ──────────────────────
  if (pot.day !== today) {
    pot.day = today;
    pot.day_start_equity = totalEquity();
    pot.halted = false;
  }

  // ── statussen van de andere agents lezen (via de database) ────────────
  const news = await currentNewsStatus();
  let signals: TradeSignal[] = [];
  let signalsTableOk = true;
  try {
    signals = await freshUnconsumedSignals(3); // alleen signalen ≤ 3 min oud
  } catch {
    signalsTableOk = false; // tabel er nog niet → geen nieuwe entries, risico blijft
  }
  const sigByPair = (kind: "entry" | "exit", pair: string) =>
    signals.find((s) => s.pair === pair && s.kind === kind);

  const results: Record<string, unknown>[] = [];
  const feedActions: string[] = [];
  const signalsProcessed: Record<string, unknown>[] = [];
  const mark = async (sig: TradeSignal | undefined, outcome: string, outcomeReason: string) => {
    if (!sig) return;
    signalsProcessed.push({ id: sig.id, pair: sig.pair, kind: sig.kind, side: sig.side, reason: sig.reason, outcome, outcome_reason: outcomeReason });
    if (!dry) await markSignal(sig.id, outcome, outcomeReason);
  };

  if (!signalsTableOk) {
    feedActions.push("⚠ trade_signals-tabel niet beschikbaar — geen nieuwe entries (exits blijven werken)");
  }

  // ── stap 1: open posities beheren (risico-exits + slimme exit-signalen) ─
  for (const s of states) {
    const actions: string[] = [];
    const price = priceOf[s.pair];
    if ((s.status === "long" || s.status === "short") && s.entry_price && s.size && s.cost) {
      const isLong = s.status === "long";
      const posSl = s.sl_pct ?? p.slPct;   // AI-posities: door AI voorgestelde SL
      const posTp = s.tp_pct ?? p.tpPct;   // (oude posities: standaardwaarden)
      const stop = s.entry_price * (isLong ? 1 - posSl / 100 : 1 + posSl / 100);
      const target = s.entry_price * (isLong ? 1 + posTp / 100 : 1 - posTp / 100);
      let exitPrice = 0;
      let reason = "signaal";
      if (isLong ? price <= stop : price >= stop) { exitPrice = stop * (isLong ? 1 - slip : 1 + slip); reason = "stop-loss"; }
      else if (isLong ? price >= target : price <= target) { exitPrice = target * (isLong ? 1 - slip : 1 + slip); reason = "take-profit"; }
      else if (sigByPair("exit", s.pair) && sigByPair("exit", s.pair)!.created_at > new Date(Date.now() - 3 * 60_000).toISOString()) {
        exitPrice = price * (isLong ? 1 - slip : 1 + slip); reason = "signaal"; // signaal van de analyse-agent
        if (!dry) await markSignal(sigByPair("exit", s.pair)!.id, "executed", "exit uitgevoerd");
      }
      else if (s.entry_time && Date.now() - Date.parse(s.entry_time) >= p.maxHoldBars * 15 * 60 * 1000) {
        exitPrice = price * (isLong ? 1 - slip : 1 + slip); reason = "max-houdtijd";
      }

      if (exitPrice && !dry) {
        const proceeds = isLong
          ? exitPrice * s.size * (1 - fee)
          : s.entry_price * s.size + (s.entry_price - exitPrice) * s.size - exitPrice * s.size * fee;
        const pnl = proceeds - s.cost;
        pot.cash += proceeds;
        const closedSize = s.size;
        const closedCost = s.cost;
        const closedStrategy = s.strategy ?? null;
        s.status = "flat"; s.entry_price = null; s.entry_time = null; s.size = null; s.cost = null;
        s.sl_pct = null; s.tp_pct = null; s.strategy = null;
        await insertOrder({
          pair: s.pair, side: isLong ? "sell" : "buy", price: exitPrice, size: closedSize, reason,
          equity_after: totalEquity(), pnl_eur: pnl, pnl_pct: (pnl / closedCost) * 100,
          strategy: closedStrategy, ai_explanation: null,
        });
        actions.push(`${isLong ? "LONG" : "SHORT"} GESLOTEN (${reason}): ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} EUR`);
        await mirrorBlofin("close", s.pair, closedSize, actions);
        feedActions.push(`${s.pair}: ${actions[actions.length - 1]}`);
      } else if (exitPrice && dry) {
        actions.push(`[DRY] zou sluiten (${reason}) @ ${exitPrice.toFixed(2)}`);
      }
    }
    results.push({
      pair: s.pair, price,
      status: pot.halted ? "gepauzeerd (daglimiet)" : s.status,
      position: posValue(s) > 0 ? { size: s.size, entry: s.entry_price, value: posValue(s) } : null,
      actions,
    });
  }

  // ── stap 2: daglimiet check (op de pot) — identiek aan eerst ──────────
  const eqNow = totalEquity();
  const dayStart = pot.day_start_equity || eqNow;
  // daglimiet sinds 9 sep 2026: -15% van de pot (was -3%), passend bij
  // 5-10% risico per AI-trade — vangt 2 volle verlies-trades op rij op.
  if (dayStart > 0 && eqNow / dayStart - 1 <= -AI_DAY_LIMIT_PCT / 100) {
    if (!dry) {
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
          s.sl_pct = null; s.tp_pct = null; s.strategy = null;
          await mirrorBlofin("close", s.pair, closedSize, feedActions);
          feedActions.push(`${s.pair}: gesloten wegens DAGLIMIET (${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} EUR)`);
        }
      }
      pot.halted = true;
      feedActions.push(`⚠ DAGLIMIET GERAKT — bot staat vandaag pauze`);
    } else {
      feedActions.push(`[DRY] daglimiet zou raken — alles zou sluiten`);
    }
  }

  // ── stap 3: entry-signalen van de analyse-agent verwerken ────────────
  const openCosts = states.reduce((a, s) => a + (s.cost ?? 0), 0);
  for (const s of states) {
    const sig = sigByPair("entry", s.pair);
    if (!sig) continue; // geen signaal voor deze coin
    const isLong = sig.side === "buy";

    // geen signaal verwerken als de coin al een positie heeft of bot gepauzeerd is
    if (s.status !== "flat" || pot.halted) {
      await mark(sig, "skipped", pot.halted ? "bot gepauzeerd (daglimiet)" : "positie al open");
      continue;
    }

    // NIEUWS-POORT: analyse zag een kans, maar nieuws-agent zag risico?
    if (news.level === "high") {
      await mark(sig, "blocked_news", `nieuws-risico: ${news.reason}`);
      feedActions.push(`⚠ ${s.pair}: ${isLong ? "LONG" : "SHORT"}-signaal NIET uitgevoerd — nieuws-risico (${news.reason})`);
      const r = results.find((x) => x.pair === s.pair) as Record<string, unknown>;
      r.actions = [...((r.actions as string[]) ?? []), `signaal geblokkeerd: nieuws-risico`];
      continue;
    }

    // ── VEILIGHEIDS-LAAGJE: AI-voorstellen eerst keuren (pure code) ────
    const isAi = (sig.proposed_by ?? "rule") === "ai";
    let slPct = p.slPct;
    let tpPct = p.tpPct;
    let riskPct = p.riskPerTrade;
    if (isAi) {
      const check = validateAiProposal(sig);
      if (!check.ok) {
        await mark(sig, "blocked_risk", `AI-voorstel afgewezen door risicocheck: ${check.reason}`);
        feedActions.push(`⛔ ${s.pair}: AI-voorstel afgewezen door risicocheck — ${check.reason}`);
        const rb = results.find((x) => x.pair === s.pair) as Record<string, unknown>;
        rb.actions = [...((rb.actions as string[]) ?? []), `AI-voorstel afgewezen: ${check.reason}`];
        continue;
      }
      slPct = check.sl; tpPct = check.tp; riskPct = check.risk;
    }

    // ── positionering ──────────────────────────────────────────────────
    const price = priceOf[s.pair];
    const entry = price * (1 + (isLong ? slip : -slip));
    const eq = totalEquity();
    const riskAmount = (eq * riskPct) / 100;
    let size = riskAmount / (entry * (slPct / 100));
    // regel-signalen: max 25% van de pot · AI: max 95% van de kas
    const costCapPct = isAi ? AI_MAX_COST_PCT / 100 : 0.25;
    const capNotional = Math.min(pot.cash * costCapPct, (pot.cash - openCosts) * 0.98);
    size = Math.min(size, capNotional / entry);
    const cost = entry * size * (1 + fee);
    const potAfter = totalEquity() - cost;
    if (size <= 0 || cost <= 0 || potAfter <= 0) {
      await mark(sig, "skipped", "pot te klein voor minimale positie");
      continue;
    }

    if (dry) {
      signalsProcessed.push({ id: sig.id, pair: s.pair, kind: "entry", side: sig.side, reason: sig.reason, outcome: "preview", outcome_reason: ` zou ${isLong ? "LONG" : "SHORT"} ${size.toFixed(6)} @ ${entry.toFixed(2)} EUR` });
      feedActions.push(`[DRY] ${s.pair}: zou ${isLong ? "LONG" : "SHORT"} ${size.toFixed(6)} @ ${entry.toFixed(2)} EUR`);
      continue;
    }

    pot.cash -= cost;
    s.status = isLong ? "long" : "short";
    s.entry_price = entry; s.entry_time = new Date().toISOString();
    s.size = size; s.cost = cost;
    s.sl_pct = slPct; s.tp_pct = tpPct; s.strategy = sig.strategy_version;
    await insertOrder({
      pair: s.pair, side: isLong ? "buy" : "sell", price: entry, size,
      reason: sig.reason,
      equity_after: totalEquity(), pnl_eur: null, pnl_pct: null,
      strategy: sig.strategy_version, ai_explanation: sig.ai_explanation ?? null,
    });
    const acts: string[] = [];
    await mirrorBlofin(isLong ? "open" : "open_short", s.pair, size, acts);
    await mark(sig, "executed", `order geplaatst: ${size.toFixed(6)} @ ${entry.toFixed(2)}`);
    const r = results.find((x) => x.pair === s.pair) as Record<string, unknown>;
    r.actions = [...((r.actions as string[]) ?? []), `${isLong ? "LONG" : "SHORT"} ${size.toFixed(6)} @ ${entry.toFixed(2)} EUR`, ...acts];
    r.status = isLong ? "long" : "short";
    feedActions.push(`${s.pair}: ${isLong ? "LONG" : "SHORT"} ${size.toFixed(6)} @ ${entry.toFixed(2)} EUR${acts.length ? ` · ${acts[0]}` : ""}`);
  }

  // ── stap 4: overgebleven (niet-verbruikte) signalen laten verlopen ────
  if (!dry) {
    for (const sig of signals) {
      if (signalsProcessed.some((x) => Number(x.id) === sig.id)) continue;
      await markSignal(sig.id, "expired", "signaal niet tijdig verwerkt");
      signalsProcessed.push({ id: sig.id, pair: sig.pair, kind: sig.kind, side: sig.side, reason: sig.reason, outcome: "expired", outcome_reason: "signaal niet tijdig verwerkt" });
    }
  }

  // ── opslaan: alle positie-rijen + de pot-rij ────────────────────────────
  if (!dry) await Promise.all([...states.map((s) => saveState(s)), saveState(pot)]);
  return { pot: totalEquity(), pairs: results, actions: feedActions, news, signalsProcessed };
}
