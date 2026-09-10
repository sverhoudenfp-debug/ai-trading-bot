"use client";

// ── RISK CENTER — huidige staat vs. harde limits (Phase 1) ─────────────
// Data: GET /api/risk/status (de actuele configuratie waar de engine mee
// draait) + /api/paper/status (monitor: exposure, dagverlies, AI-gebruik).
// Read-only: de UI kan niets wijzigen aan de risk engine.

import { useStatus } from "../status-store";
import { Panel, Badge, Meter, eur, pct, dt, Loading, EmptyState, useJson } from "../ui";

interface DailyLimitRow {
  trading_date: string; previous_limit_pct: number; new_limit_pct: number; adjustment_pp: number;
  realized_return_pct: number | null; closed_trades: number | null; winrate_pct: number | null;
  daily_pnl_eur: number | null; performance_metric: string | null; adjustment_reason: string;
}

interface RiskCfg {
  risk_per_trade_pct: { min: number; max: number; default: number };
  notional: { max_per_trade_pct: number; max_total_exposure_pct: number; max_open_positions: number };
  fees: { fee_pct: number; slippage_pct: number; round_trip_cost_pct: number; fee_cover_factor: number; min_net_rr: number };
  timing: { min_hold_min: number; cooldown_min: number };
  frequency: { per_pair_per_hour: number; per_pair_per_day: number; per_hour: number; per_day: number };
  daily_loss_limit_pct: number;
  daily_loss_limit: { min_pct: number; max_pct: number; default_pct: number; adaptive: boolean; note: string };
  daily_limit_history: DailyLimitRow[];
  loss_velocity: { window_min: number; pause_min: number };
  ai: { max_proposals_per_run: number; sl_min_pct: number; sl_max_pct: number; tp_min_pct: number; tp_max_pct: number; max_calls_per_hour: number; max_calls_per_day: number; max_cost_usd_per_day: number };
  evolution: { canary_risk_cap_pct: number };
  live_trading: string;
}

export default function RiskPage() {
  const status = useStatus();
  const q = useJson<RiskCfg>("/api/risk/status");

  if (q.loading || !q.data) return <Loading h={300} />;
  if (q.error) return <EmptyState title="Risk-config onbeschikbaar" />;
  const cfg = q.data;

  const mon = (status?.monitor ?? {}) as {
    exposure?: { open_positions: number; notional_eur: number };
    daily_loss?: { day: string | null; day_start_equity: number; limit_pct: number; current_pct: number | null; halted: boolean } | null;
    trades_24h?: { entries: number; closed: number };
    ai_24h?: { calls: number; costUsd: number; errors: number };
  };

  const pot = status?.pot;
  const openPos = mon.exposure?.open_positions ?? 0;
  const exposure = mon.exposure?.notional_eur ?? 0;
  const equity = pot ? pot.cash + exposure : null;
  const exposurePct = equity && equity > 0 ? (exposure / equity) * 100 : 0;
  const dayLoss = mon.daily_loss;
  const limitNow = dayLoss?.limit_pct ?? cfg.daily_loss_limit?.default_pct ?? cfg.daily_loss_limit_pct;
  const dayPct = dayLoss?.current_pct ?? 0;
  const halted = pot?.halted ?? false;
  const ai = mon.ai_24h ?? { calls: 0, costUsd: 0, errors: 0 };

  return (
    <>
      {halted && (
        <div className="halt-banner">
          <span className="halt-title">TRADING HALTED</span>
          <span className="dim">
            Daglimiet −{limitNow}% bereikt{dayLoss?.day ? ` (handelsdag ${dayLoss.day})` : ""} · huidig {pct(dayPct)} ·
            dagstart {eur(pot?.day_start_equity)} · huidige equity {eur(equity)}. De bot hervat automatisch na middernacht (Europe/Amsterdam).
          </span>
        </div>
      )}

      <div className="kpi-grid" style={{ marginBottom: 14 }}>
        <div className="kpi">
          <span className="kpi-label">Dagverlies</span>
          <span className={"kpi-value " + (dayPct < 0 ? "neg" : "")}>{pct(dayPct)}</span>
          <Meter ratio={dayPct < 0 ? Math.abs(dayPct) / limitNow : 0} />
          <span className="kpi-sub">limiet −{limitNow}% (adaptief, band −{cfg.daily_loss_limit?.min_pct}%…−{cfg.daily_loss_limit?.max_pct}%) {dayPct < 0 ? `(${Math.min(100, Math.round((Math.abs(dayPct) / limitNow) * 100))}% verbruikt)` : "(0% verbruikt)"}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Exposure</span>
          <span className="kpi-value">{pct(exposurePct)}</span>
          <Meter ratio={exposurePct / cfg.notional.max_total_exposure_pct} />
          <span className="kpi-sub">max {cfg.notional.max_total_exposure_pct}% · {eur(exposure)} open</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Posities</span>
          <span className="kpi-value">{openPos} / {cfg.notional.max_open_positions}</span>
          <Meter ratio={openPos / cfg.notional.max_open_positions} />
          <span className="kpi-sub">harde limiet {cfg.notional.max_open_positions}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">AI kosten 24u</span>
          <span className="kpi-value">${ai.costUsd.toFixed(2)}</span>
          <Meter ratio={ai.costUsd / cfg.ai.max_cost_usd_per_day} />
          <span className="kpi-sub">budget ${cfg.ai.max_cost_usd_per_day}/dag · {ai.calls} calls</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Entries 24u</span>
          <span className="kpi-value">{mon.trades_24h?.entries ?? "—"}</span>
          <Meter ratio={(mon.trades_24h?.entries ?? 0) / cfg.frequency.per_day} />
          <span className="kpi-sub">frequentielimiet {cfg.frequency.per_day}/dag, {cfg.frequency.per_hour}/uur</span>
        </div>
      </div>

      <div className="grid cols-2">
        <Panel title="Harde limits — positiegrootte" note="risk engine is de autoriteit">
          <dl className="kv">
            <dt>Risico per trade</dt><dd>{cfg.risk_per_trade_pct.min}% – {cfg.risk_per_trade_pct.max}% (default {cfg.risk_per_trade_pct.default}%)</dd>
            <dt>Max notional per trade</dt><dd>{cfg.notional.max_per_trade_pct}% van equity</dd>
            <dt>Max totaal open</dt><dd>{cfg.notional.max_total_exposure_pct}% van equity</dd>
            <dt>Max gelijktijdige posities</dt><dd>{cfg.notional.max_open_positions}</dd>
            <dt>Canary risk cap</dt><dd>{cfg.evolution.canary_risk_cap_pct}% (evolution)</dd>
          </dl>
        </Panel>

        <Panel title="Harde limits — kosten & timing">
          <dl className="kv">
            <dt>Fee-aanname</dt><dd>{cfg.fees.fee_pct}% per kant</dd>
            <dt>Slippage-aanname</dt><dd>{cfg.fees.slippage_pct}%</dd>
            <dt>Round-trip kosten</dt><dd>{cfg.fees.round_trip_cost_pct}%</dd>
            <dt>Fee-cover factor (TP-guard)</dt><dd>TP ≥ {cfg.fees.round_trip_cost_pct}% × {cfg.fees.fee_cover_factor}</dd>
            <dt>Min netto RR</dt><dd>{cfg.fees.min_net_rr}</dd>
            <dt>Min hold-tijd</dt><dd>{cfg.timing.min_hold_min} min</dd>
            <dt>Cooldown per pair</dt><dd>{cfg.timing.cooldown_min} min na exit</dd>
          </dl>
        </Panel>

        <Panel title="Harde limits — frequentie & verliesbescherming">
          <dl className="kv">
            <dt>Per pair / uur</dt><dd>{cfg.frequency.per_pair_per_hour}</dd>
            <dt>Per pair / dag</dt><dd>{cfg.frequency.per_pair_per_day}</dd>
            <dt>Totaal / uur</dt><dd>{cfg.frequency.per_hour}</dd>
            <dt>Totaal / dag</dt><dd>{cfg.frequency.per_day}</dd>
            <dt>Dagverlieslimiet</dt><dd>−{limitNow}% op de pot → halt (adaptief: band −{cfg.daily_loss_limit?.min_pct}%…−{cfg.daily_loss_limit?.max_pct}%, max ±1pp/dag)</dd>
            <dt>Verlies-streak</dt><dd>{`3 verliezen binnen ${cfg.loss_velocity.window_min} min → ${cfg.loss_velocity.pause_min} min geen entries`}</dd>
          </dl>
        </Panel>

        <Panel title="AI-guards" note="AI stelt voor — de risk engine beslist">
          <dl className="kv">
            <dt>Max voorstellen per run</dt><dd>{cfg.ai.max_proposals_per_run}</dd>
            <dt>SL-bereik</dt><dd>{cfg.ai.sl_min_pct}% – {cfg.ai.sl_max_pct}%</dd>
            <dt>TP-bereik</dt><dd>{cfg.ai.tp_min_pct}% – {cfg.ai.tp_max_pct}%</dd>
            <dt>AI calls / uur · dag</dt><dd>{cfg.ai.max_calls_per_hour} · {cfg.ai.max_calls_per_day}</dd>
            <dt>AI kostenbudget</dt><dd>${cfg.ai.max_cost_usd_per_day}/dag</dd>
            <dt>AI-fouten 24u</dt><dd>{ai.errors}</dd>
          </dl>
        </Panel>
      </div>

        <Panel title="Adaptief daglimiet — beslishistorie" note="circuit breaker; verhoogt nooit trade-risico">
          {(cfg.daily_limit_history ?? []).length === 0 ? (
            <p className="faint" style={{ fontSize: 12, margin: 0 }}>
              Nog geen beslissingen opgeslagen (nieuwe tabel daily_limit_adjustments). Na de eerste handelsdag verschijnt hier per dag:
              vorig limiet → nieuw limiet, aanpassing, dagrendement en de exacte reden.
            </p>
          ) : (
            <table className="tbl" style={{ fontSize: 12 }}>
              <thead>
                <tr><th>Dag</th><th>Vorig</th><th>Nieuw</th><th>Δpp</th><th>Dagrend.</th><th>Trades</th><th>Reden</th></tr>
              </thead>
              <tbody>
                {(cfg.daily_limit_history ?? []).map((r) => (
                  <tr key={r.trading_date}>
                    <td>{r.trading_date}</td>
                    <td>−{Number(r.previous_limit_pct)}%</td>
                    <td>−{Number(r.new_limit_pct)}%</td>
                    <td>{Number(r.adjustment_pp) > 0 ? "+" : ""}{Number(r.adjustment_pp)}</td>
                    <td>{r.realized_return_pct === null ? "—" : `${Number(r.realized_return_pct) > 0 ? "+" : ""}${Number(r.realized_return_pct).toFixed(2)}%`}</td>
                    <td>{r.closed_trades ?? "—"}</td>
                    <td className="dim" style={{ maxWidth: 340 }}>{r.adjustment_reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

      <p className="faint" style={{ fontSize: 12 }}>
        {cfg.live_trading} · Alle waarden komen rechtstreeks uit de actuele configuratie (env-tunable) — niet uit de UI. Via dit dashboard kan niets worden gewijzigd.
      </p>
    </>
  );
}
