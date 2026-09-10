// ── FASE 3: AI-mutaties van bestaande strategieën (Deel 15-16) ──────────
// De AI mag een parent-spec verbeteren door een NIEUWE immutable versie
// voor te stellen — als data (StrategySpec), nooit als code. Elke mutatie:
//   • geeft parent + wat/waarom + verwachte verbetering + misluk-criterium;
//   • wordt strikt gevalideerd (whitelist + normalisatie);
//   • gaat door de VOLLEDIGE research-pipeline (IS/OOS/WF/robustness) —
//     nooit rechtstreeks naar paper;
//   • bijna-identieke specs (zelfde signature) worden als duplicaat afgewezen
//     (family-control, Deel 15).
// De AI beslist niets over activering — dat doet de gate + registry (code).

import { callClaude } from "@/lib/agents/anthropic";
import { validateSpec, StrategySpec } from "@/lib/research/spec";
import { normalizeSpecDraft } from "@/lib/research/normalize";
import { MAX_MUTATIONS_PER_CYCLE } from "./config";
import { researchBudgetOk, RESEARCH_MODEL } from "@/lib/research/hypothesis";

export interface MutationProposal {
  spec: StrategySpec;
  parentStrategyId: string;
  parentVersion: string;
  changedWhat: string;
  why: string;
  expectedImprovement: string;
  failureCriteria: string;
  validationErrors?: string[];
}

export interface MutationCallResult {
  ok: boolean;
  proposals: (Omit<MutationProposal, "spec"> & { spec?: unknown; validationErrors?: string[] })[];
  usage?: { costUsd: number };
  error?: string;
}

/** Kanonieke signature van een spec voor bijna-duplicaat-detectie. */
export function specSignature(spec: StrategySpec): string {
  const norm = (v: unknown) =>
    typeof v === "number" ? Math.round(v * 100) / 100 : v;
  return JSON.stringify({
    d: spec.direction,
    e: spec.entry_conditions.map((c) => [c.kind, norm(c.value), c.period, c.period2, c.bars]),
    x: spec.exit_conditions.map((c) => [c.kind, norm(c.value), c.period, c.period2, c.bars]),
    sl: norm(spec.stop_loss_pct), tp: norm(spec.take_profit_pct),
    h: spec.max_hold_bars, f: spec.filters ?? null,
  });
}

const MUTATION_SYSTEM = `You are the Mutation Advisor of a scientific crypto-strategy evolution engine (PAPER ONLY — no live trading, no code execution).

You receive a parent strategy specification (data, not code), its full research results (in-sample, out-of-sample, walk-forward, robustness, overfitting flags, per-coin, per-regime), live paper failure analysis, and the current learning weights. Propose up to MAX mutations — REFINEMENTS of the parent, each as a NEW StrategySpec (same whitelist, same JSON schema).

SCIENTIFIC MINDSET:
- Fees+slippage (~0.60% round-trip) killed the parent variants: every mutation must REDUCE fee pressure (fewer, higher-quality trades or clearly bigger expected moves).
- A mutation must have ONE clear rationale tied to the parent's actual failure mode.
- Prefer small, testable changes over rewrites.
- If no promising mutation exists, return an empty list — that is a fine answer.

RULES (STRICT — invalid specs are hard-rejected by the validator):
- name: NEW kebab-case slug (3-40 chars), different from the parent name
- keep pairs within the parent's pair list or a subset (max 4 pairs)
- EVERY field exactly like the parent spec's JSON schema, INCLUDING "origin": "ai-research" (no other origin value is accepted)
- entry_conditions: max 4 objects, ONLY these kinds (nothing else exists — invented kinds are rejected):
  rsi_lt, rsi_gt, rsi_cross_under, rsi_cross_over, price_above_ema, price_below_ema,
  ema_above_ema, ema_below_ema, mom_gt, mom_lt, dist_ema50_between, dist_ema200_gt,
  dist_ema200_lt, breakout_24h, breakdown_24h, volume_gt_sma, trend1h, volatility_gt, volatility_lt
- exit_conditions: max 3 objects, same kinds; SL/TP/max_hold exits are added by the engine
- optional "filters": min_volatility_pct, max_volatility_pct, require_trend1h, min_volume_z
- stop_loss_pct 1-10; take_profit_pct must stay ≥ 1.5 (fee-guard); max_hold_bars 4-192; risk_pct 0.25-1.0
- text fields SHORT (description ≤ 280 chars)

OUTPUT — JSON only, exact schema:
{"mutations":[{"spec":{...StrategySpec zoals de parent, met origin:"mutation"...},"changedWhat":"...","why":"...","expectedImprovement":"...","failureCriteria":"wat resultaat falsificeert deze mutatie"}]}`;

export async function proposeMutations(
  parentName: string,
  parentSpec: StrategySpec,
  researchContext: unknown,
  paperContext: unknown,
  learnWeights: Record<string, number>
): Promise<MutationCallResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, proposals: [], error: "geen ANTHROPIC_API_KEY" };
  const budget = await researchBudgetOk(0);
  if (!budget.ok) return { ok: false, proposals: [], error: budget.reason };

  const user = JSON.stringify({
    max_mutations: MAX_MUTATIONS_PER_CYCLE,
    parent_name: parentName,
    parent_spec: parentSpec,
    parent_research: researchContext,
    paper_failure_analysis: paperContext,
    learning_weights: learnWeights,
    fee_note: "fee 0.25% + slippage 0.05% per zijde; round-trip 0.60%; TP moet ≥ 2,5× round-trip zijn",
  });

  try {
    const res = await callClaude(MUTATION_SYSTEM.replace("MAX", String(MAX_MUTATIONS_PER_CYCLE)), user, 3000);
    let parsed: unknown;
    const text = res.text;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("geen JSON");
    parsed = JSON.parse(text.slice(start, end + 1));
    const arr = (parsed as { mutations?: unknown[] })?.mutations;
    if (!Array.isArray(arr)) throw new Error("geen mutations-array");
    const proposals: MutationCallResult["proposals"] = [];
    for (const raw of arr.slice(0, MAX_MUTATIONS_PER_CYCLE)) {
      const m = raw as { spec?: unknown; changedWhat?: string; why?: string; expectedImprovement?: string; failureCriteria?: string };
      const draft = normalizeSpecDraft(m.spec);
      const v = validateSpec(draft);
      proposals.push({
        spec: v.ok ? v.spec : draft,
        parentStrategyId: parentName,
        parentVersion: "1.0",
        changedWhat: m.changedWhat ?? "",
        why: m.why ?? "",
        expectedImprovement: m.expectedImprovement ?? "",
        failureCriteria: m.failureCriteria ?? "",
        validationErrors: v.ok ? undefined : v.errors,
      });
    }
    return { ok: proposals.some((p) => !p.validationErrors), proposals, usage: { costUsd: res.costUsd } };
  } catch (e) {
    return { ok: false, proposals: [], error: String(e instanceof Error ? e.message : e) };
  }
}

export const MUTATION_MODEL = RESEARCH_MODEL;
