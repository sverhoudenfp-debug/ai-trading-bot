// ── FASE 2: Strategy Specification — AI genereert DATA, geen code ────────
// De AI (of een mens) formuleert een strategie ALLEEN als gestructureerde
// data met een witte lijst van toegestane componenten. De backtest-engine
// interpreteert de spec; er is géén pad waar AI-output als code wordt
// uitgevoerd (geen eval, geen dynamic import, geen shell).
//
// Validatie hieronder is STRIKT: één ongeldig veld ⇒ de hele spec wordt
// afgewezen (REJECTED, reden gelogd) — nooit stil gecorrigeerd.

import { PAIRS } from "@/lib/exchange/pairs";
import { RISK_MIN_PCT, RISK_MAX_PCT, ROUND_TRIP_COST_PCT, FEE_COVER_FACTOR } from "@/lib/risk/config";

export const CONDITION_KINDS = [
  "rsi_lt", "rsi_gt",                    // RSI-niveau (waarde 0-100)
  "rsi_cross_under", "rsi_cross_over",  // RSI-kruising (t.o.v. vorige candle)
  "price_above_ema", "price_below_ema", // koers vs EMA (period 10-300)
  "ema_above_ema", "ema_below_ema",      // EMA vs EMA (period, period2)
  "mom_gt", "mom_lt",                    // momentum % (bars)
  "dist_ema50_between",                 // afstand tot EMA50 in band [-5, +5]%
  "dist_ema200_gt", "dist_ema200_lt",   // afstand tot EMA200 in %
  "breakout_24h", "breakdown_24h",       // close boven/onder 24u-high/low (geen params)
  "volume_gt_sma",                       // volume > factor × volume-SMA20
  "trend1h",                            // 1h-trend: up | down | flat
  "volatility_gt", "volatility_lt",      // 20-candle vol % band
] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

export interface Condition {
  kind: ConditionKind;
  value?: number | "up" | "down"; // drempelwaarde (betekenis per kind)
  period?: number;  // indicatorperiode (waar van toepassing)
  period2?: number; // tweede periode (ema_vs_ema)
  bars?: number;    // momentum-venster
}

// ── HORIZON (master-prompt Deel 3): de research-engine is NIET vooraf als
// scalper/intraday/swing gefixeerd. Executie op 5m (scalping), 15m (intraday)
// of 1h (swing); de context-timeframe (trend-filter) schaalt mee:
//   5m-executie → 1h-context · 15m → 1h · 1h → 4h
// Horizons zijn géén label maar een meetbaar kenmerk van de strategie:
// timeframe + max_hold bepalen samen de horizon.
export type Timeframe = "5m" | "15m" | "1h";
export const ALLOWED_TIMEFRAMES: Timeframe[] = ["5m", "15m", "1h"];
export const TF_MINUTES: Record<Timeframe, number> = { "5m": 5, "15m": 15, "1h": 60 };
/** context-trend-timeframe bij elke executie-timeframe (no-look-ahead in frame.ts) */
export const TF_CONTEXT_MINUTES: Record<Timeframe, number> = { "5m": 60, "15m": 60, "1h": 240 };
/** max_hold_bars-bereik per timeframe (zelfde min/max duur-idea als v1) */
export const TF_HOLD_RANGE: Record<Timeframe, { min: number; max: number }> = {
  "5m": { min: 4, max: 288 },    // 20 min – 24 uur
  "15m": { min: 4, max: 192 },  // 1 uur – 48 uur
  "1h": { min: 4, max: 192 },   // 4 uur – 8 dagen
};

export interface StrategyFilters {
  min_volatility_pct?: number;   // 20-candle vol % moet ≥ dit zijn
  max_volatility_pct?: number;
  require_trend1h?: "up" | "down";
  min_volume_z?: number;         // volume-z-score minimum bij entry
}

export interface StrategySpec {
  name: string;                  // slug, 3-40 tekens
  description: string;
  hypothesis: string;            // waarom zou deze edge bestaan
  expected_regime: string;       // wanneer zou hij moeten werken
  failure_conditions: string;    // wanneer faalt hij waarschijnlijk
  falsification: string;         // criterium om hem te verwerpen
  timeframe: Timeframe;
  direction: "long" | "short";
  entry_conditions: Condition[]; // AND-verbonden, max 4
  exit_conditions: Condition[];   // OR-verbonden (één genoeg), max 3
  stop_loss_pct: number;         // 1–10
  take_profit_pct: number;        // 0,5–15
  max_hold_bars: number;          // per-timeframe bereik, zie TF_HOLD_RANGE
  risk_pct: number;               // 0,25–1,0 (Fase 1-band, hard)
  filters?: StrategyFilters;
  pairs: string[];                // subset van PAIRS (witte lijst)
  expected_holding_time_min: number;
  origin: "baseline" | "ai-research" | "manual";
}

export type SpecValidation =
  | { ok: true; spec: StrategySpec }
  | { ok: false; errors: string[] };

export function validateSpec(input: unknown): SpecValidation {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["spec is geen object"] };
  }
  const o = input as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  // strikt: geen enkele onbekende top-level velden (AI mag het schema niet
  // uitbreiden — data-only, geen vrije velden)
  const allowedKeys = new Set([
    "name","description","hypothesis","expected_regime","failure_conditions","falsification",
    "timeframe","direction","entry_conditions","exit_conditions","stop_loss_pct","take_profit_pct",
    "max_hold_bars","risk_pct","filters","pairs","expected_holding_time_min","origin",
  ]);
  for (const k of Object.keys(o)) if (!allowedKeys.has(k)) errors.push(`onbekend veld "${k}"`);

  const numv = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);

  // ── tekstvelden ──────────────────────────────────────────────────────
  const name = str(o.name);
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(name)) errors.push(`name ongeldig: "${name}" (slug, 3-40)`);
  for (const [k, max] of [["description", 300], ["hypothesis", 400], ["expected_regime", 120], ["failure_conditions", 300], ["falsification", 300]] as const) {
    const v = str(o[k]);
    if (!v.trim()) errors.push(`${k} ontbreekt`);
    else if (v.length > max) errors.push(`${k} te lang (>${max})`);
  }
  if (!ALLOWED_TIMEFRAMES.includes(o.timeframe as Timeframe)) {
    errors.push(`timeframe ongeldig: "${String(o.timeframe)}" (toegestaan: ${ALLOWED_TIMEFRAMES.join(",")})`);
  }
  if (o.direction !== "long" && o.direction !== "short") {
    errors.push(`direction ongeldig: "${String(o.direction)}"`);
  }
  if (o.origin !== "baseline" && o.origin !== "ai-research" && o.origin !== "manual") {
    errors.push(`origin ongeldig: "${String(o.origin)}"`);
  }

  // ── risico-banden (HARD — zelfde als de live risk-engine) ────────────
  const sl = numv(o.stop_loss_pct);
  const tp = numv(o.take_profit_pct);
  const risk = numv(o.risk_pct);
  const hold = numv(o.max_hold_bars);
  const eht = numv(o.expected_holding_time_min);
  if (sl === null || sl < 1 || sl > 10) errors.push(`stop_loss_pct ongeldig (${String(o.stop_loss_pct)})`);
  if (tp === null || tp < 0.5 || tp > 15) errors.push(`take_profit_pct ongeldig (${String(o.take_profit_pct)})`);
  if (risk === null || risk < RISK_MIN_PCT || risk > RISK_MAX_PCT) {
    errors.push(`risk_pct ongeldig (${String(o.risk_pct)}) — band ${RISK_MIN_PCT}–${RISK_MAX_PCT}% (hard)`);
  }
  const tf = (ALLOWED_TIMEFRAMES.includes(o.timeframe as Timeframe) ? o.timeframe : "15m") as Timeframe;
  const hr = TF_HOLD_RANGE[tf];
  if (hold === null || hold < hr.min || hold > hr.max) {
    errors.push(`max_hold_bars ongeldig (${String(o.max_hold_bars)}; ${hr.min}–${hr.max} voor timeframe ${tf})`);
  }
  if (eht === null || eht < 15 || eht > 4320) errors.push(`expected_holding_time_min ongeldig (${String(o.expected_holding_time_min)}; ≥15)`);
  // fee-guard (Fase 1): TP moet round-trip-kosten × factor dekken
  if (sl !== null && tp !== null && tp < ROUND_TRIP_COST_PCT * FEE_COVER_FACTOR) {
    errors.push(`fee-guard: take_profit_pct ${tp}% dekt round-trip-kosten (${ROUND_TRIP_COST_PCT.toFixed(2)}% × ${FEE_COVER_FACTOR}) niet — geen scalps`);
  }

  // ── pairs (witte lijst) ───────────────────────────────────────────────
  if (!Array.isArray(o.pairs) || o.pairs.length === 0) {
    errors.push("pairs ontbreekt of leeg");
  } else {
    for (const p of o.pairs as unknown[]) {
      if (!(PAIRS as readonly string[]).includes(String(p))) {
        errors.push(`pair "${String(p)})" staat niet op de witte lijst`);
      }
    }
  }

  // ── condities ──────────────────────────────────────────────────────────
  const validateConditions = (key: "entry_conditions" | "exit_conditions", max: number) => {
    const arr = o[key];
    if (!Array.isArray(arr) || arr.length === 0) {
      errors.push(`${key} ontbreekt of leeg`);
      return;
    }
    if (arr.length > max) errors.push(`${key}: max ${max} condities (kreeg ${arr.length})`);
    arr.forEach((c, idx) => {
      if (typeof c !== "object" || c === null) { errors.push(`${key}[${idx}] is geen object`); return; }
      const cc = c as Record<string, unknown>;
      const allowed = new Set(["kind", "value", "period", "period2", "bars"]);
      for (const k of Object.keys(cc)) if (!allowed.has(k)) errors.push(`${key}[${idx}]: onbekend veld "${k}"`);
      if (!(CONDITION_KINDS as readonly string[]).includes(String(cc.kind))) {
        errors.push(`${key}[${idx}].kind ongeldig: "${String(cc.kind)}"`);
        return;
      }
      const kind = cc.kind as ConditionKind;
      const val = numv(cc.value);
      // per-kind eisen
      if (kind.startsWith("rsi")) {
        if (kind === "rsi_lt" || kind === "rsi_gt" || kind === "rsi_cross_under" || kind === "rsi_cross_over") {
          if (val === null || val < 5 || val > 95) errors.push(`${key}[${idx}].value (RSI) ongeldig: ${String(cc.value)}`);
        }
      }
      if (kind === "price_above_ema" || kind === "price_below_ema" || kind === "ema_above_ema" || kind === "ema_below_ema") {
        const per = numv(cc.period);
        if (per === null || per < 10 || per > 300) errors.push(`${key}[${idx}].period ongeldig: ${String(cc.period)} (10–300)`);
        if (kind === "ema_above_ema" || kind === "ema_below_ema") {
          const per2 = numv(cc.period2);
          if (per2 === null || per2 < 10 || per2 > 300) errors.push(`${key}[${idx}].period2 ongeldig (10–300)`);
        }
      }
      if (kind === "mom_gt" || kind === "mom_lt") {
        if (val === null || val < -50 || val > 50) errors.push(`${key}[${idx}].value (momentum %) ongeldig`);
        const bars = numv(cc.bars);
        if (bars === null || bars < 2 || bars > 48) errors.push(`${key}[${idx}].bars ongeldig (2–48)`);
      }
      if (kind === "dist_ema50_between" && (val === null || val < -5 || val > 5)) {
        errors.push(`${key}[${idx}].value (dist EMA50 %) ongeldig: ${String(cc.value)} (-5..+5)`);
      }
      if (kind === "dist_ema200_gt" || kind === "dist_ema200_lt") {
        if (val === null || val < -30 || val > 30) errors.push(`${key}[${idx}].value (dist EMA200 %) ongeldig`);
      }
      if (kind === "volume_gt_sma" && (val === null || val < 1 || val > 10)) {
        errors.push(`${key}[${idx}].value (volume-factor) ongeldig (1–10)`);
      }
      if (kind === "trend1h" && !["up", "down"].includes(String(cc.value))) {
        errors.push(`${key}[${idx}].value (trend1h) moet "up" of "down" zijn`);
      }
      if (kind === "volatility_gt" || kind === "volatility_lt") {
        if (val === null || val < 0.05 || val > 10) errors.push(`${key}[${idx}].value (vol %) ongeldig`);
      }
    });
  };
  validateConditions("entry_conditions", 4);
  validateConditions("exit_conditions", 3);

  // ── filters ───────────────────────────────────────────────────────────
  if (o.filters !== undefined && o.filters !== null) {
    const f = o.filters as Record<string, unknown>;
    const allowed = new Set(["min_volatility_pct", "max_volatility_pct", "require_trend1h", "min_volume_z"]);
    for (const k of Object.keys(f)) if (!allowed.has(k)) errors.push(`filters: onbekend veld "${k}"`);
    for (const k of ["min_volatility_pct", "max_volatility_pct", "min_volume_z"] as const) {
      if (f[k] !== undefined) {
        const v = numv(f[k]);
        if (v === null || v < 0 || v > 10) errors.push(`filters.${k} ongeldig`);
      }
    }
    if (f.require_trend1h !== undefined && !["up", "down"].includes(String(f.require_trend1h))) {
      errors.push("filters.require_trend1h ongeldig");
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, spec: input as unknown as StrategySpec };
}
