// ── Multi-coin backtest-overzicht voor het dashboard ───────────────────
// Levert per coin: actuele koers, stats en een gedownsamplede
// equity/koers-curve met alle trades (voor de grafiek-markers).
// De backtest-logica zelf is onveranderd — dit is puur een lees-API.

import { fetchCandles } from "@/lib/exchange/marketdata";
import { runBacktest } from "@/lib/backtest";
import { DEFAULT_PARAMS } from "@/lib/strategy";
import { PAIRS, PAIR_NAMES } from "@/lib/exchange/pairs";

export const dynamic = "force-dynamic"; // altijd verse data
export const maxDuration = 60;

export async function GET() {
  try {
    const out = [];
    let periodStart = 0;
    let periodEnd = 0;

    for (const pair of PAIRS) {
      const candles = await fetchCandles(pair, 15, 45);
      if (candles.length < 1500) {
        throw new Error(`Te weinig candles voor ${pair} (${candles.length})`);
      }
      const result = runBacktest(candles, DEFAULT_PARAMS);
      const n = candles.length;
      periodStart = periodStart || candles[0].t;
      periodEnd = candles[n - 1].t;

      // Downsamplen naar ~150 punten voor een vlotte grafiek
      const step = Math.max(1, Math.floor(n / 150));
      const times: number[] = [];
      const prices: number[] = [];
      const equity: number[] = [];
      for (let i = 0; i < n; i += step) {
        times.push(candles[i].t);
        prices.push(candles[i].c);
        equity.push(result.equity[i]);
      }

      out.push({
        pair,
        name: PAIR_NAMES[pair],
        price: candles[n - 1].c,
        stats: {
          totalReturnPct: result.stats.totalReturnPct,
          buyHoldPct: result.stats.buyHoldPct,
          winRatePct: result.stats.winRatePct,
          numTrades: result.stats.numTrades,
          numShorts: result.stats.numShorts,
          maxDrawdownPct: result.stats.maxDrawdownPct,
          avgHoldHours: result.stats.avgHoldHours,
          feesPaid: result.stats.feesPaid,
          dailyStops: result.stats.dailyStops,
          bestTradePct: result.stats.bestTradePct,
          worstTradePct: result.stats.worstTradePct,
        },
        times,
        prices,
        equity,
        trades: result.trades.map((t) => ({
          side: t.side,
          entryTime: t.entryTime,
          exitTime: t.exitTime,
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          pnl: t.pnl,
          pnlPct: t.pnlPct,
          reason: t.reason,
          holdHours: t.holdHours,
        })),
      });
    }

    return Response.json({ pairs: out, periodStart, periodEnd });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Onbekende fout" },
      { status: 500 }
    );
  }
}
