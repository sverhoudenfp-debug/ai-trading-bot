"use client";

// ── OVERVIEW — mission control: staat, KPI's, equity, posities, AI ────
// Alle data uit bestaande read-only endpoints (/api/paper/status,
// /api/paper/trades, /api/paper/candles). Geen eigen business-logica.

import { useStatus, useLivePrices, type PaperState, type PaperOrder } from "./status-store";
import { Panel, Kpi, Badge, pnlClass, eur, pct, ago, dt, Loading, EmptyState, useJson, EquityChart, Sparkline } from "./ui";

interface TradeRow {
  id: number; created_at: string | null; pair: string; side: string; price: number;
  size: number; reason: string; equity_after: number; pnl_eur: number | null; pnl_pct: number | null;
  strategy?: string | null; ai_explanation?: string | null;
  context?: { fees_eur?: number; slippage_eur?: number; hold_min?: number; exit_reason?: string } | null;
}
interface Aggregates {
  closed_trades: number; net_pnl_eur: number; winrate_pct: number | null; profit_factor: number | null;
  expectancy_eur: number | null; max_drawdown_pct: number; fees_eur: number; slippage_eur: number;
  start_equity_eur: number; last_equity_eur: number; equity_curve: { t: string; eq: number }[];
}

export default function Overview() {
  const status = useStatus();
  const prices = useLivePrices();
  const tradesQ = useJson<{ trades: TradeRow[]; aggregates: Aggregates | null; configured: boolean }>("/api/paper/trades?limit=500&aggregates=1", 45_000);

  if (!status) return <Loading h={300} />;
  if (status.configured === false) return <EmptyState title="Systeem niet geconfigureerd" hint="SUPABASE_URL ontbreekt — de bot draait, het dashboard kan geen data tonen." />;

  const pot = status.pot;
  const openStates = (status.states ?? []).filter((s) => s.status !== "flat");
  const exposure = (status.monitor as { exposure?: { notional_eur: number } } | undefined)?.exposure?.notional_eur ?? 0;
  const equity = pot ? pot.cash + exposure : null;
  const agg = tradesQ.data?.aggregates;
  const startEq = agg?.start_equity_eur ?? 1000;
  const retPct = equity !== null ? ((equity / startEq) - 1) * 100 : null;
  const dayPnl = pot && equity !== null ? equity - pot.day_start_equity : null;
  const recentExits = (tradesQ.data?.trades ?? []).filter((t) => t.pnl_eur !== null).slice(0, 12);
  const signals = status.agents?.signals ?? [];
  const aiRuns = status.agents?.aiRuns ?? [];
  const halted = pot?.halted ?? false;

  return (
    <>
      {halted && (
        <div className="halt-banner">
          <span className="halt-title">TRADING HALTED</span>
          <span className="dim">Daglimiet bereikt — de bot hervat automatisch na middernacht (Europe/Amsterdam). Bestaande posities worden gewoon bewaakt.</span>
        </div>
      )}

      <div className="kpi-grid" style={{ marginBottom: 14 }}>
        <Kpi label="Equity (pot)" value={eur(equity)} sub={`dagstart ${eur(pot?.day_start_equity)} · ${exposure > 0 ? `open ${eur(exposure)}` : "geen open notional"}`} />
        <Kpi label="Total PnL" value={eur(agg?.net_pnl_eur)} tone={(agg?.net_pnl_eur ?? 0) >= 0 ? "pos" : "neg"} sub={`vandaag ${eur(dayPnl)}`} />
        <Kpi label="Return" value={pct(retPct)} tone={(retPct ?? 0) >= 0 ? "pos" : "neg"} sub={`start €${startEq.toFixed(0)}`} />
        <Kpi label="Win Rate" value={agg?.winrate_pct === null || agg?.winrate_pct === undefined ? "—" : `${agg.winrate_pct}%`} sub={`${agg?.closed_trades ?? 0} trades`} />
        <Kpi label="Profit Factor" value={agg?.profit_factor ?? "—"} sub={`exp ${agg?.expectancy_eur !== null && agg?.expectancy_eur !== undefined ? eur(agg.expectancy_eur) : "—"} /trade`} />
        <Kpi label="Max Drawdown" value={`${agg?.max_drawdown_pct ?? "—"}%`} tone={(agg?.max_drawdown_pct ?? 0) >= 15 ? "neg" : null} />
        <Kpi label="Fees betaald" value={eur(agg?.fees_eur)} sub={`slippage ${eur(agg?.slippage_eur)}`} />
        <Kpi label="Trades 24u" value={((status.monitor as { trades_24h?: { closed: number } })?.trades_24h?.closed ?? "—")} sub={`totaal ${agg?.closed_trades ?? "—"} gesloten`} />
      </div>

      <div className="grid cols-2">
        <Panel title="Equity curve" note="paper equity na fees — high water mark">
          {tradesQ.loading ? <Loading h={240} /> : tradesQ.error ? <EmptyState title="Equity-curve onbeschikbaar" /> :
            agg ? <EquityChart points={agg.equity_curve} start={startEq} /> : <EmptyState title="Nog geen gesloten trades" />}
        </Panel>

        <Panel title="Open posities" note={`${openStates.length} actief`}>
          {openStates.length === 0 ? <EmptyState title="NO OPEN POSITIONS" hint="De bot heeft momenteel geen openstaande paper-posities." /> : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Coin</th><th>Side</th><th className="num">Entry</th><th className="num">Nu</th><th className="num">uPnL</th><th className="num">Hold</th><th>SL/TP</th><th>Strategie</th></tr></thead>
                <tbody>
                  {openStates.map((s) => {
                    const p = prices?.[s.pair] ?? s.entry_price;
                    const upnl = s.entry_price && p && s.size ? (p - s.entry_price) * s.size : null;
                    const upnlPct = s.entry_price && p ? ((p - s.entry_price) / s.entry_price) * 100 : null;
                    const holdMin = s.entry_time ? (Date.now() - Date.parse(s.entry_time)) / 60000 : null;
                    return (
                      <tr key={s.pair}>
                        <td className="mono">{s.pair.replace("-EUR", "")}</td>
                        <td><Badge tone={s.status === "long" ? "green" : "red"}>{s.status.toUpperCase()}</Badge></td>
                        <td className="num">{eur(s.entry_price, 2)}</td>
                        <td className="num">{p ? eur(p, 2) : "—"}</td>
                        <td className={`num ${pnlClass(upnl)}`}>{eur(upnl)} <span className="faint">({pct(upnlPct)})</span></td>
                        <td className="num dim">{holdMin !== null ? `${Math.floor(holdMin)}m` : "—"}</td>
                        <td className="num dim">{s.sl_pct ? `SL ${s.sl_pct}%` : "—"} / {s.tp_pct ? `TP ${s.tp_pct}%` : "—"}</td>
                        <td className="dim">{s.strategy ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <Panel title="Recente trades" note="laatste 12 gesloten">
          {recentExits.length === 0 ? <EmptyState title="Nog geen trades" /> : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Tijd</th><th>Coin</th><th>Strategie</th><th className="num">PnL</th><th className="num">PnL %</th><th className="num">Hold</th><th>Exit</th></tr></thead>
                <tbody>
                  {recentExits.map((t) => (
                    <tr key={t.id}>
                      <td className="dim mono">{t.created_at ? dt(t.created_at) : "—"}</td>
                      <td className="mono">{t.pair.replace("-EUR", "")}</td>
                      <td className="dim">{t.strategy ?? "—"}</td>
                      <td className={`num ${pnlClass(t.pnl_eur)}`}>{eur(t.pnl_eur)}</td>
                      <td className={`num ${pnlClass(t.pnl_pct)}`}>{pct(t.pnl_pct)}</td>
                      <td className="num dim">{t.context?.hold_min ? `${Math.round(t.context.hold_min)}m` : "—"}</td>
                      <td className="dim">{t.context?.exit_reason ?? t.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="AI activity" note={status.agents?.executeMode ? "AI execute-mode: aan" : "AI propose-only"}>
          {signals.length === 0 && aiRuns.length === 0 ? <EmptyState title="Geen AI-activiteit" hint="Nog geen signalen of AI-runs opgeslagen." /> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {signals.slice(0, 8).map((sig) => {
                const tone = sig.outcome === "executed" ? "green" : sig.outcome === "rejected" ? "red" : "neutral";
                return (
                  <div key={sig.id} style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: 13 }}>
                    <span className="faint mono" style={{ flex: "0 0 88px" }}>{ago(sig.created_at)} geleden</span>
                    <span className="mono" style={{ flex: "0 0 62px" }}>{sig.pair.replace("-EUR", "")}</span>
                    <span style={{ flex: "0 0 120px" }} className="dim">{sig.strategy_version}</span>
                    <Badge tone={tone as "green" | "red" | "neutral"} dot={false}>{sig.outcome}</Badge>
                    <span className="dim" style={{ fontSize: 12 }}>{sig.outcome_reason ?? sig.reason}</span>
                  </div>
                );
              })}
              {aiRuns.length > 0 && (
                <div className="faint" style={{ fontSize: 12 }}>
                  Laatste AI-run {ago(aiRuns[0].created_at)} geleden · {aiRuns[0].proposals} voorstellen · ${aiRuns[0].cost_usd_est?.toFixed(4)} (est) {aiRuns[0].error ? `· fout: ${aiRuns[0].error}` : ""}
                </div>
              )}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
