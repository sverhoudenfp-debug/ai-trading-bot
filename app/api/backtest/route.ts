import { fetchCandles } from "@/lib/exchange/marketdata";
import { runBacktest } from "@/lib/backtest";
import { DEFAULT_PARAMS } from "@/lib/strategy";

export const dynamic = "force-dynamic"; // altijd verse data, nooit cache
export const maxDuration = 60;

export async function GET() {
  try {
    const candles = await fetchCandles("BTC-EUR", 15, 45);
    if (candles.length < 1500) {
      return Response.json(
        { error: `Te weinig candles ontvangen (${candles.length})` },
        { status: 502 }
      );
    }
    const result = runBacktest(candles, DEFAULT_PARAMS);
    return Response.json(result);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Onbekende fout" },
      { status: 500 }
    );
  }
}
