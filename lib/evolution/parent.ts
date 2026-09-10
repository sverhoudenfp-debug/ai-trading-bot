// ── FASE 3: parent-context voor de eerste evolution-cycles ──────────────
// De parent is de meestbelovende Fase-2-richting: baseline-rsi-dip (de
// ENIGE baseline met positief netto in IS ÉN OOS — fee-fragiel, dus precies
// waar mutatie iets te halen heeft). De parent-metrics worden VERS
// herberekend op de actuele dataset (180d, 8 pairs) — geen verzonnen
// of verouderde cijfers.

import { baselines } from "@/lib/research/baselines";
import { prepareDataset, evaluateSpecsOnDataset, SpecResult } from "@/lib/research/researcher";
import type { StrategySpec } from "@/lib/research/spec";
import type { ParentContext } from "./evolution";

export const PARENT_FAMILY = "RSI-MEAN-REVERSION";
export const PARENT_LEGACY_ID = "rsi-dip"; // naam in de AI-prompt + learning-weights

/**
 * Laadt de parent: baseline-rsi-dip-spec + verse metrics op de dataset.
 * Retourneert null als de dataset niet beschikbaar is (fail-closed).
 */
export async function loadParentContext(): Promise<ParentContext | null> {
  const spec = baselines().find((b) => b.name === "baseline-rsi-dip");
  if (!spec) return null;
  const { frames } = await prepareDataset();
  if (!frames.length) return null;
  const [result] = await evaluateSpecsOnDataset([spec as StrategySpec], frames);
  if (!result) return null;
  return {
    name: spec.name,
    legacyStrategyId: PARENT_LEGACY_ID,
    family: PARENT_FAMILY,
    version: "1.0.0",
    spec: spec as StrategySpec,
    researchResult: result as SpecResult,
    parentVersionNext: 2, // eerste mutatie = 2.0.0
  };
}
