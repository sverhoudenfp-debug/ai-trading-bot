// ── FASE 2: Research-configuratie (centraal, env-tunable) ────────────────
// Aparte knoppen voor research: apart AI-budget, aparte sample-eisen, aparte
// data-dieptes. De trading-engine merkt hier niets van.

// ── Research AI-budget (APART van het trading-budget uit Fase 1) ───────
export const RESEARCH_MAX_AI_CALLS_PER_RUN = num("RESEARCH_MAX_AI_CALLS_PER_RUN", 2);
export const RESEARCH_MAX_AI_CALLS_PER_DAY = num("RESEARCH_MAX_AI_CALLS_PER_DAY", 4);
export const RESEARCH_MAX_COST_USD_PER_DAY = num("RESEARCH_MAX_COST_USD_PER_DAY", 1.0);
export const RESEARCH_MAX_TOKENS_PER_RUN = num("RESEARCH_MAX_TOKENS_PER_RUN", 25_000);

// ── Dataset-diepte (zelfde bron als de trading-engine: Bitvavo) ─────────
export const RESEARCH_15M_DAYS = num("RESEARCH_15M_DAYS", 180);
export const RESEARCH_1H_DAYS = num("RESEARCH_1H_DAYS", 180);
export const RESEARCH_5M_DAYS = num("RESEARCH_5M_DAYS", 60);   // 5m: 60d = 17.280 candles (zelfde orde als 15m/180d)
export const RESEARCH_4H_DAYS = num("RESEARCH_4H_DAYS", 180);  // context voor 1h-executie (swing)
export const RESEARCH_CACHE_TTL_MIN = num("RESEARCH_CACHE_TTL_MIN", 240);

// ── Sample-eisen ────────────────────────────────────────────────────────
export const MIN_TRADES_IS = num("RESEARCH_MIN_TRADES_IS", 30);   // in-sample minimum
export const MIN_TRADES_OOS = num("RESEARCH_MIN_TRADES_OOS", 12); // out-of-sample minimum
export const MIN_TRADES_WF = num("RESEARCH_MIN_TRADES_WF", 6);    // per walk-forward venster

// ── Train/test-split en walk-forward ────────────────────────────────────
export const TRAIN_PCT = num("RESEARCH_TRAIN_PCT", 65);        // 65% in-sample, 35% OOS
export const WF_SEGMENTS = num("RESEARCH_WF_SEGMENTS", 4);     // walk-forward: 4 opeenvolgende segmenten

// ── Hypotheses per run (begrensd — GEEN parameter sweeps) ───────────────
export const MAX_HYPOTHESES_PER_RUN = num("RESEARCH_MAX_HYPOTHESES", 3);

// ── Evaluatie-drempels ──────────────────────────────────────────────────
export const CANDIDATE_MIN_SCORE = num("RESEARCH_CANDIDATE_MIN_SCORE", 60);
export const ROBUSTNESS_MIN_PASS_RATIO = num("RESEARCH_ROBUSTNESS_MIN_RATIO", 0.6);

// ── Status-lifecycle (Fase 2: NOOIT ACTIVE/LIVE — dat is Fase 3) ────────
export const RESEARCH_STATUSES = [
  "HYPOTHESIS", "TESTING", "REJECTED", "INSUFFICIENT_DATA", "RESEARCH_CANDIDATE",
] as const;
export type ResearchStatus = (typeof RESEARCH_STATUSES)[number];
// compile-time guard: ACTIVERING bestaat niet in de research-lifecycle
type _NoActivation = Exclude<ResearchStatus, "ACTIVE" | "LIVE" | "PAPER_ACTIVE">;

// ── Job-statussen ───────────────────────────────────────────────────────
export const JOB_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

function num(v: string, d: number): number {
  const n = Number(process.env[v]);
  return Number.isFinite(n) && n > 0 ? n : d;
}
