// ── FASE 3: live evaluatie van PAPER_ACTIVE strategie-versies ────────────
// De ENIGE plek waar de evolution-engine aansluit op de trading-flow:
// geactiveerde registry-versies (status PAPER_ACTIVE) worden op live
// candles geëvalueerd met exact DEZELFDE interpreter als in de backtest
// (lib/research/frame + interpreter) — dus geen codegeneratie, geen
// look-ahead (signaal op gesloten candle), geen ander executiepad.
//
// FAIL-CLOSED (Deel 25):
//   registry onbereikbaar           → geen enkele evolution-proposal
//   specificatie ontbreekt/ongeldig → geen entry voor die versie (+audit)
//   status onbekend                 → geen entry
// De legacy-strategieën en de volledige risk engine draaien onverminderd.

import { Candle } from "@/lib/exchange/marketdata";
import { buildFrame, FRAME_WARMUP } from "@/lib/research/frame";
import { conditionMet } from "@/lib/research/interpreter";
import { validateSpec, StrategySpec } from "@/lib/research/spec";
import { regimeAt } from "@/lib/research/regimes";
import { activePaperStrategies, RegistryRow, writeAudit } from "./db";
import { canTradePaper } from "./lifecycle";
import { regimeFitFrom, paperScoreFrom, softScore, currentLearnWeights, CandidateProposal } from "./selection";
import { resolveConflicts } from "./selection";
import type { PaperMetrics } from "./monitor";
import { getStates } from "@/lib/paper/store";

export interface EvoProposal {
  registryId: number;
  strategyKey: string;        // "evo/<strategy_id>@<version>" — stempel op signalen/orders
  pair: string;
  side: "buy" | "sell";
  slPct: number;
  tpPct: number;
  riskPct: number;            // canary-cap wordt in de order-agent hard geclampt
  isCanary: boolean;
  score: number;
  regimeLabel: string;
  reason: string;            // auditbare, deterministische reden
}

/** Cache: registry maximaal 1× per 60 s uitlezen (cron-tick bevrijd houden). */
let cache: { at: number; rows: RegistryRow[] } | null = null;
export async function activeRowsCached(): Promise<RegistryRow[]> {
  const now = Date.now();
  if (cache && now - cache.at < 60_000) return cache.rows;
  const rows = await activePaperStrategies();
  cache = { at: now, rows };
  return rows;
}
export function clearRegistryCache(): void {
  cache = null;
}

/**
 * Evalueer alle PAPER_ACTIVE versies voor één pair. Puur lezen; retourneert
 * maximaal ÉÉN winnende proposal (conflictregel) of niets.
 */
export async function evaluateEvolutionForPair(
  pair: string,
  candles15: Candle[],
  candles1h: Candle[],
  paperMetricsBy: (row: RegistryRow) => PaperMetrics | null
): Promise<EvoProposal[]> {
  if (candles15.length < FRAME_WARMUP + 5 || candles1h.length < 220) return [];

  const rows = await activeRowsCached();
  const tradable = rows.filter((r) => canTradePaper(r.status as never));
  if (!tradable.length) return [];

  const states = await getStates();
  const status = states.find((s) => s.pair === pair)?.status ?? "flat";
  if (status !== "flat") return []; // geen dubbelposities op een pair

  const frame = buildFrame(pair, candles15, candles1h);
  const idx = frame.candles.length - 2; // laatst gesloten candle (zelfde conventie als legacy-analyse)
  const closes = frame.candles.map((c) => c.c);
  const regime = regimeAt(closes, frame.ema50, frame.ema200, frame.atr14, idx);
  const weights = await currentLearnWeights();

  const proposals: CandidateProposal[] = [];
  const rowsWithSpec: RegistryRow[] = [];

  for (const row of tradable) {
    // fail-closed: specificatie aanwezig + (opnieuw) geldig
    let spec: StrategySpec | null = null;
    try {
      const raw = typeof row.specification === "string" ? JSON.parse(row.specification) : row.specification;
      const v = validateSpec(raw);
      if (v.ok) spec = v.spec;
    } catch { spec = null; }
    if (!spec || !spec.pairs.includes(pair)) continue;

    // regime-fit (deterministisch; negatief backtest-regime = géén entry)
    const rm = (row.research_metrics as { regime_performance?: Record<string, { trades: number; netPnl: number }> } | null) ?? null;
    const fit = regimeFitFrom(rm?.regime_performance ?? null, regime);
    if (fit.fit === 0) continue; // regime-misfit → geen entry

    // entry-voorwaarden op de gesloten candle
    const entry = spec.entry_conditions.every((c) => conditionMet(c, frame, idx));
    if (!entry) continue;

    // exit-voorwaarden uitsluiten (direct gesloten signaal = geen zinvolle entry)
    const exitNow = spec.exit_conditions.some((c) => conditionMet(c, frame, idx));
    if (exitNow) continue;

    const pm = paperMetricsBy(row);
    const ps = paperScoreFrom(pm);
    const lw = weights[row.strategy_id] ?? 1;
    const score = softScore({ researchScore: row.score ?? 50, paperScore: ps, regimeFit: fit.fit, learnWeight: lw });

    proposals.push({ row, side: spec.direction === "long" ? "buy" : "sell", softScore: score, paperScore: ps, regimeFit: fit.fit, regimeLabel: fit.label, learnWeight: lw });
    rowsWithSpec.push(row);
  }

  if (!proposals.length) return [];
  const winners = resolveConflicts(proposals);

  return winners.map((w) => {
    const row = w.row;
    let spec: StrategySpec | null = null;
    try {
      const raw = typeof row.specification === "string" ? JSON.parse(row.specification) : row.specification;
      const v2 = validateSpec(raw);
      spec = v2.ok ? (v2.spec as StrategySpec) : null;
    } catch { spec = null; }
    if (!spec) return null;
    return {
      registryId: row.id,
      strategyKey: `evo/${row.strategy_id}@${row.version}`,
      pair,
      side: w.side,
      slPct: spec.stop_loss_pct,
      tpPct: spec.take_profit_pct,
      riskPct: Math.min(spec.risk_pct, row.canary ? 0.25 : 1),
      isCanary: row.canary,
      score: w.softScore,
      regimeLabel: w.regimeLabel,
      reason: `evo ${row.strategy_id} v${row.version}${row.canary ? " (PAPER CANARY)" : ""}: entry-condities op gesloten 15m-candle · regime ${w.regimeLabel} · soft-score ${w.softScore}`,
    } satisfies EvoProposal;
  }).filter((x): x is EvoProposal => x !== null);
}

/**
 * FASE 3 — order-agent hook: is de evolution-versie achter dit strategyKey
 * NOG steeds PAPER_ACTIVE? Fail-closed: registry onbereikbaar, rij weg,
 * status anders → géén entry. (Re-activatie van gerolled-back versies is
 * op lifecycle-niveau al onmogelijk; dit is de tweede, executie-tijd laag.)
 */
export async function evoStrategyStillActive(strategyKey: string):
  Promise<{ ok: boolean; reason?: string }> {
  const rows = await activeRowsCached();
  const hit = rows.find((r) => `evo/${r.strategy_id}@${r.version}` === strategyKey);
  if (!rows.length) return { ok: false, reason: "geen actieve evolution-versies (registry leeg of onbereikbaar — fail-closed)" };
  if (!hit) return { ok: false, reason: `${strategyKey} staat niet meer als PAPER_ACTIVE geregistreerd` };
  if (!canTradePaper(hit.status as never)) return { ok: false, reason: `status ${hit.status} is niet handelbaar` };
  return { ok: true };
}

export async function auditNoTrade(row: RegistryRow, reason: string): Promise<void> {
  await writeAudit({
    registry_id: row.id, action: "fail_closed_no_entry", from_status: row.status, to_status: row.status,
    reason, performed_by: "evolution-engine", metrics_at: null,
  });
}
