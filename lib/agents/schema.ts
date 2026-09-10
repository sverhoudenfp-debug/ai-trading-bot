// ── Strikte AI-output-validatie (Fase 1) ────────────────────────────────
// De AI-output moet EXACT aan het schema voldoen:
//   • geldige JSON-object met news_assessment + proposals[]
//   • elke proposal: juiste types, juiste enums, juiste ranges
//   • één ongeldige proposal ⇒ HELE run afgewezen (hard fail, geen
//     gedeeltelijke uitvoering)
//   • max MAX_PROPOSALS_PER_RUN voorstellen; het overschot wordt per
//     proposal afgewezen en gelogd (cap, geen hard fail)
// Pure code — geen AI kan hier omheen.

import { PAIRS } from "@/lib/exchange/pairs";
import {
  RISK_MIN_PCT, RISK_MAX_PCT,
  AI_SL_MIN_PCT, AI_SL_MAX_PCT, AI_TP_MIN_PCT, AI_TP_MAX_PCT,
  MAX_PROPOSALS_PER_RUN,
} from "@/lib/risk/config";

export const ALLOWED_STRATEGIES = [
  "rsi-dip", "pullback", "breakout", "news-momentum", "rsi-fade-short",
] as const;
export const ALLOWED_TIMEFRAMES = ["5m", "15m", "1h"] as const;
export const ALLOWED_CONFIDENCE = ["low", "medium", "high"] as const;
export const ALLOWED_QUALITIES = ["A", "B", "C"] as const;

export interface AiProposal {
  pair: string;
  side: "buy" | "sell";
  kind: "entry" | "exit";
  strategy: string;
  timeframe: string;
  confidence: string;
  sl_pct: number | null;
  tp_pct: number | null;
  risk_pct: number | null;
  expected_move_pct: number | null;
  expected_duration_min: number | null;
  setup_quality: string | null;
  thesis: string | null;
  invalidation: string | null;
  explanation: string;
}

export interface AiOutput {
  news: { level: "ok" | "caution" | "high"; reason: string };
  proposals: AiProposal[];
}

export type Validated =
  | { ok: true; value: AiOutput }
  | { ok: false; error: string };

const isFiniteNum = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);

export function validateAiOutput(parsed: unknown): Validated {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "AI-output is geen JSON-object" };
  }
  const root = parsed as Record<string, unknown>;

  // ── news_assessment ──────────────────────────────────────────────────
  let news: AiOutput["news"] = { level: "ok", reason: "geen beoordeling gegeven" };
  if (root.news_assessment !== undefined) {
    const na = root.news_assessment;
    if (typeof na !== "object" || na === null) {
      return { ok: false, error: "news_assessment is geen object" };
    }
    const { level, reason } = na as Record<string, unknown>;
    if (!["ok", "caution", "high"].includes(String(level))) {
      return { ok: false, error: `news_assessment.level ongeldig: "${String(level)}"` };
    }
    if (typeof reason !== "string" || !reason.trim()) {
      return { ok: false, error: "news_assessment.reason ontbreekt" };
    }
    news = { level: level as AiOutput["news"]["level"], reason };
  }

  // ── proposals ─────────────────────────────────────────────────────────
  let rawProposals: unknown[] = [];
  if (root.proposals !== undefined) {
    if (!Array.isArray(root.proposals)) {
      return { ok: false, error: "proposals is geen array" };
    }
    rawProposals = root.proposals;
  }

  const proposals: AiProposal[] = [];
  for (let i = 0; i < rawProposals.length; i++) {
    const p = rawProposals[i];
    if (typeof p !== "object" || p === null || Array.isArray(p)) {
      return { ok: false, error: `proposal[${i}] is geen object` };
    }
    const o = p as Record<string, unknown>;
    const err = (m: string) => ({ ok: false as const, error: `proposal[${i}]: ${m}` });

    // onbekende velden → afwijzen (strikt schema)
    const allowed = new Set([
      "pair", "side", "kind", "strategy", "timeframe", "confidence",
      "sl_pct", "tp_pct", "risk_pct", "expected_move_pct",
      "expected_duration_min", "setup_quality", "thesis", "invalidation",
      "explanation",
    ]);
    for (const k of Object.keys(o)) {
      if (!allowed.has(k)) return err(`onbekend veld "${k}"`);
    }

    if (!(PAIRS as readonly string[]).includes(String(o.pair))) return err(`pair ongeldig: "${String(o.pair)}"`);
    if (o.side !== "buy" && o.side !== "sell") return err(`side ongeldig: "${String(o.side)}"`);
    if (o.kind !== "entry" && o.kind !== "exit") return err(`kind ongeldig: "${String(o.kind)}"`);
    if (!(ALLOWED_STRATEGIES as readonly string[]).includes(String(o.strategy))) return err(`strategy ongeldig: "${String(o.strategy)}"`);
    if (!(ALLOWED_TIMEFRAMES as readonly string[]).includes(String(o.timeframe))) return err(`timeframe ongeldig: "${String(o.timeframe)}"`);
    if (o.confidence !== undefined && !(ALLOWED_CONFIDENCE as readonly string[]).includes(String(o.confidence))) return err(`confidence ongeldig: "${String(o.confidence)}"`);

    const explanation = String(o.explanation ?? "");
    if (!explanation.trim() || explanation.length > 250) return err("explanation ontbreekt of te lang (>250)");

    let sl_pct: number | null = null;
    let tp_pct: number | null = null;
    let risk_pct: number | null = null;
    let expected_move_pct: number | null = null;
    let expected_duration_min: number | null = null;
    let setup_quality: string | null = null;
    let thesis: string | null = null;
    let invalidation: string | null = null;

    if (o.kind === "entry") {
      if (!isFiniteNum(o.sl_pct) || o.sl_pct < AI_SL_MIN_PCT || o.sl_pct > AI_SL_MAX_PCT) return err(`sl_pct ongeldig (${String(o.sl_pct)}; band ${AI_SL_MIN_PCT}-${AI_SL_MAX_PCT})`);
      if (!isFiniteNum(o.tp_pct) || o.tp_pct < AI_TP_MIN_PCT || o.tp_pct > AI_TP_MAX_PCT) return err(`tp_pct ongeldig (${String(o.tp_pct)}; band ${AI_TP_MIN_PCT}-${AI_TP_MAX_PCT})`);
      if (!isFiniteNum(o.risk_pct) || o.risk_pct < RISK_MIN_PCT || o.risk_pct > RISK_MAX_PCT) return err(`risk_pct ongeldig (${String(o.risk_pct)}; band ${RISK_MIN_PCT}-${RISK_MAX_PCT})`);
      if (!isFiniteNum(o.expected_move_pct) || o.expected_move_pct <= 0 || o.expected_move_pct > 50) return err(`expected_move_pct ongeldig (${String(o.expected_move_pct)})`);
      if (!isFiniteNum(o.expected_duration_min) || o.expected_duration_min < 5 || o.expected_duration_min > 1440) return err(`expected_duration_min ongeldig (${String(o.expected_duration_min)})`);
      if (!(ALLOWED_QUALITIES as readonly string[]).includes(String(o.setup_quality))) return err(`setup_quality ongeldig: "${String(o.setup_quality)}"`);
      thesis = String(o.thesis ?? "");
      invalidation = String(o.invalidation ?? "");
      if (!thesis.trim() || thesis.length > 300) return err("thesis ontbreekt of te lang");
      if (!invalidation.trim() || invalidation.length > 300) return err("invalidation ontbreekt of te lang");
      sl_pct = o.sl_pct; tp_pct = o.tp_pct; risk_pct = o.risk_pct;
      expected_move_pct = o.expected_move_pct;
      expected_duration_min = o.expected_duration_min;
      setup_quality = String(o.setup_quality);
    } else {
      // exits: geen sizing-velden nodig; sla wat er écht is netjes op
      sl_pct = isFiniteNum(o.sl_pct) ? o.sl_pct : null;
      tp_pct = isFiniteNum(o.tp_pct) ? o.tp_pct : null;
      risk_pct = isFiniteNum(o.risk_pct) ? o.risk_pct : null;
    }

    proposals.push({
      pair: String(o.pair),
      side: o.side as "buy" | "sell",
      kind: o.kind as "entry" | "exit",
      strategy: String(o.strategy),
      timeframe: String(o.timeframe),
      confidence: o.confidence !== undefined ? String(o.confidence) : "medium",
      sl_pct, tp_pct, risk_pct,
      expected_move_pct, expected_duration_min, setup_quality,
      thesis, invalidation,
      explanation,
    });
  }

  return { ok: true, value: { news, proposals } };
}

/**
 * Code-level cap: max MAX_PROPOSALS_PER_RUN voorstellen per run.
 * Returnt de behouden voorstellen; de rest wordt als 'rejected' gemarkeerd
 * zodat het zichtbaar en telbaar blijft.
 */
export function capProposals(proposals: AiProposal[]): {
  keep: AiProposal[];
  rejected: AiProposal[];
} {
  return {
    keep: proposals.slice(0, MAX_PROPOSALS_PER_RUN),
    rejected: proposals.slice(MAX_PROPOSALS_PER_RUN),
  };
}
