// ── FASE 2: AI-output-normalisatie ──────────────────────────────────────
// AI-modellen zijnOnbetrouwbaar in exacte formaten: condities komen soms
// als string ("rsi_lt 35", "rsi_lt(35)", "trend1h:up") in plaats van
// objecten, proza-velden worden te lang. Deze laag NORMALISEERT dat
// deterministisch vóór validatie:
//   • string-condities → objecten (alleen toegestane kinds, geen vrije tekst)
//   • numerieke strings → numbers ("35" → 35)
//   • te lang prosa → exact afgekapt (begrensd, geen inhoud verzonnen)
// NIETS wordt uitgevonden: wat niet parseert binnen de whitelist valt
// tóch door de strikte validatie heen (hard reject, met reden).

import { ConditionKind } from "./spec";

interface ConditionDraft { kind?: unknown; value?: unknown; period?: unknown; period2?: unknown; bars?: unknown }

const KINDS = new Set<string>([
  "rsi_lt", "rsi_gt", "rsi_cross_under", "rsi_cross_over",
  "price_above_ema", "price_below_ema", "ema_above_ema", "ema_below_ema",
  "mom_gt", "mom_lt", "dist_ema50_between", "dist_ema200_gt", "dist_ema200_lt",
  "breakout_24h", "breakdown_24h", "volume_gt_sma", "trend1h",
  "volatility_gt", "volatility_lt",
]);

/** "rsi_lt(35)", "rsi_lt:35", "rsi_lt 35" → {kind:"rsi_lt", value:35} */
function parseStringCondition(s: string): ConditionDraft | null {
  // haakjes (function-stijl) en komma's normaliseren naar whitespace
  const t = s.trim().replace(/[(),;\t]+/g, " ").replace(/\s+/g, " ");
  const m = t.match(/^([a-z0-9_]+)[\s:]*\s*(.*)$/i);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  if (!KINDS.has(kind)) return null;
  const rest = (m[2] ?? "").trim();
  const tokens = rest ? rest.split(/[,:;\s]+/).filter(Boolean) : [];
  const num = (x: string | undefined) => {
    if (x === undefined || x === "") return undefined;
    const n = Number(x);
    return Number.isFinite(n) ? n : undefined;
  };
  const d: ConditionDraft = { kind };
  switch (kind as ConditionKind | string) {
    case "rsi_lt": case "rsi_gt": case "rsi_cross_under": case "rsi_cross_over":
      d.value = num(tokens[0]); break;
    case "price_above_ema": case "price_below_ema":
      d.period = num(tokens[0]); break;
    case "ema_above_ema": case "ema_below_ema":
      d.period = num(tokens[0]); d.period2 = num(tokens[1]); break;
    case "mom_gt": case "mom_lt":
      d.value = num(tokens[0]); d.bars = num(tokens[1]) ?? 8; break;
    case "dist_ema50_between": case "dist_ema200_gt": case "dist_ema200_lt":
    case "volume_gt_sma": case "volatility_gt": case "volatility_lt":
      d.value = num(tokens[0]); break;
    case "trend1h":
      if (tokens[0] === "up" || tokens[0] === "down") d.value = tokens[0];
      break;
    case "breakout_24h": case "breakdown_24h":
      break; // geen params
    default:
      return null;
  }
  return d;
}

/** Object-conditie met numerieke strings → echte numbers. */
function coerceConditionObject(o: Record<string, unknown>): ConditionDraft {
  const out: ConditionDraft = { ...o } as ConditionDraft;
  for (const k of ["value", "period", "period2", "bars"] as const) {
    const v = out[k];
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) (out as Record<string, unknown>)[k] = n;
    }
  }
  return out;
}

const FIELD_LIMITS = {
  description: 300, hypothesis: 400, expected_regime: 120,
  failure_conditions: 300, falsification: 300,
} as const;

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Normaliseert een AI-hypothese-DRAFT. Puur en deterministisch.
 * Retourneert de genormaliseerde draft (nog altijd strikt gevalideerd
 * door validateSpec daarna — dit is geen validatievervanging).
 */
export function normalizeSpecDraft(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const o = { ...(input as Record<string, unknown>) };

  for (const [k, max] of Object.entries(FIELD_LIMITS)) {
    if (typeof o[k] === "string") o[k] = clip(o[k], max);
  }

  for (const key of ["entry_conditions", "exit_conditions"] as const) {
    if (!Array.isArray(o[key])) continue;
    o[key] = (o[key] as unknown[]).map((c) => {
      if (typeof c === "string") {
        const parsed = parseStringCondition(c);
        return parsed ?? c; // unparsable blijft string → validatie wijst af
      }
      if (typeof c === "object" && c !== null && !Array.isArray(c)) {
        return coerceConditionObject(c as Record<string, unknown>);
      }
      return c;
    });
  }

  if (o.filters !== null && typeof o.filters === "object" && !Array.isArray(o.filters)) {
    const f = { ...(o.filters as Record<string, unknown>) };
    for (const k of ["min_volatility_pct", "max_volatility_pct", "min_volume_z"] as const) {
      if (typeof f[k] === "string") {
        const n = Number(f[k]);
        if (Number.isFinite(n)) f[k] = n;
      }
    }
    o.filters = f;
  }

  // numerieke hoofdvelden als string ("3" → 3)
  for (const k of ["stop_loss_pct", "take_profit_pct", "max_hold_bars", "risk_pct", "expected_holding_time_min"] as const) {
    if (typeof o[k] === "string") {
      const n = Number(o[k]);
      if (Number.isFinite(n)) o[k] = n;
    }
  }
  return o;
}
