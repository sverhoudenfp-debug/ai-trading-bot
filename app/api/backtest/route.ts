import { fetchCandles } from "@/lib/exchange/marketdata";
import { isPair } from "@/lib/exchange/pairs";
import { runBacktest } from "@/lib/backtest";
import { DEFAULT_PARAMS } from "@/lib/strategy";

export const dynamic = "force-dynamic"; // altijd verse data, nooit cache
export const maxDuration = 60;

export async function GET(req: Request) {
  try {
    const pairParam = new URL(req.url).searchParams.get("pair") ?? "BTC-EUR";
    const pair = isPair(pairParam) ? pairParam : "BTC-EUR";
    const candles = await fetchCandles(pair, 15, 45);
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
