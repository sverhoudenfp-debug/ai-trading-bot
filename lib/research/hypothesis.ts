// ── FASE 2: AI Hypothesis Generator ─────────────────────────────────────
// De AI krijgt onderzoek-samenvattingen (markt + baselines + paper-fouten)
// en formuleert hypotheses als GESTRUCTUREERDE DATA (StrategySpec JSON).
// De output wordt strikt gevalideerd (lib/research/spec.ts); een ongeldige
// hypothese wordt afgewezen met reden — nooit stil gefixt, nooit uitgevoerd
// als code. Research-AI heeft een APART budget (lib/research/config.ts).

import { callClaude } from "@/lib/agents/anthropic";
import { PAIRS } from "@/lib/exchange/pairs";
import { validateSpec, StrategySpec } from "./spec";
import { normalizeSpecDraft } from "./normalize";
import {
  RESEARCH_MAX_AI_CALLS_PER_RUN, RESEARCH_MAX_AI_CALLS_PER_DAY,
  RESEARCH_MAX_COST_USD_PER_DAY, MAX_HYPOTHESES_PER_RUN,
} from "./config";
import { researchUsageToday } from "./db";
import { RoundTripCostPct } from "./cost";
import { RISK_MIN_PCT, RISK_MAX_PCT, FEE_COVER_FACTOR } from "@/lib/risk/config";

export const RESEARCH_MODEL = process.env.RESEARCH_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";

const rtp = () => (roundTripCostPct() * FEE_COVER_FACTOR).toFixed(1);

const SYSTEM_PROMPT = `You are the Hypothesis Generator of a scientific crypto-strategy research engine (PAPER/RESEARCH ONLY — this engine never executes trades).

You receive: market research summaries (180 days, 15m/1h), baseline strategy results (in-sample AND out-of-sample), and failure analysis of our live paper-trading history. Your job: propose up to ${MAX_HYPOTHESES_PER_RUN} NEW trading hypotheses worth testing, as structured JSON.

SCIENTIFIC MINDSET — this is research, not a return contest:
- Prefer NO hypothesis over a weak one. An honest "no promising hypothesis" is a fine answer.
- Fees and slippage (~${roundTripCostPct().toFixed(2)}% round-trip) are the default killer: a strategy must expect moves clearly above that.
- Small edges that are CONSISTENT (out-of-sample, across coins, across regimes) beat large in-sample returns.
- Consider WHY an edge might exist (behavioural, structural, volatility dynamics) — not just which parameters fit history.
- You may also propose REFINEMENTS of failing baselines (e.g. "pullback only when 1h trend and 15m setup align").

TRADING HORIZONS — the engine is NOT pre-committed to scalping, intraday or swing:
- Execution timeframes: "5m" (scalping), "15m" (short-term intraday), "1h" (intraday/swing).
- The SAME strategy on different horizons can behave totally differently — horizon is part of the hypothesis. You may test a concept on a different timeframe than the baseline uses.
- Context trend: 5m/15m execution get a 1h-trend filter (trend1h); 1h execution gets a 4h-trend context (same "trend1h" field, maps to 4h there).
- Multi-timeframe ideas are expressible: e.g. 15m execution + trend1h filter, or 1h execution aligned with a longer context.

STRATEGY CONCEPTS you may draw from (as INSPIRATION, never as proof):
- trend following, momentum, mean reversion, breakout, pullback, volatility breakout, RSI reversion, moving-average strategies, volume confirmation, support/resistance (via dist_ema/breakout conditions), regime-based (via filters), multi-timeframe alignment.
- External/known market knowledge may INSPIRE a hypothesis, but "the internet says this works" is NOT evidence — every hypothesis is still backtested IS/OOS, walk-forward and robustness-checked before it can ever become a candidate.

HARD CONSTRAINTS on each hypothesis:
- timeframe: "5m", "15m" or "1h"
- direction: "long" or "short"
- risk_pct: ${RISK_MIN_PCT}-${RISK_MAX_PCT} (percent of equity risked at stop-loss)
- stop_loss_pct 1-10, take_profit_pct 0.5-15 AND at least ${rtp()}% (fee-guard: TP must cover round-trip costs ×${FEE_COVER_FACTOR})
- max_hold_bars per timeframe: 5m → 4-288, 15m → 4-192, 1h → 4-192; expected_holding_time_min ≥ 15
- pairs: subset of [${PAIRS.join(", ")}]
- ALL text fields are SHORT: description ≤ 280 chars, expected_regime ≤ 100 chars (e.g. "downtrend" or "high-volatility, weak-uptrend"), failure_conditions and falsification ≤ 280 chars, name ≤ 40 chars.
- Conditions MUST be JSON OBJECTS, never strings: {"kind":"rsi_lt","value":35} — NOT "rsi_lt 35".
- entry_conditions: 1-4 AND-ed conditions from EXACTLY these kinds:
  rsi_lt, rsi_gt, rsi_cross_under, rsi_cross_over, price_above_ema(period 50|200), price_below_ema(period 50|200), ema_above_ema(period 50, period2 200), ema_below_ema(period 50, period2 200), mom_gt(bars 2-48), mom_lt(bars 2-48), dist_ema50_between(value = lower bound %, band is value..value+2), dist_ema200_gt, dist_ema200_lt, breakout_24h, breakdown_24h, volume_gt_sma(value = factor 1-10), trend1h(value "up"|"down"), volatility_gt, volatility_lt (value = vol %)
- exit_conditions: 1-3 OR-ed conditions, same kinds
- filters (optional): min_volatility_pct, max_volatility_pct, require_trend1h ("up"|"down"), min_volume_z

EXAMPLE of the exact required shape of one hypothesis (structure, not content):
{"hypotheses":[{"spec":{"name":"shallow-pullback-uptrend","description":"Shallow pullback in confirmed uptrend.","hypothesis":"Trend followers buy the first shallow pullback.","expected_regime":"weak-uptrend","failure_conditions":"Chop, deep crash pullbacks.","falsification":"OOS net negative.","timeframe":"15m","direction":"long","entry_conditions":[{"kind":"ema_above_ema","period":50,"period2":200},{"kind":"dist_ema50_between","value":-1.5}],"exit_conditions":[{"kind":"rsi_gt","value":60}],"stop_loss_pct":3,"take_profit_pct":4,"max_hold_bars":64,"risk_pct":0.5,"filters":{"require_trend1h":"up"},"pairs":["BTC-EUR","ETH-EUR"],"expected_holding_time_min":240,"origin":"ai-research"},"rationale":"...","expected_edge":"...","expected_failure":"..."}]

OUTPUT — JSON only, exact schema, no extra fields, no markdown:
{"hypotheses":[{"spec":{ "name":"kebab-case-slug","description":"...","hypothesis":"why this edge could exist","expected_regime":"when it should work","failure_conditions":"when it likely fails","falsification":"what result would falsify it","timeframe":"15m","direction":"long","entry_conditions":[...],"exit_conditions":[...],"stop_loss_pct":3,"take_profit_pct":4,"max_hold_bars":64,"risk_pct":0.5,"filters":{...},"pairs":[...],"expected_holding_time_min":240,"origin":"ai-research" },
  "rationale":"1-3 sentences: why worth testing given the data above","expected_edge":"what metric outcome would CONFIRM the hypothesis","expected_failure":"what metric outcome would FALSIFY it"}]}
- Any invalid field rejects that hypothesis (it will be logged as invalid, not fixed).
- max ${MAX_HYPOTHESES_PER_RUN} hypotheses.`;

export interface GeneratedHypothesis {
  spec: unknown;
  raw?: string;
  rationale?: string;
  expected_edge?: string;
  expected_failure?: string;
  validationErrors?: string[];
}

export interface HypothesisCallResult {
  ok: boolean;
  hypotheses: GeneratedHypothesis[];
  usage?: { input_tokens: number; output_tokens: number; costUsd: number };
  error?: string;
}

/** Research-budgetcheck (apart van het trading-budget). Pure + DB-lezing. */
export async function researchBudgetOk(callsThisRun: number): Promise<{ ok: boolean; reason?: string }> {
  const today = await researchUsageToday();
  if (callsThisRun >= RESEARCH_MAX_AI_CALLS_PER_RUN) {
    return { ok: false, reason: `research-budget: ${callsThisRun}/${RESEARCH_MAX_AI_CALLS_PER_RUN} calls in deze run` };
  }
  if (today.calls >= RESEARCH_MAX_AI_CALLS_PER_DAY) {
    return { ok: false, reason: `research-budget: ${today.calls}/${RESEARCH_MAX_AI_CALLS_PER_DAY} calls in 24u` };
  }
  if (today.costUsd >= RESEARCH_MAX_COST_USD_PER_DAY) {
    return { ok: false, reason: `research-budget: $${today.costUsd.toFixed(2)}/$${RESEARCH_MAX_COST_USD_PER_DAY} vandaag` };
  }
  return { ok: true };
}

/** Eén AI-aanroep: hypotheses genereren + per hypothese strikt valideren. */
export async function generateHypotheses(userContext: string): Promise<HypothesisCallResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, hypotheses: [], error: "ANTHROPIC_API_KEY niet ingesteld" };

  const budget = await researchBudgetOk(0);
  if (!budget.ok) return { ok: false, hypotheses: [], error: budget.reason };

  try {
    const res = await callClaude(SYSTEM_PROMPT, userContext, 3000);
    let parsed: unknown;
    try {
      const text = res.text;
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start === -1 || end === -1) throw new Error("geen JSON");
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return { ok: false, hypotheses: [], usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens, costUsd: res.costUsd }, error: "AI-output was geen geldige JSON" };
    }
    const arr = (parsed as { hypotheses?: unknown[] })?.hypotheses;
    if (!Array.isArray(arr)) {
      return { ok: false, hypotheses: [], usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens, costUsd: res.costUsd }, error: "geen hypotheses-array in AI-output" };
    }
    const hypotheses: GeneratedHypothesis[] = [];
    for (const raw of arr.slice(0, MAX_HYPOTHESES_PER_RUN)) {
      const h = raw as { spec?: unknown; rationale?: string; expected_edge?: string; expected_failure?: string };
      // deterministische normalisatie (string-condities → objecten, prosa
      // inkorten, numerieke strings → numbers) vóór de strikte validatie
      const draft = normalizeSpecDraft(h.spec);
      const v = validateSpec(draft);
      hypotheses.push({
        spec: v.ok ? (v.spec as StrategySpec) : h.spec,
        raw: JSON.stringify(h.spec).slice(0, 1500),
        rationale: h.rationale,
        expected_edge: h.expected_edge,
        expected_failure: h.expected_failure,
        validationErrors: v.ok ? undefined : v.errors,
      });
    }
    return {
      ok: hypotheses.some((h) => !h.validationErrors),
      hypotheses,
      usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens, costUsd: res.costUsd },
    };
  } catch (e) {
    return { ok: false, hypotheses: [], error: String(e instanceof Error ? e.message : e) };
  }
}

export function roundTripCostPct(): number {
  return RoundTripCostPct();
}
