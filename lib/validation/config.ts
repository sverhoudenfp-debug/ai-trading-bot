// ── FASE 4: Paper Validation Engine — centrale drempels ────────────────────
// Alle values env-tunable; conservatieve defaults. De AI kan NIET bij deze
// waarden. Een score of gate vervangt nóóit de Fase-1 risk engine.

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

// ── VALIDATIEPERIODE (Deel 5) ─────────────────────────────────────────────
export const VAL_MIN_OBSERVATION_DAYS = num(process.env.VAL_MIN_OBSERVATION_DAYS, 7);      // min. 7 dagen observatie
export const VAL_MIN_CLOSED_TRADES = num(process.env.VAL_MIN_CLOSED_TRADES, 30);          // min. 30 gesloten trades
export const VAL_MIN_ACTIVE_DAYS = num(process.env.VAL_MIN_ACTIVE_DAYS, 5);               // min. 5 dagen met paper-activiteit

// ── APPROVAL GATE (Deel 9/10) ────────────────────────────────────────────
export const VAL_MIN_NET_PNL_EUR = Number(process.env.VAL_MIN_NET_PNL_EUR ?? 5);         // netto na fees/slippage structureel positief: ≥ €5
export const VAL_MIN_EXPECTANCY_EUR = Number(process.env.VAL_MIN_EXPECTANCY_EUR ?? 0.10); // ≥ €0,10/trade netto
export const VAL_MIN_PROFIT_FACTOR = num(process.env.VAL_MIN_PROFIT_FACTOR, 1.10);        // PF ≥ 1,10 (na fees)
export const VAL_MAX_DD_PCT = num(process.env.VAL_MAX_DD_PCT, 10);                       // absolute drawdown-cap
export const VAL_MAX_DD_FACTOR = num(process.env.VAL_MAX_DD_FACTOR, 1.5);                // DD ≤ 1,5× de verwachte DD
export const VAL_MAX_FEE_SHARE_PCT = num(process.env.VAL_MAX_FEE_SHARE_PCT, 40);         // fees ≤ 40% van gross profit
export const VAL_MAX_SINGLE_COIN_SHARE = num(process.env.VAL_MAX_SINGLE_COIN_SHARE, 0.7);// geen coin > 70% van netto
export const VAL_FREQ_MIN_FACTOR = num(process.env.VAL_FREQ_MIN_FACTOR, 0.5);             // frequentie ≥ 0,5× verwacht
export const VAL_FREQ_MAX_FACTOR = num(process.env.VAL_FREQ_MAX_FACTOR, 2.0);            // frequentie ≤ 2,0× verwacht
export const VAL_HOLD_MIN_FACTOR = num(process.env.VAL_HOLD_MIN_FACTOR, 0.5);            // hold ≥ 0,5× verwacht
export const VAL_HOLD_MAX_FACTOR = num(process.env.VAL_HOLD_MAX_FACTOR, 2.0);            // hold ≤ 2,0× verwacht
export const VAL_MAX_INTEGRITY_ISSUES = num(process.env.VAL_MAX_INTEGRITY_ISSUES, 0);    // géén ernstige integriteitsproblemen
export const VAL_MAX_CRITICAL_DRIFT = num(process.env.VAL_MAX_CRITICAL_DRIFT, 0);       // géén critical drift

// ── AI-EXIT VALIDATIE (Deel 24) ───────────────────────────────────────────
export const VAL_AI_EXIT_MIN_AVG_HOLD_MIN = num(process.env.VAL_AI_EXIT_MIN_AVG_HOLD_MIN, 15); // AI-exits gem. ≥ min-hold
export const VAL_AI_EXIT_MAX_SHORT_PCT = num(process.env.VAL_AI_EXIT_MAX_SHORT_PCT, 50);     // ≤ 50% AI-exits korter dan min-hold

// ── DRIFT-DREMPELS (Deel 8) ───────────────────────────────────────────────
export const DRIFT_EXP_WARN_FACTOR = num(process.env.DRIFT_EXP_WARN_FACTOR, 0.6);      // paper exp < 0,6× verwacht → WARNING
export const DRIFT_EXP_CRIT_FACTOR = num(process.env.DRIFT_EXP_CRIT_FACTOR, 0.25);    // ≤ 0,25× → CRITICAL
export const DRIFT_PF_WARN_FACTOR = num(process.env.DRIFT_PF_WARN_FACTOR, 0.8);
export const DRIFT_PF_CRIT_FACTOR = num(process.env.DRIFT_PF_CRIT_FACTOR, 0.5);
export const DRIFT_DD_WARN_FACTOR = num(process.env.DRIFT_DD_WARN_FACTOR, 1.3);
export const DRIFT_DD_CRIT_FACTOR = num(process.env.DRIFT_DD_CRIT_FACTOR, 2.0);
export const DRIFT_FREQ_WARN_LOW = num(process.env.DRIFT_FREQ_WARN_LOW, 0.7);
export const DRIFT_FREQ_WARN_HIGH = num(process.env.DRIFT_FREQ_WARN_HIGH, 1.5);
export const DRIFT_FREQ_CRIT_LOW = num(process.env.DRIFT_FREQ_CRIT_LOW, 0.4);
export const DRIFT_FREQ_CRIT_HIGH = num(process.env.DRIFT_FREQ_CRIT_HIGH, 2.5);
export const DRIFT_HOLD_WARN_LOW = num(process.env.DRIFT_HOLD_WARN_LOW, 0.6);
export const DRIFT_HOLD_WARN_HIGH = num(process.env.DRIFT_HOLD_WARN_HIGH, 1.6);
export const DRIFT_HOLD_CRIT_LOW = num(process.env.DRIFT_HOLD_CRIT_LOW, 0.3);
export const DRIFT_HOLD_CRIT_HIGH = num(process.env.DRIFT_HOLD_CRIT_HIGH, 2.5);
export const DRIFT_FEE_WARN_FACTOR = num(process.env.DRIFT_FEE_WARN_FACTOR, 1.3);
export const DRIFT_FEE_CRIT_FACTOR = num(process.env.DRIFT_FEE_CRIT_FACTOR, 2.0);
export const DRIFT_WINRATE_WARN_PP = num(process.env.DRIFT_WINRATE_WARN_PP, 15);      // winrate −15pp → WARNING
export const DRIFT_WINRATE_CRIT_PP = num(process.env.DRIFT_WINRATE_CRIT_PP, 25);     // winrate −25pp → CRITICAL

// ── STATISTIEK (Deel 17) ───────────────────────────────────────────────────
export const BOOTSTRAP_RUNS = num(process.env.BOOTSTRAP_RUNS, 500);
export const CONF_LOW_SAMPLE_TRADES = num(process.env.CONF_LOW_SAMPLE_TRADES, 10);   // < 10 trades → LOW_SAMPLE
export const CONF_EARLY_DAYS = num(process.env.CONF_EARLY_DAYS, 3);                 // < 3 dagen → EARLY

// ── CANARY-QUEUE (Deel 21) ────────────────────────────────────────────────
export const VAL_QUEUE_MAX = num(process.env.VAL_QUEUE_MAX, 3);                     // max wachtende candidates

// ── ONDERHOUD (Deel 27) ────────────────────────────────────────────────────
export const VAL_TICK_MIN_INTERVAL_MIN = num(process.env.VAL_TICK_MIN_INTERVAL_MIN, 720); // uitgebreide validatie max 1× per 12u
