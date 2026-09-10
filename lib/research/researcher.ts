// ── FASE 2: Research-pipeline (orchestrator) ─────────────────────────────
// MARKET DATA → MARKET RESEARCHER → HYPOTHESIS GENERATOR → SPEC VALIDATION
// → BACKTEST (IS) → OOS → WALK-FORWARD → ROBUSTNESS → OVERFITTING →
// EVALUATION → RESEARCH CANDIDATE / REJECTED / INSUFFICIENT_DATA
//
// UITSLUITEND RESEARCH: deze pipeline plaatst geen orders, schrijft geen
// trade_signals, raakt geen paper-state aan en spiegtelt niets naar BloFin.
// Enige trading-side import is listOrdersSince (read-only, voor de
// foutanalyse van de bestaande strategieën).

import { PAIRS } from "@/lib/exchange/pairs";
import { getDatasets, PairDataset } from "./data";
import { buildFrame, Frame } from "./frame";
import { REGIMES } from "./regimes";
import { StrategySpec, validateSpec } from "./spec";
import { runPairBacktest, computeMetrics, RTrade, Metrics } from "./backtest";
import { makeSplit, walkForwardEvaluate, WfResult } from "./split";
import { robustnessTest, perturbationTest, detectOverfitting, OverfitFlags, RobustnessResult } from "./robustness";
import { evaluateSpec } from "./evaluator";
import { baselines, newsMomentumNote } from "./baselines";
import { generateHypotheses, researchBudgetOk, RESEARCH_MODEL, roundTripCostPct } from "./hypothesis";
import { RESEARCH_15M_DAYS, MAX_HYPOTHESES_PER_RUN } from "./config";
import { insertCandidate, insertRun, createJob, finishJob } from "./db";
import { listOrdersSince } from "@/lib/paper/store";
import { FEE_PCT, SLIPPAGE_PCT } from "@/lib/risk/config";

export interface SpecResult {
  name: string;
  origin: string;
  hypothesis: string;
  status: string;               // HYPOTHESIS..RESEARCH_CANDIDATE (nooit ACTIVE)
  score: number;
  is: Metrics;
  oos: Metrics;
  walkforward: WfResult;
  robustness: RobustnessResult;
  overfitting: { flags: OverfitFlags; warnings: string[] };
  rejectionReasons: string[];
  perPair: { pair: string; netPnl: number; trades: number; winratePct: number }[];
  regimePerformance: Record<string, { trades: number; netPnl: number; winratePct: number }>;
  multiMarket: "multi-market" | "market-specific" | "insufficient";
  marketScope?: string;         // beste pair bij market-specific
  spec: unknown;
  rationale?: string;
  expected_edge?: string;
  expected_failure?: string;
}

export interface ResearchRunResult {
  run_id: string;
  type: "baseline" | "full";
  started_at: string;
  ended_at: string;
  dataset_days: number;
  pairs: string[];
  pairs_failed: string[];
  market_research: Record<string, unknown>;
  paper_failure_analysis: Record<string, unknown>;
  baseline_results: SpecResult[];
  hypotheses_generated: number;
  hypotheses_invalid: number;
  hypothesis_results: SpecResult[];
  ai: { model: string; calls: number; cost_usd: number; error?: string };
  errors: string[];
  summary: string;
}

function aggregateMetrics(trades: RTrade[], equityStart = 1000): { metrics: Metrics; equity: number[] } {
  // equity-curve uit trades opeenvolgend (voldoende voor metrics/drawdown)
  const equity: number[] = [equityStart];
  let eq = equityStart;
  for (const t of trades) { eq += t.netPnl; equity.push(eq); }
  return { metrics: computeMetrics(trades, equity, equityStart), equity };
}

/** Regime-uitsplitsing (Deel 22) per trade-regime-label. */
function regimePerformance(trades: RTrade[]): Record<string, { trades: number; netPnl: number; winratePct: number }> {
  const out: Record<string, { trades: number; netPnl: number; winratePct: number }> = {};
  for (const r of REGIMES) out[r] = { trades: 0, netPnl: 0, winratePct: 0 };
  for (const t of trades) {
    const e = out[t.regime] ?? (out[t.regime] = { trades: 0, netPnl: 0, winratePct: 0 });
    e.trades += 1;
    e.netPnl = Math.round((e.netPnl + t.netPnl) * 100) / 100;
  }
  for (const e of Object.values(out)) {
    if (e.trades) e.winratePct = Math.round((trades.filter((t) => out[t.regime] === e && t.netPnl > 0).length / e.trades) * 1000) / 10;
  }
  return out;
}

/** Volledige evaluatie van één spec over meerdere pairs. */
function evaluateSpecMulti(
  spec: StrategySpec,
  frames: Frame[]
): SpecResult {
  const splitOf = (f: Frame) => makeSplit(f.candles.length);
  const perPair: SpecResult["perPair"] = [];
  const isTradesAll: RTrade[] = [];
  const oosTradesAll: RTrade[] = [];
  const perPairNet: { pair: string; netPnl: number }[] = [];
  let wfPos = 0, wfTotal = 0;
  const wfWindows: WfResult["windows"] = [];
  let robPassSum = 0, robN = 0;
  let pertWorst = 1;

  for (const f of frames) {
    const sp = splitOf(f);
    const isBt = runPairBacktest(f, spec, { equityStart: 1000, fromIdx: sp.is.fromIdx, toIdx: sp.is.toIdx });
    const oosBt = runPairBacktest(f, spec, { equityStart: 1000, fromIdx: sp.oos.fromIdx, toIdx: sp.oos.toIdx });
    isTradesAll.push(...isBt.trades);
    oosTradesAll.push(...oosBt.trades);
    perPairNet.push({ pair: f.pair, netPnl: oosBt.trades.reduce((a, t) => a + t.netPnl, 0) });
    perPair.push({
      pair: f.pair,
      netPnl: Math.round(oosBt.trades.reduce((a, t) => a + t.netPnl, 0) * 100) / 100,
      trades: oosBt.trades.length,
      winratePct: oosBt.trades.length ? Math.round((oosBt.trades.filter((t) => t.netPnl > 0).length / oosBt.trades.length) * 1000) / 10 : 0,
    });
    const wf = walkForwardEvaluate(f, spec);
    wfPos += wf.positiveWindows;
    wfTotal += wf.totalWindows;
    wfWindows.push(...wf.windows.map((w) => ({ ...w, label: `${f.pair.replace("-EUR", "")}:${w.label}` })));
    const rob = robustnessTest(f, spec);
    robPassSum += rob.passRatio;
    robN += 1;
    const pert = perturbationTest(f, spec);
    pertWorst = Math.min(pertWorst, pert.worstRatio);
  }

  const is = aggregateMetrics(isTradesAll).metrics;
  const oos = aggregateMetrics(oosTradesAll).metrics;
  const wf: WfResult = { windows: wfWindows, positiveWindows: wfPos, totalWindows: wfTotal, consistencyPct: wfTotal ? Math.round((wfPos / wfTotal) * 100) : 0 };
  const robustness: RobustnessResult = {
    scenarios: [],
    passRatio: robN ? robPassSum / robN : 0,
    ok: robN ? robPassSum / robN >= 0.6 : false,
  };
  const { flags, warnings } = detectOverfitting({
    isMetrics: is, oosMetrics: oos, wf, perPairNet, robustness,
    perturbation: { worstRatio: pertWorst },
  });
  const evaluation = evaluateSpec({ isMetrics: is, oosMetrics: oos, wf, robustness, flags, warnings });

  // multi-market classificatie (Deel 23)
  const positivePairs = perPair.filter((p) => p.netPnl > 0 && p.trades > 0);
  const multiMarket: SpecResult["multiMarket"] =
    oos.trades === 0 ? "insufficient"
    : positivePairs.length >= Math.max(2, Math.ceil(frames.length * 0.75)) ? "multi-market"
    : "market-specific";
  const best = [...perPair].sort((a, b) => b.netPnl - a.netPnl)[0];

  return {
    name: spec.name,
    origin: spec.origin,
    hypothesis: spec.hypothesis,
    status: evaluation.status,
    score: evaluation.score,
    is, oos, walkforward: wf, robustness,
    overfitting: { flags, warnings },
    rejectionReasons: evaluation.rejectionReasons,
    perPair,
    regimePerformance: regimePerformance([...isTradesAll, ...oosTradesAll]),
    multiMarket,
    marketScope: multiMarket === "market-specific" && best ? best.pair : undefined,
    spec,
  };
}

/** Markt-samenvatting voor de AI (pure statistiek, geen geheime of gevoelige data). */
function marketResearchSummary(frames: Frame[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of frames) {
    const closes = f.candles.map((c) => c.c);
    const n = closes.length;
    const priceChangePct = Math.round((closes[n - 1] / closes[0] - 1) * 1000) / 10;
    const regimeDist: Record<string, number> = {};
    for (const r of f.regime.slice(FRAME_SKIP)) regimeDist[r] = (regimeDist[r] ?? 0) + 1;
    const volAvg = f.vol20.slice(FRAME_SKIP).reduce((a, b) => a + b, 0) / (n - FRAME_SKIP);
    out[f.pair] = {
      candles_15m: n,
      price_change_pct: priceChangePct,
      avg_volatility_pct_20: Math.round(volAvg * 100) / 100,
      regime_distribution: regimeDist,
      high24h_last: f.high24h[n - 1],
      low24h_last: f.low24h[n - 1],
    };
  }
  return out;
}
const FRAME_SKIP = 220;

/** Foutanalyse van de bestaande paper-strategieën (read-only, Deel 24). */
async function paperFailureAnalysis(): Promise<Record<string, unknown>> {
  try {
    const since = new Date(Date.now() - 14 * 86400_000).toISOString();
    const orders = await listOrdersSince(since);
    const exits = orders.filter((o) => o.pnl_eur !== null);
    const by = new Map<string, { trades: number; wins: number; net: number; holdSum: number; reasons: Record<string, number> }>();
    for (const o of exits) {
      const st = String(o.strategy ?? "onbekend");
      const e = by.get(st) ?? { trades: 0, wins: 0, net: 0, holdSum: 0, reasons: {} };
      e.trades += 1;
      if ((o.pnl_eur ?? 0) > 0) e.wins += 1;
      e.net += o.pnl_eur ?? 0;
      e.holdSum += (o as { context?: { hold_min?: number } }).context?.hold_min ?? 0;
      e.reasons[o.reason] = (e.reasons[o.reason] ?? 0) + 1;
      by.set(st, e);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of by) {
      out[k] = {
        trades: v.trades,
        winrate_pct: v.trades ? Math.round((v.wins / v.trades) * 1000) / 10 : 0,
        net_eur: Math.round(v.net * 100) / 100,
        avg_hold_min: v.trades ? Math.round(v.holdSum / v.trades) : 0,
        exit_reasons: v.reasons,
      };
    }
    out._note = "paper-trading foutanalyse laatste 14 dagen (échte paper-trades, incl. fees)";
    return out;
  } catch (e) {
    return { error: String(e instanceof Error ? e.message : e), _note: "paper-data onbeschikbaar — alleen backtest-baselines" };
  }
}

/**
 * De volledige research-run. mode="baseline" → alleen baselines;
 * mode="full" → baselines + AI-hypotheses (begrensd door het research-budget).
 */
export async function runResearchPipeline(opts: {
  mode: "baseline" | "full";
  requestedBy?: string;
}): Promise<ResearchRunResult> {
  const runId = `research-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const errors: string[] = [];

  const job = await createJob(opts.mode === "full" ? "ai-research" : "baseline-research", opts.requestedBy ?? "elara");

  // ── 1. data + frames ──────────────────────────────────────────────────
  const { ok: datasets, failed } = await getDatasets(PAIRS);
  if (failed.length) errors.push(`data onbeschikbaar: ${failed.join("; ")}`);
  const frames: Frame[] = datasets.map((d: PairDataset) => buildFrame(d.pair, d.c15, d.c1h));

  const market = marketResearchSummary(frames);
  const paper = await paperFailureAnalysis();

  // ── 2. baselines (Deel 7 — zelfde data, fees, slippage, executie) ─────
  const baselineResults: SpecResult[] = [];
  for (const b of baselines()) {
    const v = validateSpec(b);
    if (!v.ok) { errors.push(`baseline ${String((b as { name?: string }).name)} ongeldig: ${v.errors.join(", ")}`); continue; }
    baselineResults.push(evaluateSpecMulti(v.spec, frames));
  }

  // ── 3. AI-hypotheses (alleen mode=full, begrensd budget) ──────────────
  const hypothesisResults: SpecResult[] = [];
  let hypothesesGenerated = 0;
  let hypothesesInvalid = 0;
  const ai = { model: RESEARCH_MODEL, calls: 0, cost_usd: 0, error: undefined as string | undefined };

  if (opts.mode === "full") {
    const budget = await researchBudgetOk(0);
    if (!budget.ok) {
      ai.error = budget.reason;
      errors.push(`AI-research overgeslagen: ${budget.reason}`);
    } else if (!process.env.ANTHROPIC_API_KEY) {
      ai.error = "geen ANTHROPIC_API_KEY";
    } else {
      // context voor de AI: alleen publieke marktdata + metrics (geen secrets)
      const ctx = JSON.stringify({
        note: "Onderzoekssamenvatting. Fees/slippage in backtests: " +
          `fee ${FEE_PCT}% per kant, slippage ${SLIPPAGE_PCT}% per kant, round-trip ≈ ${roundTripCostPct().toFixed(2)}%.`,
        dataset_days: RESEARCH_15M_DAYS,
        market_research: market,
        baselines_is_oos: baselineResults.map((r) => ({
          name: r.name,
          is: { trades: r.is.trades, winratePct: r.is.winratePct, netPnl: r.is.netPnl, expectancyEur: r.is.expectancyEur },
          oos: { trades: r.oos.trades, winratePct: r.oos.winratePct, netPnl: r.oos.netPnl, expectancyEur: r.oos.expectancyEur },
          wfConsistencyPct: r.walkforward.consistencyPct,
          rejection: r.rejectionReasons,
        })),
        paper_failure_analysis: paper,
        news_momentum_note: newsMomentumNote(),
      });
      try {
        const gen = await generateHypotheses(ctx);
        ai.calls += 1;
        ai.cost_usd += gen.usage?.costUsd ?? 0;
        hypothesesGenerated = gen.hypotheses.length;
        if (gen.error && !gen.hypotheses.length) { ai.error = gen.error; errors.push(`AI-research: ${gen.error}`); }
        for (const h of gen.hypotheses) {
          if (h.validationErrors) {
            hypothesesInvalid += 1;
            const nm = (h.spec as { name?: string })?.name ?? "zonder naam";
            errors.push(`hypothese ongeldig (${nm}): ${h.validationErrors.join(", ")}`);
            errors.push(`RAW ${nm}: ${h.raw ?? "?"}`);
            continue;
          }
          const res = evaluateSpecMulti(h.spec as StrategySpec, frames);
          res.rationale = h.rationale;
          res.expected_edge = h.expected_edge;
          res.expected_failure = h.expected_failure;
          hypothesisResults.push(res);
        }
      } catch (e) {
        ai.error = String(e instanceof Error ? e.message : e);
        errors.push(`AI-research: ${ai.error}`);
      }
    }
  }

  // ── 4. resultaten wegschrijven (best effort — research breekt nooit op DB) ──
  const allResults = [...baselineResults, ...hypothesisResults];
  for (const r of allResults) {
    await insertCandidate({
      strategy_id: `${r.name}-${runId}`,
      name: r.name,
      version: 1,
      status: r.status,
      origin: r.origin,
      hypothesis: r.hypothesis,
      specification: r.spec,
      researcher_model: r.origin === "ai-research" ? RESEARCH_MODEL : null,
      dataset_days: RESEARCH_15M_DAYS,
      pairs: frames.map((f) => f.pair),
      timeframe: "15m",
      is_metrics: r.is,
      oos_metrics: r.oos,
      walkforward: r.walkforward,
      robustness: r.robustness,
      overfitting_flags: r.overfitting.flags,
      regime_performance: r.regimePerformance,
      per_pair: r.perPair,
      fee_assumptions_pct: FEE_PCT,
      slippage_assumptions_pct: SLIPPAGE_PCT,
      sample_size: r.oos.trades,
      score: r.score,
      rejection_reasons: r.rejectionReasons,
      research_explanation: [
        r.rationale ?? "",
        `IS: ${r.is.trades} trades, wr ${r.is.winratePct}%, net €${r.is.netPnl}, expectancy €${r.is.expectancyEur}.`,
        `OOS: ${r.oos.trades} trades, wr ${r.oos.winratePct}%, net €${r.oos.netPnl}, expectancy €${r.oos.expectancyEur}, PF ${r.oos.profitFactor}, maxDD ${r.oos.maxDrawdownPct}%.`,
        `Walk-forward: ${r.walkforward.positiveWindows}/${r.walkforward.totalWindows} positief (${r.walkforward.consistencyPct}%).`,
        `Robustness pass-ratio ${(r.robustness.passRatio * 100).toFixed(0)}%; fee-fragiel: ${r.overfitting.flags.fee_fragile ? "JA" : "nee"}.`,
        r.overfitting.warnings.length ? `Waarschuwingen: ${r.overfitting.warnings.join("; ")}` : "Geen overfitting-waarschuwingen.",
        r.expected_edge ? `Verwachte bevestiging: ${r.expected_edge}` : "",
        r.expected_failure ? `Verwachte falsificatie: ${r.expected_failure}` : "",
      ].filter(Boolean).join(" "),
    });
  }

  const endedAt = new Date().toISOString();
  const candidates = allResults.filter((r) => r.status === "RESEARCH_CANDIDATE").length;
  const rejected = allResults.filter((r) => r.status === "REJECTED").length;
  const insufficient = allResults.filter((r) => r.status === "INSUFFICIENT_DATA").length;
  await insertRun({
    run_id: runId,
    type: opts.mode,
    started_at: startedAt,
    ended_at: endedAt,
    model: ai.calls ? ai.model : null,
    ai_calls: ai.calls,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd_est: ai.cost_usd,
    dataset_days: RESEARCH_15M_DAYS,
    pairs: frames.map((f) => f.pair),
    strategies_tested: allResults.length,
    hypotheses_generated: hypothesesGenerated,
    candidates_found: candidates,
    rejected,
    insufficient_data: insufficient,
    errors,
  });

  const summary = `${allResults.length} strategieën getest: ${candidates} candidate(s), ${rejected} rejected, ${insufficient} insufficient.` +
    (ai.error ? ` AI: ${ai.error}.` : "") +
    (errors.length ? ` Fouten: ${errors.slice(0, 3).join("; ")}` : "");
  await finishJob(job, errors.length && !allResults.length ? "failed" : "completed", summary);

  return {
    run_id: runId,
    type: opts.mode,
    started_at: startedAt,
    ended_at: endedAt,
    dataset_days: RESEARCH_15M_DAYS,
    pairs: frames.map((f) => f.pair),
    pairs_failed: failed,
    market_research: market,
    paper_failure_analysis: paper,
    baseline_results: baselineResults,
    hypotheses_generated: hypothesesGenerated,
    hypotheses_invalid: hypothesesInvalid,
    hypothesis_results: hypothesisResults,
    ai,
    errors,
    summary,
  };
}
