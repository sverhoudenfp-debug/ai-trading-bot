// ── FASE 3: de evolution-cycle (orchestrator, Deel 30/42) ────────────────
// Één gecontroleerde cyclus:
//   PARENT (rsi-dip-richting) + research-results + paper-fouten + learn-weights
//   → AI stelt ≤3 MUTATIONS voor (data-only, gevalideerd)
//   → VOLLEDIGE research-pipeline per mutatie (IS → OOS → WF → robustness → evaluator)
//   → VALIDATION GATE (pure code, incl. fee-aware baseline-vergelijking)
//   → registry (immutable versie, parent-link, audit)
//   → bij succes: PAPER_CANDIDATE → max ÉÉN canary PAPER_ACTIVE (atoom)
//   → géén kandidaat is een valide, eerlijke uitkomst (Deel 31)
// LIVE trading bestaat in geen enkele stap van deze cyclus.

import { StrategySpec, validateSpec } from "@/lib/research/spec";
import { prepareDataset, evaluateSpecsOnDataset, SpecResult } from "@/lib/research/researcher";
import { proposeMutations, specSignature, MutationProposal } from "./mutate";
import { runValidationGate, BaselineMetrics, GateVerdict } from "./gate";
import { registerVersion, activateCanary, ActivationCheck } from "./registry";
import { activePaperStrategies, RegistryRow, writeAudit, transitionStatus, insertRegistryRow, listRegistry } from "./db";
import { currentLearnWeights } from "./selection";
import { insertCandidate } from "@/lib/research/db";
import { listOrdersSince } from "@/lib/paper/store";
import type { Metrics } from "@/lib/research/backtest";

export interface MutationOutcome {
  name: string;
  parent: string;
  changedWhat: string;
  why: string;
  expectedImprovement: string;
  failureCriteria: string;
  valid: boolean;
  validationErrors?: string[];
  duplicate?: boolean;
  research?: SpecResult;
  gate?: GateVerdict;
  registryId?: number;
  status?: string;
}

export interface EvolutionRunResult {
  run_id: string;
  started_at: string;
  ended_at: string;
  parent: { name: string; family: string };
  mutations_proposed: number;
  mutations_invalid: number;
  mutations_duplicate: number;
  outcomes: MutationOutcome[];
  candidate_found: boolean;
  candidate_name?: string;
  gate_blockers?: string[];
  activation?: { ok: boolean; error?: string; blockers?: string[]; activated_id?: number };
  ai: { calls: number; cost_usd: number; error?: string };
  registry_blocked_reason?: string;
  summary: string;
}

export interface ParentContext {
  name: string;                       // bijv. "baseline-rsi-dip"
  legacyStrategyId: string;           // bijv. "rsi-dip" (AI/learning-naam)
  family: string;                     // bijv. "RSI-MEAN-REVERSION"
  version: string;                    // "1.0.0"
  spec: StrategySpec;                  // de spec zoals in de baseline-run
  researchResult: SpecResult;         // metrics van de baseline-run
  parentVersionNext: number;          // eerste mutatie-versie (bijv. 2)
}

/**
 * Draai één evolution-cycle rond de gegeven parent-context.
 * `dataset`/`frames` worden hergebruikt als al klaargezeteld (script gebruikt
 * de cache; de API-route haalt zelf data).
 */
export async function runEvolutionCycle(
  parent: ParentContext,
  opts: { requestedBy: string }
): Promise<EvolutionRunResult> {
  const runId = `evo-${Date.now()}`;
  const startedAt = new Date().toISOString();

  // ── 0. bestaande productie-strategieën als LEGACY-benchmark seeden ────
  // (Deel 29: niets verwijderen; de 5 live strategieën krijgen een
  //  registry-rij als benchmark/audit-anker. Idempotent.)
  await seedLegacyBenchmarks(opts.requestedBy);

  const ai = { calls: 0, cost_usd: 0, error: undefined as string | undefined };

  // ── 1. context: paper-fouten (read-only) + learn-weights ──────────────
  let paperCtx: unknown = { note: "geen paper-data beschikbaar" };
  try {
    const since = new Date(Date.now() - 14 * 86400_000).toISOString();
    const orders = await listOrdersSince(since);
    const exits = orders.filter((o) => o.pnl_eur !== null);
    const by = new Map<string, { trades: number; wins: number; net: number }>();
    for (const o of exits) {
      const st = String(o.strategy ?? "onbekend");
      const e = by.get(st) ?? { trades: 0, wins: 0, net: 0 };
      e.trades += 1;
      if ((o.pnl_eur ?? 0) > 0) e.wins += 1;
      e.net += o.pnl_eur ?? 0;
      by.set(st, e);
    }
    paperCtx = Object.fromEntries([...by].map(([k, v]) => [k, { trades: v.trades, winratePct: Math.round((v.wins / v.trades) * 1000) / 10, netEur: Math.round(v.net * 100) / 100 }]));
  } catch { /* read-only, mag leeg blijven */ }
  const learnWeights = await currentLearnWeights();

  // ── 2. AI-mutaties ────────────────────────────────────────────────────
  const researchCtx = {
    is: pickMetrics(parent.researchResult.is),
    oos: pickMetrics(parent.researchResult.oos),
    wf: { positive: parent.researchResult.walkforward.positiveWindows, total: parent.researchResult.walkforward.totalWindows },
    robustnessPassRatio: parent.researchResult.robustness.passRatio,
    overfitting: parent.researchResult.overfitting,
    perPair: parent.researchResult.perPair,
    regimePerformance: parent.researchResult.regimePerformance,
    rejectionReasons: parent.researchResult.rejectionReasons,
  };
  const mut = await proposeMutations(parent.legacyStrategyId, parent.spec, researchCtx, paperCtx, learnWeights);
  ai.calls += mut.ok ? 1 : 1;
  ai.cost_usd += mut.usage?.costUsd ?? 0;
  if (mut.error && !mut.proposals.length) ai.error = mut.error;

  // ── 3. validatie + duplicaat-filter ──────────────────────────────────
  const validSpecs: { proposal: MutationProposal }[] = [];
  const outcomes: MutationOutcome[] = [];
  const activeRows = await activePaperStrategies();
  const activeSignatures = new Set(
    activeRows.map((r) => {
      try {
        const spec = typeof r.specification === "string" ? JSON.parse(r.specification) : r.specification;
        return specSignature(spec as StrategySpec);
      } catch { return ""; }
    }).filter(Boolean)
  );

  for (const p of mut.proposals) {
    const base = {
      name: String((p.spec as { name?: string } | undefined)?.name ?? "onbekend"),
      parent: `${parent.name} (${parent.legacyStrategyId} v${parent.version})`,
      changedWhat: p.changedWhat,
      why: p.why,
      expectedImprovement: p.expectedImprovement,
      failureCriteria: p.failureCriteria,
    };
    if (p.validationErrors) {
      outcomes.push({ ...base, valid: false, validationErrors: p.validationErrors });
      continue;
    }
    const spec = p.spec as StrategySpec;
    const sig = specSignature(spec);
    if (activeSignatures.has(sig)) {
      outcomes.push({ ...base, valid: true, duplicate: true });
      activeSignatures.add(sig); // ook onderling dedupe
      continue;
    }
    activeSignatures.add(sig);
    validSpecs.push({ proposal: { ...p, spec } });
    outcomes.push({ ...base, valid: true });
  }

  // ── 4. research-pipeline over de mutaties ────────────────────────────
  let frames: Awaited<ReturnType<typeof prepareDataset>>["frames"] = [];
  if (validSpecs.length) {
    const prep = await prepareDataset();
    frames = prep.frames;
    const results = await evaluateSpecsOnDataset(validSpecs.map((v) => v.proposal.spec), frames);
    validSpecs.forEach((v, i) => {
      v.proposal.spec = results[i] ? v.proposal.spec : v.proposal.spec; // type-stabiliteit
      (v as { result?: SpecResult }).result = results[i];
    });
  }

  // ── 5. validation gate per mutatie ───────────────────────────────────
  const baseline: BaselineMetrics = {
    name: `${parent.name} (parent)`,
    oos: parent.researchResult.oos,
  };
  let winner: { outcomeIdx: number; row: RegistryRow | null; verdict: GateVerdict; result: SpecResult; spec: StrategySpec } | null = null;
  const gateBlockersAll: string[] = [];

  validSpecs.forEach((v, i) => {
    const result = (v as { result?: SpecResult }).result;
    if (!result) return;
    const outcome = outcomes.find((o) => o.name === result.name) ?? outcomes[validSpecs.indexOf(v)];
    outcome.research = result;
    const verdict = runValidationGate(
      {
        isMetrics: result.is, oosMetrics: result.oos, walkforward: result.walkforward,
        robustness: result.robustness, overfitting: result.overfitting,
        perPair: result.perPair, score: result.score, status: result.status,
        feeScenarios: result.robustness.scenarios,
      },
      baseline
    );
    outcome.gate = verdict;
    outcome.status = verdict.passed ? "PAPER_CANDIDATE (gate geslaagd)" : `REJECTED (gate: ${verdict.reasons[0] ?? "onvoldoende bewees"})`;
    if (!verdict.passed) gateBlockersAll.push(`${result.name}: ${verdict.reasons.slice(0, 2).join("; ")}`);
  });

  // ── 6. registry (immutable versies + audit) ──────────────────────────
  let version = parent.parentVersionNext;
  for (const v of validSpecs) {
    const result = (v as { result?: SpecResult }).result;
    if (!result) continue;
    const spec = v.proposal.spec;
    // ook als research-candidate opslaan (research_candidates-tabel, Fase 2)
    await insertCandidate({
      strategy_id: `${spec.name}-${runId}`,
      name: spec.name,
      version,
      status: result.status,
      origin: "mutation",
      hypothesis: spec.hypothesis,
      specification: spec,
      researcher_model: "claude-haiku-4-5",
      dataset_days: 180,
      pairs: spec.pairs,
      timeframe: "15m",
      is_metrics: result.is,
      oos_metrics: result.oos,
      walkforward: result.walkforward,
      robustness: result.robustness,
      overfitting_flags: result.overfitting.flags,
      regime_performance: result.regimePerformance,
      per_pair: result.perPair,
      fee_assumptions_pct: 0.25,
      slippage_assumptions_pct: 0.05,
      sample_size: result.oos.trades,
      score: result.score,
      rejection_reasons: result.rejectionReasons,
      research_explanation: `MUTATIE van ${parent.name}: ${v.proposal.changedWhat}. Waarom: ${v.proposal.why}. Verwachte verbetering: ${v.proposal.expectedImprovement}. Falsificatie: ${v.proposal.failureCriteria}.`,
    });
    const gatePassed = outcomes.find((o) => o.name === result.name)?.gate?.passed ?? false;
    const row = await registerVersion({
      strategyId: spec.name,
      family: parent.family,
      version: `${version}.0.0`,
      parentStrategyId: parent.legacyStrategyId,
      parentVersion: parent.version,
      originCandidateId: null,
      researchRunId: runId,
      spec,
      hypothesis: spec.hypothesis,
      score: result.score,
      researchMetrics: {
        is: result.is, oos: result.oos, walkforward: result.walkforward,
        robustness: result.robustness, overfitting: result.overfitting.flags,
        regime_performance: result.regimePerformance, per_pair: result.perPair,
        gate: outcomes.find((o) => o.name === result.name)?.gate ?? null,
      },
      initialStatus: gatePassed ? "RESEARCH_CANDIDATE" : result.status === "INSUFFICIENT_DATA" ? "INSUFFICIENT_DATA" : "REJECTED",
      performedBy: opts.requestedBy,
    });
    const outcome = outcomes.find((o) => o.name === result.name);
    if (outcome) outcome.registryId = row?.id ?? undefined;

    // gate geslaagd → VALIDATION_PENDING → PAPER_CANDIDATE (auditbare stappen)
    if (row && gatePassed) {
      const t1 = await transitionStatus(row.id, "RESEARCH_CANDIDATE", "VALIDATION_PENDING", {}, {
        reason: "validation gate gepland", performed_by: opts.requestedBy, action: "validate",
      });
      if (t1.ok) {
        await transitionStatus(row.id, "VALIDATION_PENDING", "PAPER_CANDIDATE", {}, {
          reason: "VALIDATION GATE GESlaagd — alle harde criteria voldaan", performed_by: opts.requestedBy, action: "validate_pass",
        });
        if (!winner || result.score > (winner.result.score)) {
          winner = { outcomeIdx: -1, row: { ...row, status: "PAPER_CANDIDATE" } as RegistryRow, verdict: outcomes.find((o) => o.name === result.name)!.gate!, result, spec };
        }
      }
    }
    version += 1;
  }

  // ── 7. canary-activatie (max één, alleen als de registry leeft) ──────
  let activation: EvolutionRunResult["activation"];
  let registryBlocked: string | undefined;
  if (winner && winner.row) {
    const act = await activateCanary(winner.row, `Eerste evolution-cycle ${runId}: gate geslaagd (score ${winner.result.score}) — PAPER CANARY`, opts.requestedBy);
    activation = act.ok
      ? { ok: true, activated_id: act.row?.id }
      : { ok: false, error: act.error, blockers: act.blockers ?? [] };
    if (!act.ok && (act.error ?? "").includes("niet geconfigureerd")) registryBlocked = "strategy_registry-tabellen bestaan nog niet — draai supabase-phase3-setup.sql (fail-closed: géén activatie, research-resultaten zijn bewaard)";
  }

  const endedAt = new Date().toISOString();
  const invalid = outcomes.filter((o) => !o.valid).length;
  const dupl = outcomes.filter((o) => o.duplicate).length;
  const summary = winner
    ? `${outcomes.length} mutaties: kandidaat ${winner.spec.name} door de gate; activatie ${activation?.ok ? "PAPER_ACTIVE (canary)" : "geblokkeerd"}`
    : `${outcomes.length} mutaties onderzocht, géén kandidaat door de gate — NO VALID CANDIDATE (eerlijk resultaat)`;

  return {
    run_id: runId, started_at: startedAt, ended_at: endedAt,
    parent: { name: parent.name, family: parent.family },
    mutations_proposed: mut.proposals.length,
    mutations_invalid: invalid,
    mutations_duplicate: dupl,
    outcomes,
    candidate_found: Boolean(winner),
    candidate_name: winner?.spec.name,
    gate_blockers: gateBlockersAll,
    activation,
    ai,
    registry_blocked_reason: registryBlocked,
    summary,
  };
}

const LEGACY_STRATEGIES = [
  { id: "rsi-dip", family: "RSI-MEAN-REVERSION", hypothesis: "koopt de verse RSI-dip boven EMA-200 (analyse-agent regel-kern)" },
  { id: "pullback", family: "PULLBACK", hypothesis: "koopt de terugval naar EMA-50 in uptrend (AI-voorstel)" },
  { id: "breakout", family: "BREAKOUT", hypothesis: "koopt de breakout boven 24u-high (AI-voorstel)" },
  { id: "news-momentum", family: "NEWS-MOMENTUM", hypothesis: "rijdt positief nieuws-momentum (AI-voorstel)" },
  { id: "rsi-fade-short", family: "RSI-FADE", hypothesis: "short de overbought bounce in downtrend (AI-voorstel, long-only engine: uit)" },
];

/** Bestaande strategieën als LEGACY registreren — NEVER removable, alleen benchmark. */
export async function seedLegacyBenchmarks(performedBy: string): Promise<void> {
  const existing = await listRegistry(200);
  for (const l of LEGACY_STRATEGIES) {
    if (existing.some((r) => r.strategy_id === l.id && r.is_legacy)) continue;
    const row = await insertRegistryRow({
      strategy_id: l.id, family: l.family, version: "1.0.0",
      specification: null, hypothesis: l.hypothesis, score: null,
      status: "LEGACY", canary: false, is_legacy: true,
    });
    if (row) {
      await writeAudit({
        registry_id: row.id, action: "register", from_status: null, to_status: "LEGACY",
        reason: `bestaande productie-strategie als benchmark gemarkeerd (geen code, geen spec — rule-based)`,
        performed_by: performedBy, metrics_at: null,
      });
    }
  }
}

function pickMetrics(m: Metrics) {
  return {
    trades: m.trades, winratePct: m.winratePct, netPnl: m.netPnl, grossPnl: m.grossPnl,
    fees: m.fees, expectancyEur: m.expectancyEur, profitFactor: m.profitFactor,
    maxDrawdownPct: m.maxDrawdownPct, avgHoldMin: m.avgHoldMin,
    maxLossStreak: m.maxLossStreak,
  };
}
