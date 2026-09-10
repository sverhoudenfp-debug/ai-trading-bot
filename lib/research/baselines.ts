// ── FASE 2: baseline-strategieën ────────────────────────────────────────
// De bestaande productie-strategieën als gestructureerde specs, getest met
// exact DEZELFDE data, fees, slippage en executie-aannames als nieuwe
// hypotheses (Deel 7). news-momentum is niet backtestbaar zonder
// nieuws-historie — expliciet gemarkeerd, niet verzonnen.

import { StrategySpec } from "./spec";
import { PAIRS } from "@/lib/exchange/pairs";

export function baselines(): StrategySpec[] {
  const pairs = [...PAIRS];
  return [
    {
      name: "baseline-rsi-dip",
      description: "Productie-strategie v1.0: RSI kruist onder 30 in een uptrend (boven EMA200) — koop de verse dip.",
      hypothesis: "In een uptrend verkopen panieke short-term-houders bij RSI<30; de gemiddelde koers keert terug richting trend.",
      expected_regime: "weak-uptrend / strong-uptrend",
      failure_conditions: "Zijwaartse of dalende markt; lage volatiliteit (beweging dekt de round-trip-kosten niet).",
      falsification: "OOS net-negatief óf winrate < 45% na kosten.",
      timeframe: "15m",
      direction: "long",
      entry_conditions: [
        { kind: "rsi_cross_under", value: 30 },
        { kind: "price_above_ema", period: 200 },
      ],
      exit_conditions: [{ kind: "rsi_gt", value: 60 }],
      stop_loss_pct: 3,
      take_profit_pct: 4,
      max_hold_bars: 64,
      risk_pct: 0.5,
      pairs,
      expected_holding_time_min: 240,
      origin: "baseline",
    },
    {
      name: "baseline-pullback",
      description: "Pullback in een duidelijke uptrend: EMA50 boven EMA200, koers zakt terug naar de EMA50-band.",
      hypothesis: "Trendvolgers kopen de eerste pullback naar het gemiddelde; vervolg van de trend is waarschijnlijker dan omkeer.",
      expected_regime: "weak-uptrend (rustige, volhardende trend)",
      failure_conditions: "Chop zonder trendvel; eerste dip ná een toppositie (trendbreuk).",
      falsification: "OOS net-negatief of expectancy < −0,10% per trade na kosten.",
      timeframe: "15m",
      direction: "long",
      entry_conditions: [
        { kind: "ema_above_ema", period: 50, period2: 200 },
        { kind: "dist_ema50_between", value: -1.5 },
        { kind: "mom_gt", value: -0.5, bars: 8 },
      ],
      exit_conditions: [{ kind: "rsi_gt", value: 65 }],
      stop_loss_pct: 3,
      take_profit_pct: 4,
      max_hold_bars: 64,
      risk_pct: 0.5,
      pairs,
      expected_holding_time_min: 360,
      origin: "baseline",
    },
    {
      name: "baseline-breakout",
      description: "Close boven het 24-uurs hoogste hoog, boven EMA200, met volume > 1,5× gemiddelde.",
      hypothesis: "Nieuwe hoogtes met volume trekken momentum-handelaren aan; breakout vervolgt intraday.",
      expected_regime: "strong-uptrend / high-volatility",
      failure_conditions: "Valse breakout in sideways (stop-hunt boven high); lage volatiliteit.",
      falsification: "OOS winrate < 45% of net-negatief; fee-fragiel (TP te klein).",
      timeframe: "15m",
      direction: "long",
      entry_conditions: [
        { kind: "breakout_24h" },
        { kind: "price_above_ema", period: 200 },
        { kind: "volume_gt_sma", value: 1.5 },
      ],
      exit_conditions: [{ kind: "mom_lt", value: 0, bars: 8 }],
      stop_loss_pct: 3,
      take_profit_pct: 5,
      max_hold_bars: 32,
      risk_pct: 0.5,
      pairs,
      expected_holding_time_min: 180,
      origin: "baseline",
    },
    {
      name: "baseline-rsi-fade-short",
      description: "Spiegel van rsi-dip: RSI kruist boven 70 in downtrend — short de oververhitte bounce.",
      hypothesis: "In een downtrend zijn overbought-bounces verkoopmomenten; de trend hervat omlaag.",
      expected_regime: "downtrend",
      failure_conditions: "Uptrend (short tegen de trend in); bull-market squeezes.",
      falsification: "OOS net-negatief — eerdere sweeps (9 sep 2026) lieten 40-44% winrate zien; deze run moet dat bevestigen of falsifiëren.",
      timeframe: "15m",
      direction: "short",
      entry_conditions: [
        { kind: "rsi_cross_over", value: 70 },
        { kind: "price_below_ema", period: 200 },
      ],
      exit_conditions: [{ kind: "rsi_lt", value: 45 }],
      stop_loss_pct: 3,
      take_profit_pct: 4,
      max_hold_bars: 64,
      risk_pct: 0.5,
      pairs,
      expected_holding_time_min: 240,
      origin: "baseline",
    },
  ];
}

/** news-momentum kan niet teruggetest worden zonder nieuws-historie. */
export function newsMomentumNote(): string {
  return "news-momentum is een productie-strategie maar NIET backtestbaar in deze research-run: nieuws-historie (RSS) is pas sinds 9 sep 2026 opgeslagen en heeft geen backtest-historie. Slechts ~1 dag data → expliciet INSUFFICIENT_DATA, geen verzonnen resultaten.";
}
