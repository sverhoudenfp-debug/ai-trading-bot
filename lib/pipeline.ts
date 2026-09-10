// ── Fase 2-voorbereiding: pipeline-contracten (alleen types, geen logica) ─
// Fase 1 heeft de fundering gelegd: één centrale risk-config, guards als
// pure functies, snapshots + fee-uitsplitsing per trade, en atomaire
// claims. Fase 2 (Research Engine) gaat hierop bouwen.
//
// De beoogde Fase 2-architectuur:
//   MarketData → MarketResearcher → StrategyResearcher → StrategyEngine
//   → RiskEngine → Trader → TradeExecutor → TradeDatabase
//   → PerformanceResearcher → LearningEngine → (terug naar) StrategyEngine
//
// Deze types beschrijven de contracten tussen die stadia, zodat Fase 2
// module-voor-module ingevuld kan worden ZONDER de Fase 1-hardening te
// hoeven herschrijven. Er draait hier niets van — puur de voorbereiding.

import type { Candle } from "./exchange/marketdata";

/** Stadium 1: rauwe marktdata (nu: Bitvavo-adapter, lib/exchange/marketdata.ts). */
export interface MarketDataSnapshot {
  pair: string;
  candles: Candle[];          // ruime historie voor indicators
  fetchedAt: string;          // ISO
  source: string;             // bijv. "bitvavo-public"
}

/** Stadium 2: onderzoeker die marktomstandigheden kenmerkt. */
export interface MarketResearch {
  pair: string;
  regime: "trend-up" | "trend-down" | "chop" | "volatile";
  volatilityPct: number;
  indicators: Record<string, number>;  // uitgebreidbaar kenmerkenset
  notes?: string;
}

/** Stadium 3: strategie-hypotheses (Fase 2: AI-gegenereerd, NIET auto-actief). */
export interface StrategyHypothesis {
  id: string;
  name: string;
  params: Record<string, number | string | boolean>;
  backtestWindowDays: number;
  status: "candidate" | "backtesting" | "rejected" | "paper-ready"; // NOOIT "live" zonder expliciete fase-3-beslissing
  origin: "ai-research" | "manual";
}

/** Stadium 4: een concreet handelssignaal (nu: trade_signals-tabel). */
export interface StrategySignal {
  pair: string;
  side: "buy" | "sell";
  kind: "entry" | "exit";
  strategy: string;
  timeframe: string;
  slPct: number;
  tpPct: number;
  riskPct: number;             // 0,25–1,0 — de RiskEngine clampt hard
  thesis: string;
  invalidation: string;
  snapshot: Record<string, unknown>;  // indicator-context (context-jsonb)
}

/** Stadium 5: risico-oordeel (nu: lib/risk/engine.ts — blijft leidend). */
export interface RiskVerdict {
  approved: boolean;
  reason: string;
  clampedRiskPct?: number;
  sizeCalc?: { size: number; notional: number };
}

/** Stadium 6-7: uitgevoerde trade (nu: paper_orders + BloFin-demo-mirror). */
export interface ExecutedTrade {
  orderId?: number;
  pair: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  strategy: string;
  paper: boolean;              // Fase 1-2: ALTIDIJ true
  mirror: "none" | "blofin-demo";
}

/** Stadium 8-9: performance-feit met kosten-uitsplitsing (context-jsonb). */
export interface PerformanceFact {
  strategy: string;
  pair: string;
  grossPnlEur: number;          // koersbijdrage
  feesEur: number;
  slippageEur: number;
  netPnlEur: number;
  holdMin: number;
  exitReason: string;
}

/** Stadium 10: leer-oordeel (nu: strategy_versions — weegt, verbiedt nooit). */
export interface LearningVerdict {
  version: string;
  weights: Record<string, number>;  // 0,5–1,6, geen verboden
  rationale: string;                // WAAROM de gewichten veranderden
}
