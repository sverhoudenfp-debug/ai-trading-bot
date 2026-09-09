// ── Lichte live-candles + prijzen voor de dashboard-charts ───────────────
// GET /api/paper/candles?pair=BTC-EUR&interval=15 → laatste paar candles
// GET /api/paper/candles?prices=1 → actuele koers van alle 8 coins
// Publiek (alleen Bitvavo publieke data), voor de live-update van de chart.

import { NextRequest, NextResponse } from "next/server";
import { fetchCandles } from "@/lib/exchange/marketdata";
import { PAIRS, isPair } from "@/lib/exchange/pairs";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  try {
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
