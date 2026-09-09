// ── AI-agent configuratie ────────────────────────────────────────────────
// Nieude risico-instellingen voor de gecombineerde AI-agent (9 sep 2026).
// De oude 1%-risico/-3%-daglimiet bleef gelden voor de regel-strategie;
// bij AI-signalen gelden deze bredere kaders, gecontroleerd door het
// veiligheids-laagje in lib/agents/orders.ts.

export const AI_RISK_MIN_PCT = 5;    // minimaal risico per AI-trade (% van de pot)
export const AI_RISK_MAX_PCT = 10;   // maximaal risico per AI-trade (% van de pot)
export const AI_DAY_LIMIT_PCT = 15;  // daglimiet -15% (ipv -3%): vangt 2 verlies-trades
                                      // op rij bij 10% risico, ~4 bij 5% risico
export const AI_SL_MIN_PCT = 1;      // geldige stop-loss range
export const AI_SL_MAX_PCT = 10;
export const AI_TP_MIN_PCT = 0.5;    // geldige take-profit range
export const AI_TP_MAX_PCT = 15;
export const AI_MAX_COST_PCT = 95;   // max % van de kas in één positie
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
