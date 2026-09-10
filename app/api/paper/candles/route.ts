// ── Lichte live-candles + prijzen voor de dashboard-charts ───────────────
// GET /api/paper/candles?pair=BTC-EUR&interval=15 → laatste paar candles
// GET /api/paper/candles?prices=1 → actuele koers van alle 8 coins
// GET /api/paper/candles?market=1 → markt-overzicht per coin: koers, 24u-
//        verandering, sparkline-closes + RSI/EMA/momentum/volatiliteit en
//        markt-regime (zelfde classificatie als de bot gebruikt).
// Publiek (alleen Bitvavo publieke data), voor de live-update van de chart.

import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/exchange/marketdata";
import { PAIRS, isPair, PAIR_NAMES } from "@/lib/exchange/pairs";
import { rsiSeries, emaSeries, momentumSeries, volatilityAt } from "@/lib/indicators";
import { regimeOfEntry } from "@/lib/validation/metrics";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  try {
    // ── markt-overzicht: indicatoren per coin (read-only, bestaande libs) ──
    if (sp.get("market")) {
      const overview = await Promise.all(PAIRS.map(async (pair) => {
        try {
          const candles = await fetchCandles(pair, 15, 2); // ~2 dagen 15m
          if (candles.length < 30) return { pair, name: PAIR_NAMES[pair] ?? pair, error: "onvoldoende candles" };
          const closes = candles.map((c) => c.c);
          const last = closes[closes.length - 1];
          const rsi = rsiSeries(closes, 14);
          const ema50 = emaSeries(closes, 50);
          const ema200 = emaSeries(closes, Math.min(200, closes.length - 1));
          const mom = momentumSeries(closes, 8);
          const dayWindow = candles.slice(-96); // 24u op 15m
          const dayHi = Math.max(...dayWindow.map((c) => c.h));
          const dayLo = Math.min(...dayWindow.map((c) => c.l));
          const c24 = dayWindow.length >= 96 ? dayWindow[0].c : last;
          return {
            pair,
            name: PAIR_NAMES[pair] ?? pair,
            price: last,
            change_24h_pct: c24 > 0 ? Math.round(((last - c24) / c24) * 1000) / 10 : null,
            rsi14: Math.round((rsi[rsi.length - 1] ?? 0) * 10) / 10,
            ema50: Math.round((ema50[ema50.length - 1] ?? 0) * 1000000) / 1000000,
            ema200: Math.round((ema200[ema200.length - 1] ?? 0) * 1000000) / 1000000,
            above_ema200: last >= (ema200[ema200.length - 1] ?? last),
            momentum_8: Math.round((mom[mom.length - 1] ?? 0) * 100) / 100,
            volatility_pct: Math.round(volatilityAt(closes, closes.length - 1, 20) * 1000) / 10,
            regime: regimeOfEntry({
              rsi15: rsi[rsi.length - 1],
              above_ema200: last >= (ema200[ema200.length - 1] ?? last),
              dist_ema50_pct: last > 0 ? ((last - (ema50[ema50.length - 1] ?? last)) / last) * 100 : 0,
              day_hi: dayHi, day_lo: dayLo,
            }),
            sparkline: closes.slice(-96).map((c) => Math.round(c * 1000000) / 1000000),
            updated_at: new Date().toISOString(),
          };
        } catch (e) {
          return { pair, name: PAIR_NAMES[pair] ?? pair, error: String(e instanceof Error ? e.message : e) };
        }
      }));
      return NextResponse.json({ market: overview });
    }

    if (sp.get("prices")) {
      const prices: Record<string, number> = {};
      await Promise.all(
        PAIRS.map(async (p) => {
          const c = await fetchCandles(p, 5, 1);
          if (c.length) prices[p] = c[c.length - 1].c;
        })
      );
      return NextResponse.json({ prices, at: new Date().toISOString() });
    }
    const pair = sp.get("pair") ?? "BTC-EUR";
    const interval = Number(sp.get("interval") ?? "15");
    if (!isPair(pair)) return NextResponse.json({ error: "onbekende pair" }, { status: 400 });
    const candles = await fetchCandles(pair, interval, 1);
    return NextResponse.json({ pair, interval, candles: candles.slice(-4) });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
