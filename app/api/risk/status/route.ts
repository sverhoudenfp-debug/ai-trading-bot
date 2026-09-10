// ── GET /api/risk/status — actuele Phase 1-risk-config (read-only) ──────
// Toont de waarden waar de risk engine op dit moment mee draait (env-
// tunable, dus niet hard-coded). Bevat alléén numerieke limits en
// drempels — geen secrets. Read-only; de UI mag hier niks mee wijzigen.
// De risk engine zelf (lib/risk/engine.ts) wordt NIET aangeraakt.

import { NextResponse } from "next/server";
import {
  RISK_MIN_PCT, RISK_MAX_PCT, RISK_DEFAULT_PCT,
  MAX_NOTIONAL_PCT, MAX_TOTAL_EXPOSURE_PCT, MAX_OPEN_POSITIONS,
  FEE_PCT, SLIPPAGE_PCT, ROUND_TRIP_COST_PCT, FEE_COVER_FACTOR, MIN_NET_RR,
  MIN_HOLD_MIN, COOLDOWN_MIN,
  MAX_ENTRIES_PER_PAIR_PER_HOUR, MAX_ENTRIES_PER_PAIR_PER_DAY,
  MAX_ENTRIES_PER_HOUR, MAX_ENTRIES_PER_DAY,
  DAILY_LOSS_LIMIT_MIN_PCT, DAILY_LOSS_LIMIT_MAX_PCT, DAILY_LOSS_LIMIT_DEFAULT_PCT,
  LOSS_VELOCITY_WINDOW_MIN, LOSS_VELOCITY_PAUSE_MIN,
  MAX_PROPOSALS_PER_RUN, AI_SL_MIN_PCT, AI_SL_MAX_PCT, AI_TP_MIN_PCT, AI_TP_MAX_PCT,
  AI_MAX_CALLS_PER_HOUR, AI_MAX_CALLS_PER_DAY, AI_MAX_COST_USD_PER_DAY,
} from "@/lib/risk/config";
import { CANARY_RISK_CAP_PCT } from "@/lib/evolution/config";
import { listLimitHistory } from "@/lib/risk/dailyLimit";

export const dynamic = "force-dynamic";

export async function GET() {
  const limitHistory = await listLimitHistory(7);   // read-only; leeg bij DB-fout
  return NextResponse.json({
    risk_per_trade_pct: { min: RISK_MIN_PCT, max: RISK_MAX_PCT, default: RISK_DEFAULT_PCT },
    notional: { max_per_trade_pct: MAX_NOTIONAL_PCT, max_total_exposure_pct: MAX_TOTAL_EXPOSURE_PCT, max_open_positions: MAX_OPEN_POSITIONS },
    fees: { fee_pct: FEE_PCT, slippage_pct: SLIPPAGE_PCT, round_trip_cost_pct: ROUND_TRIP_COST_PCT, fee_cover_factor: FEE_COVER_FACTOR, min_net_rr: MIN_NET_RR },
    timing: { min_hold_min: MIN_HOLD_MIN, cooldown_min: COOLDOWN_MIN },
    frequency: { per_pair_per_hour: MAX_ENTRIES_PER_PAIR_PER_HOUR, per_pair_per_day: MAX_ENTRIES_PER_PAIR_PER_DAY, per_hour: MAX_ENTRIES_PER_HOUR, per_day: MAX_ENTRIES_PER_DAY },
    daily_loss_limit: {
      min_pct: DAILY_LOSS_LIMIT_MIN_PCT, max_pct: DAILY_LOSS_LIMIT_MAX_PCT, default_pct: DAILY_LOSS_LIMIT_DEFAULT_PCT,
      adaptive: true,
      note: "circuit breaker — verhoogt nooit risk-per-trade/notional/exposure; max ±1pp per Amsterdamse handelsdag",
    },
    daily_loss_limit_pct: DAILY_LOSS_LIMIT_DEFAULT_PCT,
    loss_velocity: { window_min: LOSS_VELOCITY_WINDOW_MIN, pause_min: LOSS_VELOCITY_PAUSE_MIN },
    ai: { max_proposals_per_run: MAX_PROPOSALS_PER_RUN, sl_min_pct: AI_SL_MIN_PCT, sl_max_pct: AI_SL_MAX_PCT, tp_min_pct: AI_TP_MIN_PCT, tp_max_pct: AI_TP_MAX_PCT, max_calls_per_hour: AI_MAX_CALLS_PER_HOUR, max_calls_per_day: AI_MAX_CALLS_PER_DAY, max_cost_usd_per_day: AI_MAX_COST_USD_PER_DAY },
    evolution: { canary_risk_cap_pct: CANARY_RISK_CAP_PCT },
    live_trading: "IMPOSSIBLE — geen live-status in de lifecycle",
    daily_limit_history: limitHistory,
  });
}
