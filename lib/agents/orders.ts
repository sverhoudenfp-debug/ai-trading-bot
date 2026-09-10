// ── ORDER-AGENT — FASE 1: hardening ─────────────────────────────────────
// De uitvoerende kracht van de bot. Leest signalen (trade_signals) + de
// nieuws-status (news_alerts), keurt elk voorstel door de RISK ENGINE
// (lib/risk/engine.ts) en voert pas daarna uit.
//
// Fase 1-wijzigingen (t.o.v. de vorige versie):
//   • ATOMAIRE RUN-LOCK (claimRunLock): gelijktijdige cron-runs zijn onmogelijk.
//   • ATOMAIRE SIGNAL-CLAIMS (claimSignal): elk signaal wordt exact 1× verwerkt.
//   • RISICO: 0,25–1,0% van de pot per trade (hard gecleand); notional cap
//     25% van equity; totaal open ≤ 50%; max 4 posities.
//   • FEE-GUARD: trades waarvan de TP de round-trip-kosten niet ruim dekt
//     worden geblokkeerd ('blocked_fee_edge') — de AI kan dat NIET overrulen.
//   • MIN-HOLD (15 min) op AI-exit-signalen; SL/TP/daglimiet/nieuws-high
//     blijven altijd toegestaan.
//   • COOLDOWN (10 min per pair na een exit) en FREQUENTIE-LIMIETEN
//     (2/pair/uur, 6/pair/dag, 8/uur, 20/dag).
//   • DAGLIMIET −5% (was −15%) + verlies-snelheids-guard (≥3 verliezen in
//     60 min → 60 min geen entries).
//   • HANDELDSDAG = Europe/Amsterdam (was UTC — resette om 02:00 lokale tijd).
//   • SNAPSHOTS: elke entry/exit krijgt een indicator-snapshot + bij exit
//     de uitsplitsing gross/fees/slippage/netto in de context-jsonb.
//   • BLOFIN-RECONCILIATION: elke tick paper-vs-demo vergeleken; extra
//     demo-positie wordt veilig gesloten, ontbrekende alleen gelogd.
//
// dry=true → alles doorrekenen maar niets uitvoeren/wegschrijven (testmodus).

import { maybeLearn } from "./learn";
import { fetchCandles } from "@/lib/exchange/marketdata";
import { PAIRS } from "@/lib/exchange/pairs";
import { DEFAULT_PARAMS } from "@/lib/strategy";
import { emaSeries, rsiSeries } from "@/lib/indicators";
import {
  getStates, initState, saveState, insertOrder, POT_PAIR, PaperState,
  claimRunLock, listOrdersSince, PaperOrderExt,
} from "@/lib/paper/store";
import {
  blofinLive, BLOFIN_INST, setLeverage1x, contractsFor, marketLong, marketShort, closePosition,
} from "@/lib/exchange/blofin";
import { runReconciliation } from "@/lib/exchange/reconcile";
import { freshUnconsumedSignals, markSignal, claimSignal, listSignalsSince, TradeSignal } from "./db";
import { currentNewsStatus } from "./news";
import {
  clampRiskPct, feeGuard, sizePosition, minHoldGuard, cooldownGuard,
  frequencyGuard, lossVelocityGuard, pnlBreakdown,
} from "@/lib/risk/engine";
import {
  RISK_MIN_PCT, RISK_MAX_PCT, DAILY_LOSS_LIMIT_DEFAULT_PCT, NEWS_FAIL_CLOSED,
  AI_SL_MIN_PCT, AI_SL_MAX_PCT, AI_TP_MIN_PCT, AI_TP_MAX_PCT,
  FEE_PCT, SLIPPAGE_PCT,
} from "@/lib/risk/config";
import { amsterdamDay } from "@/lib/time";
import { CANARY_RISK_CAP_PCT } from "@/lib/evolution/config";
import { ensureTodayLimit, shiftDayStatsFrom } from "@/lib/risk/dailyLimit";
import { evoStrategyStillActive } from "@/lib/evolution/live";
import { evolutionMonitorTick } from "@/lib/evolution/tick";
import { validationTick } from "@/lib/validation/tick";

const slip = SLIPPAGE_PCT / 100;
const fee = FEE_PCT / 100;

// ── VEILIGHEIDS-LAAG (pure code, geen AI) ─────────────────────────────
// Keurt elk AI-voorstel vóór uitvoering. Banden komen uit lib/risk/config.
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
  if (!(risk >= RISK_MIN_PCT && risk <= RISK_MAX_PCT))
    return { ok: false, reason: `risico ${risk}% buiten toegestane ${RISK_MIN_PCT}-${RISK_MAX_PCT}% (hard)` };
  if (!sig.ai_explanation)
    return { ok: false, reason: "geen onderbouwing meegegeven" };
  return { ok: true, sl, tp, risk: clampRiskPct(risk) };
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
    // een mirror-fout mag de paper-trade niet breken; de reconciliation
    // vangt de divergentie op en logt deze — nooit stilletjes verdwijnen
    actions.push(`blofin demo FOUT: ${String(e instanceof Error ? e.message : e)}`);
  }
}

// ── indicator-snapshot (voor de context-jsonb) ──────────────────────────
function contextSnapshot(candles: { c: number; h: number; l: number; v: number }[]): Record<string, unknown> {
  const closes = candles.map((c) => c.c);
  const rsi = rsiSeries(closes, 14);
  const ema50 = emaSeries(closes, 50);
  const ema200 = emaSeries(closes, 200);
  const i = closes.length - 1;
  const day = candles.slice(-96);
  return {
    rsi15: Math.round((rsi[i] ?? 50) * 10) / 10,
    above_ema200: closes[i] > (ema200[i] ?? closes[i]),
    dist_ema50_pct: Math.round(((closes[i] - (ema50[i] ?? closes[i])) / (ema50[i] ?? closes[i])) * 1000) / 10,
    day_hi: Math.max(...day.map((c) => c.h)),
    day_lo: Math.min(...day.map((c) => c.l)),
    vol24h: Math.round(day.reduce((a, c) => a + c.v, 0)),
  };
}

/**
 * De order-agent: één tick. runId identificeert deze uitvoering (logging +
 * atomaire claims). dry → niets wegschrijven.
 */
export async function orderAgent(dry = false, runId = "manual"): Promise<{
  ok: boolean;
  skipped?: string;
  pot: number;
  pairs: Record<string, unknown>[];
  actions: string[];
  news: { level: string; reason: string; fresh: boolean; stale?: boolean };
  signalsProcessed: Record<string, unknown>[];
  evolution?: { checked: number; rollbacks: { strategy: string; triggers: string[] }[]; warnings: { strategy: string; warnings: string[] }[]; errors: string[] } | null;
  learned: string | null;
  reconciliation?: { ok: boolean; mismatches: unknown[]; error?: string } | null;
  guards?: Record<string, unknown>;
}> {
  // ── 0. ATOMAIRE RUN-LOCK: één uitvoering tegelijk ─────────────────────
  if (!dry) {
    let locked = false;
    try { locked = await claimRunLock(5); } catch { locked = true; } // lock-fout → liever draaien; signal-claims blijven atomair
    if (!locked) {
      return {
        ok: false, skipped: "concurrent run actief (lock)", pot: 0, pairs: [], actions: [],
        news: { level: "unknown", reason: "n.v.t.", fresh: false }, signalsProcessed: [], learned: null,
      };
    }
  }

  // ── zelflerende laag: dagelijkse leronde (eerste tick na middernacht) ──
  let learned: string | null = null;
  if (!dry) {
    try {
      const r = await maybeLearn();
      if (r) learned = `${r.version}: ${r.note}`;
    } catch { /* leronde mag falen zonder gevolgen */ }
  }
  const p = DEFAULT_PARAMS;

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

  // ── verse candles per pair (één pair mag falen zonder hele tick te breken) ──
  const candlesByPair: Record<string, Awaited<ReturnType<typeof fetchCandles>>> = {};
  const priceOf: Record<string, number> = {};
  const unavailablePairs: string[] = [];
  for (const pair of PAIRS) {
    try {
      const cs = await fetchCandles(pair, 15, 45);
      if (cs.length < 300) throw new Error(`te weinig candledata (${cs.length})`);
      candlesByPair[pair] = cs;
      priceOf[pair] = cs[cs.length - 1].c;
    } catch (e) {
      unavailablePairs.push(pair);
      void e;
    }
  }
  if (Object.keys(priceOf).length === 0) {
    throw new Error("marktdata volledig onbeschikbaar — geen candledata voor één van de pairs");
  }

  // ── handelsdag = Europe/Amsterdam (Fase 1; was UTC) ────────────────────
  const today = amsterdamDay(new Date());

  const posValue = (s: PaperState) => {
    if (!s.size || !s.entry_price || !priceOf[s.pair]) return 0;
    if (s.status === "long") return s.size * priceOf[s.pair];
    if (s.status === "short") return s.size * (2 * s.entry_price - priceOf[s.pair]);
    return 0;
  };
  const totalEquity = () => pot.cash + states.reduce((a, s) => a + posValue(s), 0);

  // ── nieuwe handelsdag? → daglimiet verversen ──────────────────────────
  if (pot.day !== today) {
    pot.day = today;
    pot.day_start_equity = totalEquity();
    pot.halted = false;
  }

  // ── ADAPTIEF DAGLIMIET (circuit breaker; max ±1pp/dag, band −5…−15%) ──
  // Eén beslissing per handelsdag, persistent + audit in de DB; restart-safe.
  // Fail-closed: DB onbereikbaar → default (−10%) — de breaker valt nooit uit.
  // NOOIT: aanpassing van risk-per-trade / notional / exposure — dat is hier
  // bewust afwezig; dit is géén risicoknop maar een pauze-grens.
  let yesterdayStats: { closedTrades: number; netPnlEur: number; winratePct: number } | null = null;
  try {
    const yesterday = amsterdamDay(new Date(Date.now() - 24 * 3600_000));
    const orders48h = dry ? [] : await listOrdersSince(new Date(Date.now() - 48 * 3600_000).toISOString()).catch(() => [] as PaperOrderExt[]);
    yesterdayStats = shiftDayStatsFrom(orders48h, yesterday);
  } catch { /* stats optioneel — beslislogica heeft een null-pad */ }
  const dailyLimit = await ensureTodayLimit(today, pot.day_start_equity, yesterdayStats).catch(() => null);
  const DAILY_LOSS_LIMIT_PCT = dailyLimit?.limitPct ?? DAILY_LOSS_LIMIT_DEFAULT_PCT;

  // ── recente orders voor de guards (geen stille afkap — paginering) ────
  const orders24h = dry ? [] : await listOrdersSince(new Date(Date.now() - 24 * 3600_000).toISOString()).catch(() => []);

  // ── statussen van de andere agents (via de database) ──────────────────
  const news = await currentNewsStatus();
  // fail-closed: onbekende/verlopen nieuws-status → géén nieuwe entries
  // (exits en risicobeheer lopen altijd door). Explicit gedefinieerd gedrag.
  const newsBlocksEntries = news.level === "high" || (NEWS_FAIL_CLOSED && news.stale);

  let signals: TradeSignal[] = [];
  let signalsTableOk = true;
  try {
    signals = await freshUnconsumedSignals(3); // alleen signalen ≤ 3 min oud
  } catch {
    signalsTableOk = false;
  }
  const sigByPair = (kind: "entry" | "exit", pair: string) =>
    signals.find((s) => s.pair === pair && s.kind === kind);

  const results: Record<string, unknown>[] = [];
  const feedActions: string[] = [];
  const signalsProcessed: Record<string, unknown>[] = [];
  const guardCounts: Record<string, number> = {};
  const bump = (k: string) => { guardCounts[k] = (guardCounts[k] ?? 0) + 1; };

  const mark = async (sig: TradeSignal | undefined, outcome: string, outcomeReason: string) => {
    if (!sig) return;
    signalsProcessed.push({ id: sig.id, pair: sig.pair, kind: sig.kind, side: sig.side, reason: sig.reason, outcome, outcome_reason: outcomeReason });
    if (!dry) await markSignal(sig.id, outcome, outcomeReason);
  };

  if (!signalsTableOk) {
    feedActions.push("⚠ trade_signals-tabel niet beschikbaar — geen nieuwe entries (exits blijven werken)");
  }
  if (unavailablePairs.length) {
    feedActions.push(`⚠ candledata onbeschikbaar: ${unavailablePairs.join(", ")} — alleen exits/risico bewaakt`);
  }
  if (news.stale && NEWS_FAIL_CLOSED) {
    feedActions.push(`⚠ nieuws-status verouderd (${news.ageMin ?? "?"} min) → fail-closed: geen nieuwe entries tot de nieuws-agent weer schrijft`);
  }

  // ── STAP 1: open posities beheren (risico-exits + exit-signalen) ──────
  for (const s of states) {
    const actions: string[] = [];
    const price = priceOf[s.pair];
    if (price === undefined) {
      results.push({ pair: s.pair, price: null, status: "geen data", position: null, actions: ["candledata onbeschikbaar"] });
      continue;
    }
    if ((s.status === "long" || s.status === "short") && s.entry_price && s.size && s.cost) {
      const isLong = s.status === "long";
      const posSl = s.sl_pct ?? p.slPct;
      const posTp = s.tp_pct ?? p.tpPct;
      const stop = s.entry_price * (isLong ? 1 - posSl / 100 : 1 + posSl / 100);
      const target = s.entry_price * (isLong ? 1 + posTp / 100 : 1 - posTp / 100);
      let exitPrice = 0;
      let reason = "signaal";

      // 1) harde SL/TP (altijd toegestaan — geen min-hold)
      if (isLong ? price <= stop : price >= stop) { exitPrice = stop * (isLong ? 1 - slip : 1 + slip); reason = "stop-loss"; }
      else if (isLong ? price >= target : price <= target) { exitPrice = target * (isLong ? 1 - slip : 1 + slip); reason = "take-profit"; }
      else {
        // 2) exit-signaal van de analyse-AI — MIN-HOLD-guard eromheen
        const exitSig = sigByPair("exit", s.pair);
        if (exitSig && exitSig.created_at > new Date(Date.now() - 3 * 60_000).toISOString()) {
          const mh = minHoldGuard(s.entry_time, new Date(), { newsHigh: news.level === "high" });
          if (!mh.ok) {
            // te vroeg → signaal claimen + afwijzen (AI mag later opnieuw)
            if (!dry) {
              const claimed = await claimSignal(exitSig.id, runId);
              if (claimed) {
                await markSignal(exitSig.id, "skipped_min_hold", `min-hold actief — nog ${mh.remainingMin} min wachten (exits pas na 15 min, SL/TP bewaken intussen)`);
                signalsProcessed.push({ id: exitSig.id, pair: exitSig.pair, kind: "exit", side: exitSig.side, reason: exitSig.reason, outcome: "skipped_min_hold", outcome_reason: `nog ${mh.remainingMin} min` });
                bump("min_hold_blocks");
              }
            } else {
              signalsProcessed.push({ id: exitSig.id, pair: exitSig.pair, kind: "exit", side: exitSig.side, reason: exitSig.reason, outcome: "preview", outcome_reason: `min-hold zou blokkeren (${mh.remainingMin} min)` });
            }
          } else {
            if (dry || (await claimSignal(exitSig.id, runId))) {
              exitPrice = price * (isLong ? 1 - slip : 1 + slip);
              reason = "signaal";
            }
          }
        }
        // 3) max-houdtijd (altijd toegestaan)
        else if (s.entry_time && Date.now() - Date.parse(s.entry_time) >= p.maxHoldBars * 15 * 60 * 1000) {
          exitPrice = price * (isLong ? 1 - slip : 1 + slip);
          reason = "max-houdtijd";
        }
      }

      if (exitPrice && !dry) {
        const proceeds = isLong
          ? exitPrice * s.size * (1 - fee)
          : s.entry_price * s.size + (s.entry_price - exitPrice) * s.size - exitPrice * s.size * fee;
        const pnl = proceeds - s.cost;
        // FEE-UITSPLITSING: koersbijdrage vs. fees vs. slippage vs. netto
        const bd = pnlBreakdown(s.entry_price, exitPrice, s.size, isLong);
        pot.cash += proceeds;
        const closedSize = s.size;
        const closedCost = s.cost;
        const closedStrategy = s.strategy ?? null;
        const holdMin = s.entry_time ? Math.max(0, Math.round((Date.now() - Date.parse(s.entry_time)) / 60_000)) : null;
        s.status = "flat"; s.entry_price = null; s.entry_time = null; s.size = null; s.cost = null;
        s.sl_pct = null; s.tp_pct = null; s.strategy = null;
        const exitCtx = candlesByPair[s.pair] ? contextSnapshot(candlesByPair[s.pair]) : {};
        const order: PaperOrderExt = {
          pair: s.pair, side: isLong ? "sell" : "buy", price: exitPrice, size: closedSize, reason,
          equity_after: totalEquity(), pnl_eur: pnl, pnl_pct: (pnl / closedCost) * 100,
          strategy: closedStrategy, ai_explanation: null,
          context: {
            ...exitCtx,
            gross_pnl_eur: bd.grossPnlEur,
            fees_eur: bd.feesEur,
            slippage_eur: bd.slippageEur,
            net_pnl_eur: bd.netPnlEur,
            hold_min: holdMin,
            exit_reason: reason,
          },
        };
        await insertOrder(order);
        actions.push(`${isLong ? "LONG" : "SHORT"} GESLOTEN (${reason}): ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} EUR (koers ${bd.grossPnlEur >= 0 ? "+" : ""}${bd.grossPnlEur}, fees −${bd.feesEur}, slip −${bd.slippageEur})`);
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

  // ── STAP 2: daglimiet (−5% op de pot, hard) ────────────────────────────
  const eqNow = totalEquity();
  const dayStart = pot.day_start_equity || eqNow;
  if (dayStart > 0 && eqNow / dayStart - 1 <= -DAILY_LOSS_LIMIT_PCT / 100) {
    if (!dry) {
      for (const s of states) {
        const price = priceOf[s.pair];
        if (price === undefined) continue;
        if ((s.status === "long" || s.status === "short") && s.size && s.entry_price && s.cost) {
          const isLong = s.status === "long";
          const proceeds = isLong
            ? price * (1 - slip) * s.size * (1 - fee)
            : s.entry_price * s.size + (s.entry_price - price * (1 + slip)) * s.size - price * (1 + slip) * s.size * fee;
          const pnl = proceeds - s.cost;
          const bd = pnlBreakdown(s.entry_price, price * (isLong ? 1 - slip : 1 + slip), s.size, isLong);
          pot.cash += proceeds;
          const closedSize = s.size;
          const holdMin = s.entry_time ? Math.max(0, Math.round((Date.now() - Date.parse(s.entry_time)) / 60_000)) : null;
          await insertOrder({
            pair: s.pair, side: isLong ? "sell" : "buy", price: price * (isLong ? 1 - slip : 1 + slip),
            size: closedSize, reason: "daglimiet", equity_after: 0,
            pnl_eur: pnl, pnl_pct: (pnl / (s.cost ?? 1)) * 100,
            context: {
              gross_pnl_eur: bd.grossPnlEur, fees_eur: bd.feesEur,
              slippage_eur: bd.slippageEur, net_pnl_eur: bd.netPnlEur,
              hold_min: holdMin, exit_reason: "daglimiet",
            },
          });
          s.status = "flat"; s.entry_price = null; s.entry_time = null; s.size = null; s.cost = null;
          s.sl_pct = null; s.tp_pct = null; s.strategy = null;
          await mirrorBlofin("close", s.pair, closedSize, feedActions);
          feedActions.push(`${s.pair}: gesloten wegens DAGLIMIET (${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} EUR)`);
        }
      }
      pot.halted = true;
      feedActions.push(`⚠ DAGLIMIET GERAKT (−${DAILY_LOSS_LIMIT_PCT}%) — bot staat vandaag pauze`);
    } else {
      feedActions.push(`[DRY] daglimiet zou raken — alles zou sluiten`);
    }
  }

  // ── STAP 2b: verlies-snelheid (churn circuit breaker) ─────────────────
  const vel = lossVelocityGuard(orders24h, new Date());
  if (vel.paused) {
    feedActions.push(`⚠ ${vel.reason}`);
    bump("velocity_blocks");
  }

  // ── STAP 3: entry-signalen verwerken ────────────────────────────────
  const openCosts = states.reduce((a, s) => a + (s.cost ?? 0), 0);
  const openNotionalNow = states.reduce((a, s) => a + posValue(s), 0);
  const openPositionsNow = states.filter((s) => s.status !== "flat").length;
  for (const s of states) {
    const sig = sigByPair("entry", s.pair);
    if (!sig) continue;
    const isLong = sig.side === "buy";

    // ATOMAIRE CLAIM: verwerk elk signaal exact één keer (over alle runs heen)
    if (!dry) {
      const claimed = await claimSignal(sig.id, runId);
      if (!claimed) continue; // een andere run heeft dit signaal net geclaimd
    }

    if (s.status !== "flat" || pot.halted) {
      await mark(sig, "skipped", pot.halted ? "bot gepauzeerd (daglimiet)" : "positie al open");
      continue;
    }
    if (priceOf[s.pair] === undefined) {
      await mark(sig, "skipped", "candledata onbeschikbaar voor dit pair");
      continue;
    }

    // NIEUWS-POORT (incl. fail-closed bij verlopen/onbekende status)
    if (newsBlocksEntries) {
      await mark(sig, "blocked_news", news.level === "high"
        ? `nieuws-risico: ${news.reason}`
        : `nieuws-status verouderd/onbekend (fail-closed): ${news.reason}`);
      feedActions.push(`⚠ ${s.pair}: entry NIET uitgevoerd — nieuws (${news.level})`);
      bump("news_blocks");
      continue;
    }

    // VERLIES-SNELHEID
    if (vel.paused) {
      await mark(sig, "blocked_velocity", vel.reason);
      bump("velocity_blocks");
      continue;
    }

    // COOLDOWN na een exit op dit pair
    const cd = cooldownGuard(orders24h, s.pair, new Date());
    if (!cd.ok) {
      await mark(sig, "blocked_cooldown", `cooldown: nog ${cd.remainingMin} min wachten na de vorige exit`);
      bump("cooldown_blocks");
      continue;
    }

    // FREQUENTIE-LIMIETEN
    const fq = frequencyGuard(orders24h, s.pair, new Date());
    if (!fq.ok) {
      await mark(sig, "blocked_frequency", fq.reason);
      bump("frequency_blocks");
      continue;
    }

    // VEILIGHEIDS-LAAG: AI- en EVOLUTION-voorstellen keuren (zelfde banden)
    const isAi = (sig.proposed_by ?? "rule") === "ai";
    const isEvo = (sig.proposed_by ?? "rule") === "evolution";
    let slPct = p.slPct;
    let tpPct = p.tpPct;
    let riskPct = clampRiskPct(p.riskPerTrade);
    if (isAi || isEvo) {
      // FASE 3 — evolution-signaal: nog steeds PAPER_ACTIVE op dit moment?
      // (tussen signaal en claim kan een rollback hebben plaatsgevonden —
      //  execution is fail-closed: geen actieve status = geen entry)
      if (isEvo) {
        const stillActive = await evoStrategyStillActive(sig.strategy_version);
        if (!stillActive.ok) {
          await mark(sig, "blocked_risk", `evolution-strategie niet meer actief (fail-closed): ${stillActive.reason}`);
          bump("risk_blocks");
          continue;
        }
      }
      const check = validateAiProposal(sig);
      if (!check.ok) {
        await mark(sig, "blocked_risk", `${isEvo ? "evolution" : "AI"}-voorstel afgewezen door risicocheck: ${check.reason}`);
        feedActions.push(`⛔ ${s.pair}: ${isEvo ? "evolution" : "AI"}-voorstel afgewezen — ${check.reason}`);
        bump("risk_blocks");
        continue;
      }
      slPct = check.sl; tpPct = check.tp; riskPct = check.risk;
      // CANARY-CAP: evolution-versies zijn in Fase 3 altijd canary —
      // max 0,25% pot-risico per trade, hard, onoverruleerbaar
      if (isEvo) {
        riskPct = Math.min(riskPct, CANARY_RISK_CAP_PCT);
        riskPct = clampRiskPct(riskPct);
      }
    }

    // FEE-GUARD: verwachte beweging moet de round-trip-kosten ruim dekken
    const fg = feeGuard(slPct, tpPct);
    if (!fg.ok) {
      await mark(sig, "blocked_fee_edge", `${fg.reason} (TP ${tpPct}%/SL ${slPct}%)`);
      feedActions.push(`⛔ ${s.pair}: geblokkeerd door fee-guard — ${fg.reason}`);
      bump("fee_blocks");
      continue;
    }

    // POSITIONERING (risk-based, met harde notional-/exposure-caps)
    const price = priceOf[s.pair];
    const entry = price * (1 + (isLong ? slip : -slip));
    const eq = totalEquity();
    const sizing = sizePosition({
      equity: eq, cash: pot.cash,
      openNotional: openNotionalNow, openPositions: openPositionsNow,
      entry, slPct, riskPct,
    });
    if (!sizing.ok) {
      await mark(sig, sizing.reason.startsWith("exposure") ? "blocked_exposure" : "skipped", `${sizing.reason}`);
      if (sizing.reason.startsWith("exposure")) bump("exposure_blocks");
      continue;
    }
    const size = sizing.size;
    const cost = entry * size * (1 + fee);
    if (cost > pot.cash) {
      await mark(sig, "skipped", "kas te laag voor de berekende positie");
      continue;
    }

    if (dry) {
      signalsProcessed.push({ id: sig.id, pair: s.pair, kind: "entry", side: sig.side, reason: sig.reason, outcome: "preview", outcome_reason: `zou ${isLong ? "LONG" : "SHORT"} ${size.toFixed(6)} @ ${entry.toFixed(2)} EUR (risico ${riskPct}%)` });
      feedActions.push(`[DRY] ${s.pair}: zou ${isLong ? "LONG" : "SHORT"} ${size.toFixed(6)} @ ${entry.toFixed(2)} EUR`);
      continue;
    }

    pot.cash -= cost;
    s.status = isLong ? "long" : "short";
    s.entry_price = entry; s.entry_time = new Date().toISOString();
    s.size = size; s.cost = cost;
    s.sl_pct = slPct; s.tp_pct = tpPct; s.strategy = sig.strategy_version;
    const entryCtx = candlesByPair[s.pair] ? contextSnapshot(candlesByPair[s.pair]) : {};
    await insertOrder({
      pair: s.pair, side: isLong ? "buy" : "sell", price: entry, size,
      reason: sig.reason,
      equity_after: totalEquity(), pnl_eur: null, pnl_pct: null,
      strategy: sig.strategy_version, ai_explanation: sig.ai_explanation ?? null,
      timeframe: sig.timeframe ?? null,
      confidence: sig.confidence ?? null,
      context: {
        ...entryCtx,
        expected_move_pct: (sig as { expected_move_pct?: number | null }).expected_move_pct ?? null,
        expected_duration_min: (sig as { expected_duration_min?: number | null }).expected_duration_min ?? null,
        setup_quality: (sig as { setup_quality?: string | null }).setup_quality ?? null,
        thesis: (sig as { thesis?: string | null }).thesis ?? null,
        invalidation: (sig as { invalidation?: string | null }).invalidation ?? null,
        est_entry_fee_eur: Math.round(entry * size * fee * 100) / 100,
        est_round_trip_cost_pct: fg.roundTripCostPct,
        risk_pct: riskPct,
      },
    });
    const acts: string[] = [];
    await mirrorBlofin(isLong ? "open" : "open_short", s.pair, size, acts);
    await mark(sig, "executed", `order geplaatst: ${size.toFixed(6)} @ ${entry.toFixed(2)} (risico ${riskPct}% van de pot, notioneel €${(size * entry).toFixed(0)})`);
    feedActions.push(`${s.pair}: ${isLong ? "LONG" : "SHORT"} ${size.toFixed(6)} @ ${entry.toFixed(2)} EUR · risico ${riskPct}%${acts.length ? ` · ${acts[0]}` : ""}`);
  }

  // ── STAP 4: overgebleven signalen laten verlopen ─────────────────────
  if (!dry) {
    for (const sig of signals) {
      if (signalsProcessed.some((x) => Number(x.id) === sig.id)) continue;
      await markSignal(sig.id, "expired", "signaal niet tijdig verwerkt");
      signalsProcessed.push({ id: sig.id, pair: sig.pair, kind: sig.kind, side: sig.side, reason: sig.reason, outcome: "expired", outcome_reason: "signaal niet tijdig verwerkt" });
    }
  }

  // ── STAP 5: BloFin demo reconciliation ──────────────────────────────
  let reconciliation: { ok: boolean; mismatches: unknown[]; error?: string } | null = null;
  if (!dry) {
    try {
      reconciliation = await runReconciliation(feedActions);
    } catch (e) {
      reconciliation = { ok: false, mismatches: [], error: String(e instanceof Error ? e.message : e) };
    }
  }

  // ── FASE 3: evolution-monitor-tick (bounded, fail-closed, max 1×/5 min) ──
  let evolution: { checked: number; rollbacks: { strategy: string; triggers: string[] }[]; warnings: { strategy: string; warnings: string[] }[]; errors: string[] } | null = null;
  if (!dry) {
    try {
      const signals24h = await listSignalsSince(new Date(Date.now() - 86400_000).toISOString(), 5);
      const tickRes = await evolutionMonitorTick(signals24h);
      evolution = {
        checked: tickRes.checked,
        rollbacks: tickRes.rollbacks,
        warnings: tickRes.warnings,
        errors: tickRes.errors,
      };
      for (const rb of tickRes.rollbacks) {
        feedActions.push(`🔴 ROLLBACK ${rb.strategy}: ${rb.triggers.join("; ")}`);
      }
    } catch (e) {
      evolution = { checked: 0, rollbacks: [], warnings: [], errors: [String(e instanceof Error ? e.message : e)] };
    }
  }

  // ── FASE 4: paper validation tick (gebonden: max 1×/12u, execution-lock
  //    per strategie per dag in de DB; blokkeert de order-flow nooit) ──
  if (!dry) {
    try {
      const valTick = await validationTick();
      for (const v of valTick.validated) {
        if (v.statusChanged) feedActions.push(`📋 VALIDATIE ${v.strategy}: ${v.verdict} (${v.statusChanged})`);
      }
      for (const q of valTick.queuePromotions) {
        feedActions.push(`🟡 CANARY-QUEUE: ${q.strategy} geactiveerd (slot vrij)`);
      }
    } catch { /* fail-closed: validatie mag de order-flow nooit breken */ }
  }

  // ── opslaan: alle positie-rijen + de pot-rij (releases de run-lock) ───
  if (!dry) await Promise.all([...states.map((s) => saveState(s)), saveState(pot)]);
  return {
    ok: true,
    pot: totalEquity(),
    pairs: results,
    actions: feedActions,
    news,
    signalsProcessed,
    learned,
    reconciliation,
    evolution,
    guards: {
      ...guardCounts,
      daily_loss_limit_pct: DAILY_LOSS_LIMIT_PCT,
      risk_band_pct: [RISK_MIN_PCT, RISK_MAX_PCT],
      velocity_paused: vel.paused,
      exposure_pct_of_equity: eqNow > 0 ? Math.round((openNotionalNow / eqNow) * 1000) / 10 : 0,
    },
  };
}
