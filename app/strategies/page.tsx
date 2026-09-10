"use client";

// ── STRATEGIES — registry (Phase 3) + live prestaties per strategie ─────
// Data: GET /api/evolution/status (registry) + /api/paper/status (7-daagse
// strategie-stats). Read-only; statusbadges volgen de échte lifecycle.

import { useStatus } from "../status-store";
import { Panel, Badge, eur, dt, Loading, EmptyState, useJson, statusTone } from "../ui";

interface RegistryRow {
  id: number; created_at: string; strategy_id: string; family: string; version: string;
  status: string; canary: boolean; is_legacy: boolean; score: number | null;
  activated_at: string | null; deactivated_at: string | null;
  research_metrics?: { oos?: { trades?: number; expectancyEur?: number; netPnl?: number; maxDrawdownPct?: number; winratePct?: number } } | null;
}

export default function StrategiesPage() {
  const status = useStatus();
  const evo = useJson<{ configured: boolean; registry: RegistryRow[] }>("/api/evolution/status", 60_000);

  if (evo.loading) return <Loading h={300} />;
  if (evo.error) return <EmptyState title="Strategie-register onbeschikbaar" hint="Evolution-statusendpoint reageert niet." />;

  const registry = evo.data?.registry ?? [];
  const liveStats = status?.agents?.strategyStats ?? [];

  return (
    <>
      <Panel title="Strategy registry" note={`${registry.length} versies in de lifecycle · live trading bestaat hier niet`}>
        {registry.length === 0 ? (
          <EmptyState title="GEEN STRATEGIE-VERSIES" hint="De evolution-engine heeft nog geen versie door de validation gate gekregen — alles werd terecht afgewezen. Zie Research voor de afwijzingsredenen." />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr>
                <th>Strategie</th><th>Versie</th><th>Familie</th><th>Status</th><th>Canary</th>
                <th className="num">Score</th><th className="num">OOS trades</th><th className="num">OOS exp</th>
                <th className="num">OOS DD</th><th>Aangemaakt</th><th>Geactiveerd</th>
              </tr></thead>
              <tbody>
                {registry.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.strategy_id}</td>
                    <td className="mono dim">{r.version}</td>
                    <td className="dim">{r.family}</td>
                    <td><Badge tone={statusTone(r.status)} dot={false}>{r.status.replace(/_/g, " ")}</Badge></td>
                    <td>{r.canary ? <Badge tone="cyan" dot={false}>CANARY</Badge> : <span className="faint">—</span>}</td>
                    <td className="num">{r.score ?? "—"}</td>
                    <td className="num dim">{r.research_metrics?.oos?.trades ?? "—"}</td>
                    <td className="num dim">{r.research_metrics?.oos?.expectancyEur !== undefined ? eur(r.research_metrics.oos.expectancyEur) : "—"}</td>
                    <td className="num dim">{r.research_metrics?.oos?.maxDrawdownPct !== undefined ? `${r.research_metrics.oos.maxDrawdownPct}%` : "—"}</td>
                    <td className="dim mono">{dt(r.created_at)}</td>
                    <td className="dim mono">{r.activated_at ? dt(r.activated_at) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Live strategie-prestaties" note="laatste 7 dagen paper trading (bot-strategieën, geen versie-register)">
        {liveStats.length === 0 ? <EmptyState title="Geen strategie-stats" hint="Nog geen gesloten trades in de laatste 7 dagen." /> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Strategie</th><th className="num">Trades</th><th className="num">Winrate</th><th className="num">Netto PnL</th></tr></thead>
              <tbody>
                {liveStats.map((s) => (
                  <tr key={s.strategy}>
                    <td className="mono">{s.strategy}</td>
                    <td className="num">{s.trades}</td>
                    <td className="num">{s.winrate}%</td>
                    <td className={`num ${s.pnl_eur >= 0 ? "pos" : "neg"}`}>{eur(s.pnl_eur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
