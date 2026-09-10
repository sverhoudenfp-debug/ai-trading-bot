// ── FASE 2: event-driven research backtest-engine ────────────────────────
// EXECUTION MODEL (expliciet vastgelegd, Deel 8):
//   1. indicatoren/condities op close van candle T            (data ≤ T)
//   2. signaal → fill op OPEN van candle T+1 (± slippage)
//   3. SL/TP intrabar geëvalueerd op candles T+1.. — bij beide
//      geraakt in dezelfde candle geldt SL EERST (pessimistisch)
//   4. exit-signaal op close T → fill op open T+1
//   5. fees over beide kanten op de werkelijke fill-prijs
//   6. sizing volgens Fase 1: risk 0,25–1,0% (geclampt), notional cap
//      25% van equity, kas-limiet, geen hefboom
//
// GEEN LOOK-AHEAD: alle informatie op index i komt uit het frame (data ≤ i);
// fills gebeuren strikt op i+1.open. Er wordt nooit dezelfde candle gesloten
// én geopend met dezelfde kennis (assertie in runPairBacktest).

import { Frame, FRAME_WARMUP } from "./frame";
import { StrategySpec, Condition } from "./spec";
import { entrySignal, exitSignal, filtersOk } from "./interpreter";
import { FEE_PCT, SLIPPAGE_PCT, RISK_MIN_PCT, RISK_MAX_PCT, RISK_DEFAULT_PCT, MAX_NOTIONAL_PCT } from "@/lib/risk/config";
import type { Regime } from "./regimes";

export interface RTrade {
  pair: string;
  side: "long" | "short";
  entryIdx: number;
  exitIdx: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;  // werkelijke fill (incl. slippage)
  exitPrice: number;
  size: number;
  grossPnl: number;    // koersbijdrage vóór kosten
  fees: number;       // entry-fee + exit-fee
  slippage: number;   // gesimuleerde slip bij entry + exit
  netPnl: number;     // gross − fees − slippage
  reason: "stop-loss" | "take-profit" | "signaal" | "max-hold" | "end-of-data";
  holdMin: number;
  regime: Regime;     // regime bij entry (Deel 22)
}

export interface Metrics {
  trades: number;
  wins: number;
  winratePct: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  netPnl: number;
  netReturnPct: number;        // t.o.v. start-equity
  expectancyEur: number;       // netto per trade
  profitFactor: number | null; // brutowinst / brutoverlies (netto)
  avgWin: number;
  avgLoss: number;
  maxDrawdownPct: number;
  avgHoldMin: number;
  maxWinStreak: number;
  maxLossStreak: number;
  exitReasons: Record<string, number>;
}

export interface BacktestOptions {
  equityStart?: number;
  feePct?: number;        // override voor robustness-tests
  slippagePct?: number;
  entrySlipExtraPct?: number; // robustness: slechtere entry
  exitSlipExtraPct?: number;  // robustness: slechtere exit
  fromIdx?: number;         // venster (OOS/is)
  toIdx?: number;
}

/** Metrics berekenen uit trades + equity-curve. Pure. */
export function computeMetrics(trades: RTrade[], equity: number[], equityStart: number): Metrics {
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  const gross = trades.reduce((a, t) => a + t.grossPnl, 0);
  const fees = trades.reduce((a, t) => a + t.fees, 0);
  const slip = trades.reduce((a, t) => a + t.slippage, 0);
  const net = trades.reduce((a, t) => a + t.netPnl, 0);
  const grossWin = wins.reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netPnl, 0));
  // max drawdown op equity-curve
  let peak = equity[0] ?? equityStart, maxDD = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    maxDD = Math.max(maxDD, peak > 0 ? (peak - e) / peak : 0);
  }
  // streaks
  let ws = 0, ls = 0, maxWs = 0, maxLs = 0;
  for (const t of trades) {
    if (t.netPnl > 0) { ws++; ls = 0; maxWs = Math.max(maxWs, ws); }
    else { ls++; ws = 0; maxLs = Math.max(maxLs, ls); }
  }
  const exitReasons: Record<string, number> = {};
  for (const t of trades) exitReasons[t.reason] = (exitReasons[t.reason] ?? 0) + 1;
  return {
    trades: trades.length,
    wins: wins.length,
    winratePct: trades.length ? Math.round((wins.length / trades.length) * 1000) / 10 : 0,
    grossPnl: r2(gross),
    fees: r2(fees),
    slippage: r2(slip),
    netPnl: r2(net),
    netReturnPct: equityStart > 0 ? r2((net / equityStart) * 100) : 0,
    expectancyEur: trades.length ? r2(net / trades.length) : 0,
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : (grossWin > 0 ? 99 : null),
    avgWin: wins.length ? r2(grossWin / wins.length) : 0,
    avgLoss: losses.length ? r2(grossLoss / losses.length) : 0,
    maxDrawdownPct: r2(maxDD * 100),
    avgHoldMin: trades.length ? Math.round(trades.reduce((a, t) => a + t.holdMin, 0) / trades.length) : 0,
    maxWinStreak: maxWs,
    maxLossStreak: maxLs,
    exitReasons,
  };
}

/**
 * Backtest van één spec op één pair. Eén positie per pair tegelijk.
 * Signaal op close i → fill op open i+1 (hard — geen zelfde-candle fill).
 */
export function runPairBacktest(
  f: Frame,
  spec: StrategySpec,
  opts: BacktestOptions = {}
): { trades: RTrade[]; equity: number[]; startEquity: number; endEquity: number } {
  const feePct = opts.feePct ?? FEE_PCT;
  const slipPct = opts.slippagePct ?? SLIPPAGE_PCT;
  const entrySlip = slipPct + (opts.entrySlipExtraPct ?? 0);
  const exitSlip = slipPct + (opts.exitSlipExtraPct ?? 0);
  const equityStart = opts.equityStart ?? 1000;
  const from = Math.max(opts.fromIdx ?? FRAME_WARMUP, FRAME_WARMUP);
  const to = Math.min(opts.toIdx ?? f.candles.length - 1, f.candles.length - 1);

  let cash = equityStart;
  const trades: RTrade[] = [];
  const equity: number[] = [];

  interface OpenPos { entryIdx: number; entryPrice: number; size: number; cost: number }
  let pos: OpenPos | null = null;
  const isLong = spec.direction === "long";

  for (let i = from; i <= to; i++) {
    const c = f.candles[i];

    // ── 1. open positie beheren (intrabar, SL eerst = pessimistisch) ────
    if (pos) {
      const stop = pos.entryPrice * (isLong ? 1 - spec.stop_loss_pct / 100 : 1 + spec.stop_loss_pct / 100);
      const target = pos.entryPrice * (isLong ? 1 + spec.take_profit_pct / 100 : 1 - spec.take_profit_pct / 100);
      const hitStop = isLong ? c.l <= stop : c.h >= stop;
      const hitTp = isLong ? c.h >= target : c.l <= target;
      if (hitStop) {
        closeAt(i, stop, "stop-loss");
      } else if (hitTp) {
        closeAt(i, target, "take-profit");
      } else if (i - pos.entryIdx >= spec.max_hold_bars) {
        closeAt(i, c.c, "max-hold");
      } else if (exitSignal(f, i, spec.exit_conditions as Condition[])) {
        // exit-signaal op close i → pas vullen op open i+1 (onder in de loop)
        if (i + 1 <= to) {
          const fill = f.candles[i + 1].o;
          closeAt(i + 1, fill, "signaal");
          i += 1; // volgende candle is verbruikt voor de fill
        }
      }
    }

    // ── 2. entry-signaal op close i → fill op open i+1 ────────────────────
    if (!pos && i < to && entrySignal(f, i, spec.entry_conditions as Condition[]) && filtersOk(f, i, spec.filters)) {
      const fillRaw = f.candles[i + 1].o;
      const fill = isLong ? fillRaw * (1 + entrySlip / 100) : fillRaw * (1 - entrySlip / 100);
      // sizing volgens Fase 1: risk-gebaseerd met notional-cap
      const riskPct = clamp(spec.risk_pct);
      const riskAmount = ((cash) * riskPct) / 100;
      let size = riskAmount / (fill * (spec.stop_loss_pct / 100));
      const maxNotional = cash * (MAX_NOTIONAL_PCT / 100);
      size = Math.min(size, maxNotional / fill);
      const feeEntry = fill * size * (feePct / 100);
      const cost = fill * size + feeEntry;
      if (size > 0 && cost <= cash * 0.999) {
        cash -= cost;
        pos = { entryIdx: i + 1, entryPrice: fill, size, cost };
        void feeEntry;
      }
    }

    equity.push(pos ? markToMarket(pos, c.c, isLong, cash) : cash);
    continue;

    // ── lokale helper: sluiten op fill-prijs (± slip, fee, uitsplitsing) ──
    function closeAt(exitIdx: number, priceRaw: number, reason: RTrade["reason"]): void {
      if (!pos) return;
      const exitPrice = isLong ? priceRaw * (1 - exitSlip / 100) : priceRaw * (1 + exitSlip / 100);
      // koersbijdrage op RUILE prijzen; fees en slippage apart → netto
      const rawEntry = isLong ? pos.entryPrice / (1 + entrySlip / 100) : pos.entryPrice / (1 - entrySlip / 100);
      const rawExit = isLong ? exitPrice / (1 - exitSlip / 100) : exitPrice / (1 + exitSlip / 100);
      const gross = isLong
        ? (rawExit - rawEntry) * pos.size
        : (rawEntry - rawExit) * pos.size;
      const exitFee = exitPrice * pos.size * (feePct / 100);
      const entryFee = pos.cost - pos.entryPrice * pos.size;
      const slipEur = (Math.abs(pos.entryPrice - rawEntry) + Math.abs(exitPrice - rawExit)) * pos.size;
      const net = gross - exitFee - entryFee - slipEur;
      cash += isLong
        ? pos.entryPrice * pos.size + (exitPrice - pos.entryPrice) * pos.size - exitFee
        : pos.cost - entryFee + (pos.entryPrice - exitPrice) * pos.size - exitFee;
      trades.push({
        pair: f.pair,
        side: isLong ? "long" : "short",
        entryIdx: pos.entryIdx,
        exitIdx,
        entryTime: f.candles[pos.entryIdx].t,
        exitTime: f.candles[exitIdx].t,
        entryPrice: pos.entryPrice,
        exitPrice,
        size: pos.size,
        grossPnl: r2(gross),
        fees: r2(exitFee + entryFee),
        slippage: r2(slipEur),
        netPnl: r2(net),
        reason,
        holdMin: Math.round((f.candles[exitIdx].t - f.candles[pos.entryIdx].t) / 60),
        regime: f.regime[pos.entryIdx],
      });
      pos = null;
    }
  }

  // einde venster: open positie sluiten op laatste close (eindgegevens)
  if (pos && equity.length) {
    const lastC = f.candles[to];
    const exitPrice = isLong ? lastC.c * (1 - exitSlip / 100) : lastC.c * (1 + exitSlip / 100);
    const rawEntry = pos.entryPrice;
    const gross = isLong ? (exitPrice - rawEntry) * pos.size : (rawEntry - exitPrice) * pos.size;
    // exit-slip zit al in exitPrice/net — hier alleen correct gerapporteerd (was hard 0)
    const slipCost = isLong ? (lastC.c - exitPrice) * pos.size : (exitPrice - lastC.c) * pos.size;
    const exitFee = exitPrice * pos.size * (feePct / 100);
    const entryFee = pos.cost - pos.entryPrice * pos.size;
    const net = gross - exitFee - entryFee;
    cash += isLong ? pos.entryPrice * pos.size + gross - exitFee : pos.cost - entryFee + gross - exitFee;
    trades.push({
      pair: f.pair, side: isLong ? "long" : "short",
      entryIdx: pos.entryIdx, exitIdx: to,
      entryTime: f.candles[pos.entryIdx].t, exitTime: lastC.t,
      entryPrice: pos.entryPrice, exitPrice, size: pos.size,
      grossPnl: r2(gross), fees: r2(exitFee + entryFee), slippage: r2(Math.max(0, slipCost)), netPnl: r2(net),
      reason: "end-of-data",
      holdMin: Math.round((lastC.t - f.candles[pos.entryIdx].t) / 60),
      regime: f.regime[pos.entryIdx],
    });
    pos = null;
    equity[equity.length - 1] = cash;
  }

  return { trades, equity, startEquity: equityStart, endEquity: equity[equity.length - 1] ?? cash };
}

function markToMarket(pos: { entryPrice: number; size: number; cost: number }, price: number, isLong: boolean, cash: number): number {
  return isLong ? cash + pos.size * price : cash + pos.size * (2 * pos.entryPrice - price);
}

function clamp(riskPct: number): number {
  if (!Number.isFinite(riskPct) || riskPct <= 0) return RISK_DEFAULT_PCT;
  return Math.min(RISK_MAX_PCT, Math.max(RISK_MIN_PCT, riskPct));
}

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}
