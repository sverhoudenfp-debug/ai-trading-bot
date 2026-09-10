// ── FASE 3: deterministische strategy-selectie ─────────────────────────
// DEEL 19 — gecombineerde score (gedocumenteerd):
//   soft = (0,45·researchScore + 0,35·paperScore + 0,20·regimeFit) × learnWeight
//   researchScore: gate-score uit de research-evaluatie (0-100, genormaliseerd)
//   paperScore:    50 + 50·tanh(netto/€10) uit live paper-metrics (0-100)
//   regimeFit:     1 als de strategie in dit regime backtest-positief was,
//                  0 als backtest-negatief met voldoende steekproef;
//                  anders 0,5 met INSUFFICIENT_REGIME_DATA-label
//   learnWeight:   bestaande strategy_versions-gewichten (0,5-1,6) — kan
//                  alléén dempen of licht versterken, NIET over harde
//                  gates/statussen/risk-limieten heen.
// DEEL 26 — conflicten (meerdere strategieën, tegengestelde kant op één
// pair): deterministisch: (1) hoogste soft-score, (2) bij gelijke score
// wint de langst-actieve (senioriteit), (3) canary heeft NOOIT voorrang op
// legacy. De AI beslist hier niets van.

import { RegistryRow } from "./db";
import { WEIGHT_RESEARCH, WEIGHT_PAPER, WEIGHT_REGIME, MIN_REGIME_TRADES } from "./config";
import { getActiveWeights, StrategyWeights } from "@/lib/agents/learn";
import type { PaperMetrics } from "./monitor";

export interface CandidateProposal {
  row: RegistryRow;
  side: "buy" | "sell";
  softScore: number;
  paperScore: number;
  regimeFit: number;
  regimeLabel: string;
  learnWeight: number;
}

export function paperScoreFrom(m: PaperMetrics | null): number {
  if (!m || m.trades === 0) return 50; // neutraal zolang er geen paper-data is
  const raw = 50 + 50 * Math.tanh(m.netPnl / 10);
  return Math.round(Math.max(0, Math.min(100, raw)));
}

export interface RegimePerf { trades: number; netPnl: number }

export function regimeFitFrom(
  regimePerformance: Record<string, RegimePerf> | null | undefined,
  currentRegime: string
): { fit: number; label: string } {
  const perf = regimePerformance?.[currentRegime];
  if (!perf || perf.trades < MIN_REGIME_TRADES) {
    return { fit: 0.5, label: `INSUFFICIENT_REGIME_DATA (${currentRegime}, ${perf?.trades ?? 0}/${MIN_REGIME_TRADES} backtest-trades — geen agressieve regime-switch)` };
  }
  return perf.netPnl > 0
    ? { fit: 1, label: `regime-fit ${currentRegime}: backtest +€${perf.netPnl}` }
    : { fit: 0, label: `regime-misfit ${currentRegime}: backtest −€${Math.abs(perf.netPnl)} → geen entry (deterministisch)` };
}

export function softScore(args: {
  researchScore: number; paperScore: number; regimeFit: number; learnWeight: number;
}): number {
  const s = (WEIGHT_RESEARCH * args.researchScore + WEIGHT_PAPER * args.paperScore + WEIGHT_REGIME * (args.regimeFit * 100)) * args.learnWeight;
  return Math.round(s * 100) / 100;
}

export async function currentLearnWeights(): Promise<StrategyWeights> {
  try {
    const w = await getActiveWeights();
    return w?.stats ? Object.fromEntries(w.stats.map((s) => [s.strategy, s.weight])) : {};
  } catch { return {}; }
}

/**
 * Conflictoplossing: gegeven alle proposals voor één pair (mogelijk
 * tegengestelde kanten), kies er deterministisch ÉÉN (of geen).
 */
export function resolveConflicts(proposals: CandidateProposal[]): CandidateProposal[] {
  if (proposals.length <= 1) return proposals;
  // deterministische regel (Deel 26): per pair precies ÉÉN entry-voorstel.
  // Hoogste soft-score wint; bij gelijke score wint de langst-actieve versie
  // (senioriteit). Canary's krijgen geen aparte voorrang — hun lagere score
  // rangschikt ze vanzelf achter legacy-strategieën. Tegengestelde kanten
  // (long vs short op hetzelfde pair) lossen met dezelfde regel op: één
  // winnaar, de ander NO TRADE. De AI beslist hier niets van.
  const winner = [...proposals].sort((a, b) => {
    if (b.softScore !== a.softScore) return b.softScore - a.softScore;
    // senioriteit: langst actief wint (activated_at oudste eerst)
    return (a.row.activated_at ?? "").localeCompare(b.row.activated_at ?? "");
  })[0];
  return [winner];
}
