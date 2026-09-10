// ── AI-agent configuratie ────────────────────────────────────────────────
// Fase 1: alle risico-limieten (risico per trade, notional, exposure,
// fee-guard, cooldown, frequency, daglimiet, AI-budget) zijn verhuisd naar
// lib/risk/config.ts — EÉN centrale plek. Hier blijven alleen de
// AI-specifieke instellingen over die geen risico zijn.

// Slim interval: open posities of hoge volatiliteit → AI scant elke minuut
// (cron-tik); rustige markt → hoogstens elke AI_QUIET_INTERVAL_MIN minuten.
export const AI_QUIET_INTERVAL_MIN = Number(process.env.AI_QUIET_INTERVAL_MIN ?? "15");
export const AI_VOLATILITY_PCT = Number(process.env.AI_VOLATILITY_PCT ?? "1.2"); // % 15-min range
export const AI_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";

// Testmodus: AI voorstellen loggen maar NIET laten uitvoeren.
// Zet AI_PROPOSALS_EXECUTE=on in Vercel om te koppelen aan de order-agent.
export const aiExecuteEnabled = process.env.AI_PROPOSALS_EXECUTE === "on";

// Indicatieve Haiku-prijzen per miljoen tokens (voor kosten-schatting)
export const PRICE_PER_MTOK = { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 };
