// ── Multi-coin overzicht voor het dashboard ─────────────────────────────
// Levert per coin: actuele koers, stats, volledige OHLC-candles (voor de
// candlestick-chart) en alle trades (voor de bot-positie-markers op die
// candles). De backtest-logica zelf is onveranderd — dit is puur een
// lees-API.

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
        // Volledige OHLC-reeks — lightweight-charts kan duizenden candles
        // vlekkeloos tekenen, dus geen downsampling nodig.
        candles: candles.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c })),
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
