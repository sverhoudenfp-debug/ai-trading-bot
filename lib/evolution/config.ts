// ── FASE 3: centraal geconfigureerde drempels van de Evolution Engine ────
// Alle values env-tunable; defaults bewust gematigd (Deel 6: de gate mag
// "voldoende bewijs om zinvol in paper te testen" eisen — niet perfectie).
// De AI kan NIET bij deze waarden: het zijn pure code-constanten.

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

// ── VALIDATION GATE (research → paper) ─────────────────────────────────
export const GATE_MIN_TRADES_IS = num(process.env.GATE_MIN_TRADES_IS, 30);
export const GATE_MIN_TRADES_OOS = num(process.env.GATE_MIN_TRADES_OOS, 12);
export const GATE_MIN_OOS_EXPECTANCY_EUR = Number(process.env.GATE_MIN_OOS_EXPECTANCY_EUR ?? 0.05); // > €0,05/trade netto
export const GATE_MIN_OOS_NET_PNL_EUR = Number(process.env.GATE_MIN_OOS_NET_PNL_EUR ?? 0);        // > 0
export const GATE_MIN_PROFIT_FACTOR = num(process.env.GATE_MIN_PROFIT_FACTOR, 1.05);
export const GATE_MAX_OOS_DRAWDOWN_PCT = num(process.env.GATE_MAX_OOS_DRAWDOWN_PCT, 15);
export const GATE_MIN_WF_CONSISTENCY_PCT = num(process.env.GATE_MIN_WF_CONSISTENCY_PCT, 50);
export const GATE_MIN_ROBUSTNESS_PASS_RATIO = num(process.env.GATE_MIN_ROBUSTNESS_PASS_RATIO, 0.6);
export const GATE_MIN_SCORE = num(process.env.GATE_MIN_SCORE, 55);
// fee-sensitiviteit: de fee-scenario's (×1,5/×2) uit de robustheidstest
export const GATE_MIN_FEE_SCENARIO_PASS = num(process.env.GATE_MIN_FEE_SCENARIO_PASS, 0.4); // ≥1 van 2 fee-scenario's netto positief
export const GATE_MAX_SINGLE_COIN_SHARE = num(process.env.GATE_MAX_SINGLE_COIN_SHARE, 0.8);   // geen coin > 80% van de positieve netto

// ── BASELINE COMPARISON (Deel 7 — fee-aware) ──────────────────────────
export const BASELINE_MAX_TRADE_MULTIPLIER = num(process.env.BASELINE_MAX_TRADE_MULTIPLIER, 2.5);
// als de candidate ≥ × zo veel trades doet, moet de netto-verbetering ook
// ≥ MIN_NET_IMPROVEMENT_EUR per verdubbelde handelsdruk opleveren
export const BASELINE_MIN_NET_IMPROVEMENT_EUR = Number(process.env.BASELINE_MIN_NET_IMPROVEMENT_EUR ?? 10);

// ── PAPER ACTIVATION / CANARY (Deel 8-9) ───────────────────────────────
export const MAX_CONCURRENT_CANARIES = num(process.env.MAX_CONCURRENT_CANARIES, 1);
export const MAX_ACTIVE_PER_FAMILY = num(process.env.MAX_ACTIVE_PER_FAMILY, 1);
export const CANARY_RISK_CAP_PCT = num(process.env.CANARY_RISK_CAP_PCT, 0.25);   // canary: max 0,25% pot-risico per trade
export const CANARY_MAX_PAIRS = num(process.env.CANARY_MAX_PAIRS, 4);             // canary: subset van pairs
export const CANARY_MAX_TRADES_PER_DAY = num(process.env.CANARY_MAX_TRADES_PER_DAY, 4);

// ── PAPER VALIDATION (Deel 10) ─────────────────────────────────────────
export const PAPER_MIN_TRADES = num(process.env.PAPER_MIN_TRADES, 15);       // gesloten paper-trades vóór enig oordeel
export const PAPER_MIN_OBSERVATION_HOURS = num(process.env.PAPER_MIN_OBSERVATION_HOURS, 48);
export const PAPER_MIN_NET_PNL_EUR = Number(process.env.PAPER_MIN_NET_PNL_EUR ?? -2);   // ≥ −€2 om door te mogen
export const PAPER_MIN_EXPECTANCY_EUR = Number(process.env.PAPER_MIN_EXPECTANCY_EUR ?? -0.1);
export const PAPER_MIN_PROFIT_FACTOR = num(process.env.PAPER_MIN_PROFIT_FACTOR, 0.9);

// ── ROLLBACK TRIGGERS (Deel 13 — hard) ─────────────────────────────────
export const ROLLBACK_MAX_LOSS_EUR = Number(process.env.ROLLBACK_MAX_LOSS_EUR ?? -8);    // netto ≤ −€8 → rollback
export const ROLLBACK_MAX_LOSS_STREAK = num(process.env.ROLLBACK_MAX_LOSS_STREAK, 4);   // ≥4 verliezen op rij
export const ROLLBACK_MAX_DRAWDOWN_PCT = num(process.env.ROLLBACK_MAX_DRAWDOWN_PCT, 15);
export const ROLLBACK_MAX_FEE_SHARE_PCT = num(process.env.ROLLBACK_MAX_FEE_SHARE_PCT, 60); // fees ≥60% van gross
export const ROLLBACK_MAX_TRADES_PER_DAY = num(process.env.ROLLBACK_MAX_TRADES_PER_DAY, 8);
export const ROLLBACK_ERROR_COUNT = num(process.env.ROLLBACK_ERROR_COUNT, 3);           // ≥3 runtime-fouten

// ── EXPECTATION DRIFT (Deel 12) ───────────────────────────────────────
export const DRIFT_WARN_EXPECTANCY_FACTOR = num(process.env.DRIFT_WARN_EXPECTANCY_FACTOR, 0.5); // paper exp < 0,5× verwacht → warning
export const DRIFT_ROLLBACK_EXPECTANCY_NEG = Number(process.env.DRIFT_ROLLBACK_EXPECTANCY_NEG ?? -0.2); // paper exp ≤ −€0,2/trade bij ≥PAPER_MIN_TRADES → rollback
export const DRIFT_WARN_DD_FACTOR = num(process.env.DRIFT_WARN_DD_FACTOR, 1.5);         // paper DD > 1,5× verwacht → warning

// ── ROLLBACK COOLDOWN (Deel 14) ────────────────────────────────────────
export const ROLLBACK_COOLDOWN_HOURS = num(process.env.ROLLBACK_COOLDOWN_HOURS, 24);

// ── MUTATION (Deel 16/30) ──────────────────────────────────────────────
export const MAX_MUTATIONS_PER_CYCLE = num(process.env.MAX_MUTATIONS_PER_CYCLE, 3);

// ── REGIME SELECTIE (Deel 18) ──────────────────────────────────────────
export const MIN_REGIME_TRADES = num(process.env.MIN_REGIME_TRADES, 10); // <10 backtest-trades in regime → INSUFFICIENT_REGIME_DATA

// ── SELECTION WEIGHTS (Deel 19 — gedocumenteerde combinatie) ────────────
// prioriteit = gate/status (hard)  >>>  score-combinatie (zacht):
//   soft = 0,45·researchScore + 0,35·paperScore + 0,20·regimeFit, × learnWeight
// learnWeight (strategy_versions, 0,5-1,6) kan alleen dempen — nooit een
// geblokkeerde of gerolled-back strategie promoten, nooit risk limieten
// veranderen. Weights zijn dus één input, géén toestemming.
export const WEIGHT_RESEARCH = num(process.env.WEIGHT_RESEARCH, 0.45);
export const WEIGHT_PAPER = num(process.env.WEIGHT_PAPER, 0.35);
export const WEIGHT_REGIME = num(process.env.WEIGHT_REGIME, 0.20);
