// ── kleine hulp: round-trip-kosten in research-context ─────────────────
import { FEE_PCT, SLIPPAGE_PCT } from "@/lib/risk/config";

export function RoundTripCostPct(): number {
  // fee per kant + slippage per kant, dubbelzijdig, in %
  return (FEE_PCT + SLIPPAGE_PCT) * 2;
}
