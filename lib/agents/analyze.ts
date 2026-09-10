// ── ANALYSE-AGENT ────────────────────────────────────────────────────────
// Bouwt voort op lib/strategy.ts + lib/indicators.ts (onveranderd). De agent
// rekent per coin de signalen uit en schrijft die als "kans" weg in de
// Supabase-tabel trade_signals — hij handelt ZELF NIET. De order-agent leest
// de signalen bij elke cron-tick en beslist of hij ze uitvoert.
//
// Verdeling met de order-agent:
//   analyse: entry-signalen (RSI-dip + trend) en slimme exits (RSI-herstel)
//   orders:  risico-exits (stop-loss, take-profit, max-houdtijd, daglimiet),
//            positionering, pot-beheer en de Blofin-spiegel.
//
// Hier komt later ook de zelflerende laag: wekelijks parameter-varianten
// backtesten en alleen na validatie als nieuwe strategie-versie activeren.
// Elke signaal krijgt daarom een strategy_version-stempel.

import { fetchCandles } from "@/lib/exchange/marketdata";
import { PAIRS } from "@/lib/exchange/pairs";
import {
  DEFAULT_PARAMS, prepare, longSignal, shortSignal,
  exitLongSignal, exitShortSignal,
} from "@/lib/strategy";
import { getStates } from "@/lib/paper/store";
import { insertSignal, recentUnconsumedSignals } from "./db";
import { evaluateEvolutionForPair } from "@/lib/evolution/live";
import { activeRowsCached } from "@/lib/evolution/live";

export const STRATEGY_VERSION = "v1.0";

/**
 * De analyse-agent: één run over alle coins. Per coin verse candles →
 * signaalberekening → signalen wegschrijven (met dedup: geen dubbel signaal
 * terwijl het vorige nog niet verbruikt is).
 */
export async function analyzeAgent(): Promise<{
  checked: number;
  newSignals: { pair: string; side: string; kind: string; reason: string }[];
  skipped: string[];
  evolutionSignals?: number;
}> {
  const p = DEFAULT_PARAMS;
  const states = await getStates();
  const stateOf = (pair: string) => states.find((s) => s.pair === pair);

  // dedup-lijst: onverbruikte signalen van de afgelopen 10 min
  let pending: Awaited<ReturnType<typeof recentUnconsumedSignals>> = [];
  try {
    pending = await recentUnconsumedSignals(10);
  } catch {
    // tabel er nog niet? → geen signalen schrijven, order-agent merkt dit
    throw new Error("trade_signals-tabel niet beschikbaar (supabase-agents-setup.sql gedraaid?)");
  }

  const newSignals: { pair: string; side: string; kind: string; reason: string }[] = [];
  const skipped: string[] = [];

  for (const pair of PAIRS) {
    const candles = await fetchCandles(pair, 15, 45);
    if (candles.length < 300) {
      skipped.push(`${pair}: te weinig candledata (${candles.length})`);
      continue;
    }
    const closedIdx = candles.length - 2; // laatst gesloten candle
    const sgn = prepare(candles, p);
    const st = stateOf(pair);
    const status = st?.status ?? "flat";

    // Welke kant op? Long-entry, short-entry, of slimme exit van een open positie
    let side: "buy" | "sell" | null = null;
    let kind: "entry" | "exit" = "entry";
    let reason = "";

    if (status === "flat") {
      if (longSignal(sgn, candles, closedIdx, p)) {
        side = "buy"; reason = "long: RSI-dip + stijgende trend";
      } else if (p.allowShorts && shortSignal(sgn, candles, closedIdx, p)) {
        side = "sell"; reason = "short: RSI-pomp + dalende trend";
      }
    } else if (status === "long" && exitLongSignal(sgn, candles, closedIdx, p)) {
      side = "sell"; kind = "exit"; reason = "signaal-exit: RSI hersteld (dip uitgekocht)";
    } else if (status === "short" && exitShortSignal(sgn, candles, closedIdx, p)) {
      side = "buy"; kind = "exit"; reason = "signaal-exit: RSI gezakt (pomp uitgekwakt)";
    }

    if (!side) continue;

    // dedup: zelfde signaal (pair+kind+side) al pending? → niet nogmaals wegschrijven
    const dupe = pending.some(
      (s) => s.pair === pair && s.kind === kind && s.side === side
    );
    if (dupe) {
      skipped.push(`${pair}: ${kind}-${side} signaal stond al klaar (dedup)`);
      continue;
    }

    await insertSignal({ pair, side, kind, reason, strategy_version: STRATEGY_VERSION });
    newSignals.push({ pair, side, kind, reason });
    pending.push({ pair, side, kind } as (typeof pending)[number]); // ook binnen-run dedup
  }

  // ── FASE 3: PAPER_ACTIVE evolution-versies meenemen (fail-closed) ──────
  // Geen actieve versies → nul extra werk. Wél actief → zelfde candles-conventie,
  // zelfde interpreter als de backtest, zelfde dedup + risk-engine later.
  let evoCount = 0;
  try {
    const activeRows = await activeRowsCached();
    if (activeRows.length > 0) {
      for (const pair of PAIRS) {
        const [c15, c1h] = await Promise.all([
          fetchCandles(pair, 15, 300),
          fetchCandles(pair, 60, 300),
        ]);
        const proposals = await evaluateEvolutionForPair(pair, c15, c1h, () => null);
        for (const p of proposals) {
          const dupe = pending.some((s) => s.pair === pair && s.kind === "entry" && s.side === p.side);
          if (dupe) { skipped.push(`${pair}: evolution-entry stond al klaar (dedup)`); continue; }
          await insertSignal({
            pair, side: p.side, kind: "entry",
            reason: p.reason,
            strategy_version: p.strategyKey,
            proposed_by: "evolution",
            timeframe: "15m",
            sl_pct: p.slPct, tp_pct: p.tpPct, risk_pct: p.riskPct,
            confidence: "high",
          });
          newSignals.push({ pair, side: p.side, kind: "entry", reason: p.reason });
          pending.push({ pair, kind: "entry", side: p.side } as (typeof pending)[number]);
          evoCount += 1;
        }
      }
    }
  } catch (e) {
    // FAIL-CLOSED: evolution-evaluatie mag de legacy-flow nooit breken
    skipped.push(`evolution-evaluatie overgeslagen (fail-closed): ${String(e instanceof Error ? e.message : e)}`);
  }

  return { checked: PAIRS.length, newSignals, skipped, evolutionSignals: evoCount };
}
