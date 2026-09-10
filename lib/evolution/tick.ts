// ── FASE 3: evolution-monitor-tick (aangeroepen door de order-agent) ────
// Bounded (cache: max 1× per 5 min), leest alléén: paper-orders sinds de
// activatie + signal-blocking-statistieken. Bepaalt per actieve versie:
//   INSUFFICIENT_DATA | OK | WARN | ROLLBACK
// Bij ROLLBACK: atomaire transitie PAPER_ACTIVE → ROLLED_BACK (+ reden +
// cooldown 24u). Bestaande positie van die strategie blijft gewoon onder
// de normale risk engine (SL/TP/exit-afhandeling verandert niets).
// FAALT NOOIT de order-flow: alles try/catch, fail-closed.

import { activePaperStrategies, RegistryRow, insertPaperMetrics } from "./db";
import { listOrdersSince } from "@/lib/paper/store";
import { computeMonitorVerdict, MonitorVerdict } from "./monitor";
import { rollbackStrategy } from "./registry";
import { clearRegistryCache } from "./live";

let lastTick = 0;

export interface TickResult {
  skipped: boolean;
  checked: number;
  rollbacks: { strategy: string; triggers: string[] }[];
  warnings: { strategy: string; warnings: string[] }[];
  errors: string[];
}

/**
 * Monitor-tick — roep 1× per order-agent-run; effectief max 1× per 5 min.
 * `signals` en `orders` worden als parameter doorgegeven zodat de caller
 * (die ze vaak al geladen heeft) geen dubbele queries doet.
 */
export async function evolutionMonitorTick(
  signals: { strategy_version?: string | null; outcome?: string | null }[],
  opts: { now?: Date; force?: boolean } = {}
): Promise<TickResult> {
  const now = opts.now ?? new Date();
  if (!opts.force && Date.now() - lastTick < 5 * 60_000) {
    return { skipped: true, checked: 0, rollbacks: [], warnings: [], errors: [] };
  }
  lastTick = Date.now();
  const out: TickResult = { skipped: false, checked: 0, rollbacks: [], warnings: [], errors: [] };

  let active: RegistryRow[] = [];
  try {
    active = await activePaperStrategies();
  } catch (e) {
    out.errors.push(`registry onbereikbaar (fail-closed, monitoring geskipt): ${String(e instanceof Error ? e.message : e)}`);
    return out;
  }

  for (const row of active) {
    try {
      out.checked += 1;
      const rm = (row.research_metrics as {
        oos?: { expectancyEur: number; netPnl: number; maxDrawdownPct: number; avgHoldMin: number; fees: number; trades: number };
      } | null) ?? null;
      const expected = {
        expectancyEur: rm?.oos?.expectancyEur ?? 0,
        netPnl: rm?.oos?.netPnl ?? 0,
        maxDrawdownPct: rm?.oos?.maxDrawdownPct ?? 0,
        avgHoldMin: rm?.oos?.avgHoldMin ?? 0,
        fees: rm?.oos?.fees ?? 0,
        trades: rm?.oos?.trades ?? 0,
      };
      const key = `evo/${row.strategy_id}@${row.version}`;
      const activatedIso = row.activated_at ?? new Date(0).toISOString();
      // volledige orderhistorie sinds activatie (paginering in listOrdersSince)
      const allSinceActivation = await listOrdersSince(activatedIso);
      const myOrders = allSinceActivation.filter((o) => (o.strategy ?? "").startsWith(key));
      const myEntries = myOrders.filter((o) => o.pnl_eur === null || o.pnl_eur === undefined).length;
      const mySignals = signals.filter((s) => (s.strategy_version ?? "").startsWith(key));

      const verdict = computeMonitorVerdict({
        orders: myOrders,
        entries: myEntries,
        blocked: {
          rejections: mySignals.filter((s) => s.outcome === "rejected").length,
          risk: mySignals.filter((s) => s.outcome === "blocked_risk").length,
          cooldown: mySignals.filter((s) => s.outcome === "blocked_cooldown").length,
          fee: mySignals.filter((s) => s.outcome === "blocked_fee_edge").length,
          errors: mySignals.filter((s) => s.outcome === "error").length,
        },
        activatedAt: row.activated_at ?? new Date().toISOString(),
        isCanary: row.canary,
        expected,
        now,
      });

      // metrics-snapshot wegschrijven (auditeerbaar, Deel 11)
      await insertPaperMetrics({
        registry_id: row.id,
        strategy_key: key,
        state: verdict.state,
        drift: verdict.drift,
        metrics: verdict.metrics,
        triggers: JSON.stringify(verdict.triggers),
        warnings: JSON.stringify(verdict.warnings),
      });

      if (verdict.state === "WARN") {
        out.warnings.push({ strategy: key, warnings: verdict.warnings });
      }
      if (verdict.state === "ROLLBACK") {
        const rb = await rollbackStrategy(row, "PAPER_ACTIVE", verdict.triggers, "evolution-monitor");
        if (rb.ok) {
          out.rollbacks.push({ strategy: key, triggers: verdict.triggers });
          clearRegistryCache(); // direct actueel voor de live-evaluatie
        } else {
          out.errors.push(`rollback faalde voor ${key}: ${rb.error}`);
        }
      }
    } catch (e) {
      out.errors.push(`monitor-fout voor ${row.strategy_id}@${row.version}: ${String(e instanceof Error ? e.message : e)}`);
    }
  }
  return out;
}

/** Evaluatie-oordeel na PAPER_VALIDATING (door de evolution-status-route). */
export function validationVerdictFromMonitor(v: MonitorVerdict): "PAPER_APPROVED" | "ROLLED_BACK" | "PAPER_ACTIVE" {
  if (v.state === "ROLLBACK") return "ROLLED_BACK";
  if (v.state === "OK" || v.state === "WARN") return "PAPER_APPROVED";
  return "PAPER_ACTIVE"; // INSUFFICIENT_DATA → terug naar meten
}
