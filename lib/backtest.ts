// ── Backtest-engine ─────────────────────────────────────────────────────
// Simuleert de strategie op historische 15m-candles met échte kosten
// (fee + slippage aan beide kanten), verplicht risicobeheer en logging.

import { Candle } from "./exchange/marketdata";
import {
  DEFAULT_PARAMS,
  StrategyParams,
  prepare,
  longSignal,
  exitSignal,
} from "./strategy";

export interface Trade {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  size: number;      // aantal BTC
  pnl: number;      // netto winst/verlies in €
  pnlPct: number;   // t.o.v. ingelegd bedrag
  reason: "take-profit" | "stop-loss" | "signaal" | "max-hold" | "daglimiet";
  holdHours: number;
}

export interface BacktestResult {
  stats: {
    totalReturnPct: number;
    buyHoldPct: number;
    winRatePct: number;
    numTrades: number;
    maxDrawdownPct: number;
    dailyStops: number;
    avgHoldHours: number;
    feesPaid: number;
    bestTradePct: number;
    worstTradePct: number;
  };
  equity: number[];  // kapitaal per candle (mark-to-market)
  prices: number[];  // koers per candle (voor buy&hold-lijn)
  trades: Trade[];
  params: StrategyParams;
  candlesUsed: number;
  periodStart: number;
  periodEnd: number;
}

export function runBacktest(
  candles: Candle[],
  params: StrategyParams = DEFAULT_PARAMS
): BacktestResult {
  const p = params;
  const s = prepare(candles, p);
  const n = candles.length;

  let cash = 1000; // startkapitaal (gesimuleerd)
  const startEquity = cash;
  let pos: { entryIdx: number; entryPrice: number; size: number; cost: number } | null = null;

  const equity: number[] = [];
  const trades: Trade[] = [];
  let dailyStops = 0;
  let feesPaid = 0;

  let day = -1;
  let dayStartEquity = cash;
  let dayStopped = false;

  const closePos = (i: number, price: number, reason: Trade["reason"]) => {
    if (!pos) return;
    const exitPrice = price * (1 - p.slippagePct / 100);
    const fee = (exitPrice * pos.size * p.feePct) / 100;
    const proceeds = exitPrice * pos.size - fee;
    cash += proceeds;
    const pnl = proceeds - pos.cost;
    feesPaid += fee;
    trades.push({
      entryTime: candles[pos.entryIdx].t,
      exitTime: candles[i].t,
      entryPrice: pos.entryPrice,
      exitPrice,
      size: pos.size,
      pnl,
      pnlPct: (pnl / pos.cost) * 100,
      reason,
      holdHours: ((candles[i].t - candles[pos.entryIdx].t) / 3600),
    });
    pos = null;
  };

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const utcDay = Math.floor(c.t / 86400);

    // ── nieuwe dag: daglimiet resetten
    if (utcDay !== day) {
      day = utcDay;
      dayStartEquity = pos
        ? cash + pos.size * c.o
        : cash;
      dayStopped = false;
    }

    // ── open positie beheren (intrabar SL/TP, daarna signalen)
    if (pos) {
      const stop = pos.entryPrice * (1 - p.slPct / 100);
      const target = pos.entryPrice * (1 + p.tpPct / 100);
      if (c.l <= stop) {
        closePos(i, stop, "stop-loss"); // SL eerst checken = conservatief
      } else if (c.h >= target) {
        closePos(i, target, "take-profit");
      } else if (exitSignal(s, candles, i, p)) {
        closePos(i, c.c, "signaal");
      } else if (i - pos.entryIdx >= p.maxHoldBars) {
        closePos(i, c.c, "max-hold"); // day-trading: geen posities urenlang meeslepen
      }
    }

    // ── daglimiet checken (verplicht risicobeheer)
    const currentEquity: number = pos ? cash + pos.size * c.c : cash;
    if (!dayStopped && currentEquity / dayStartEquity - 1 <= -p.dailyLossLimitPct / 100) {
      dayStopped = true;
      dailyStops++;
      if (pos) closePos(i, c.c, "daglimiet"); // niks meer riskeren vandaag
    }

    // ── nieuw koopsignaal? (alleen als bot die dag niet gestopt is)
    if (!pos && !dayStopped && i > p.emaTrend && longSignal(s, candles, i, p)) {
      const riskAmount: number = (currentEquity * p.riskPerTrade) / 100;
      let size: number = riskAmount / (c.c * (p.slPct / 100)); // BTC-grootte: SL-afstand bepaalt het risico
      const maxAffordable = (cash * 0.99) / c.c; // geen hefboom
      size = Math.min(size, maxAffordable);
      if (size > 0.00001) {
        const entryPrice = c.c * (1 + p.slippagePct / 100);
        const fee = (entryPrice * size * p.feePct) / 100;
        const cost = entryPrice * size + fee;
        if (cost <= cash * 0.999) {
          cash -= cost;
          feesPaid += fee;
          pos = { entryIdx: i, entryPrice, size, cost };
        }
      }
    }

    // ── equity-curve (mark-to-market)
    equity.push(pos ? cash + pos.size * c.c : cash);
  }

  // einde: open positie sluiten op de laatste koers
  if (pos) closePos(n - 1, candles[n - 1].c, "signaal");

  const finalEquity = equity.length ? Math.max(...equity.slice(-1), cash) : cash;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const prices = candles.map((c) => c.c);

  // max drawdown op de equity-curve
  let peak = equity[0] ?? startEquity;
  let maxDD = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    maxDD = Math.max(maxDD, (peak - e) / peak);
  }

  return {
    stats: {
      totalReturnPct: (finalEquity / startEquity - 1) * 100,
      buyHoldPct: (candles[n - 1].c / candles[0].o - 1) * 100,
      winRatePct: trades.length ? (wins / trades.length) * 100 : 0,
      numTrades: trades.length,
      maxDrawdownPct: maxDD * 100,
      dailyStops,
      avgHoldHours: trades.length
        ? trades.reduce((a, t) => a + t.holdHours, 0) / trades.length
        : 0,
      feesPaid,
      bestTradePct: trades.length ? Math.max(...trades.map((t) => t.pnlPct)) : 0,
      worstTradePct: trades.length ? Math.min(...trades.map((t) => t.pnlPct)) : 0,
    },
    equity,
    prices,
    trades,
    params: p,
    candlesUsed: n,
    periodStart: candles[0].t,
    periodEnd: candles[n - 1].t,
  };
}
