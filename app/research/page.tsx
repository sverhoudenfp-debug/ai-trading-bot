"use client";

// ── RESEARCH — laboratorium: runs, hypotheses, candidates, verdicts ────
// Data: GET /api/research/status (read-only). Rejection-redenen komen
// rechtstreeks uit de evaluator — nooit zelf een reden verzinnen.

import { Panel, Badge, type BadgeTone, eur, dt, ago, Loading, EmptyState, useJson, statusTone } from "../ui";


interface Candidate {
  id: number; created_at: string; name: string; status: string; origin: string;
  score: number | null; sample_size: number | null; rejection_reasons: string[] | null;
  research_explanation: string | null;
  oos_metrics?: { trades?: number; netPnl?: number; expectancyEur?: number; winratePct?: number; profitFactor?: number; maxDrawdownPct?: number; fees?: number } | null;
  timeframe?: string | null; pairs?: string[] | null;
}
interface Run {
  id: number; created_at: string; mode?: string; status?: string; started_at?: string;
  finished_at?: string; summary?: string; duration_s?: number;
  ai?: { calls: number; cost_usd_est: number }; error?: string | null;
  [k: string]: unknown;
}

export default function ResearchPage() {
  const q = useJson<{
    configured: boolean; runs: Run[]; candidates: Candidate[];
    budget: { max_calls_per_day: number; max_cost_usd_per_day: number };
    note?: string;
  }>("/api/research/status", 60_000);

  if (q.loading) return <Loading h={300} />;
  if (q.data?.configured === false) return <EmptyState title="Research-tabellen niet beschikbaar" hint={q.data?.note ?? "supabase-phase2-setup.sql is nog niet gedraaid."} />;
  if (q.error || !q.data) return <EmptyState title="Research-status onbeschikbaar" />;

  const { runs, candidates, budget } = q.data;
  const verdict = (c: Candidate): { tone: BadgeTone; label: string } => {
    const s = c.status;
    if (s === "CANDIDATE") return { tone: "green", label: "ACCEPTED" };
    if (s === "REJECTED") return { tone: "red", label: "REJECTED" };
    return { tone: "neutral", label: s ? s.replace(/_/g, " ") : "UNKNOWN" };
  };

  return (
    <>
      <div className="kpi-grid" style={{ marginBottom: 14 }}>
        <div className="kpi"><span className="kpi-label">Research runs</span><span className="kpi-value">{runs.length}</span></div>
        <div className="kpi"><span className="kpi-label">Candidates totaal</span><span className="kpi-value">{candidates.length}</span></div>
        <div className="kpi"><span className="kpi-label">Geaccepteerd</span><span className="kpi-value">{candidates.filter((c) => c.status === "CANDIDATE").length}</span></div>
        <div className="kpi"><span className="kpi-label">Afgewezen</span><span className="kpi-value">{candidates.filter((c) => c.status === "REJECTED").length}</span></div>
        <div className="kpi"><span className="kpi-label">AI-budget</span><span className="kpi-value" style={{ fontSize: 16 }}>{budget.max_calls_per_day}/dag</span><span className="kpi-sub">max ${budget.max_cost_usd_per_day}/dag (Haiku)</span></div>
      </div>

      <Panel title="Candidates" note="hypotheses → spec-validatie → backtest → IS/OOS → walk-forward → robustness → evaluator">
        {candidates.length === 0 ? <EmptyState title="GEEN RESEARCH CANDIDATES" hint="Nog geen onderzochte strategie-hypotheses opgeslagen." /> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr>
                <th>Strategie</th><th>Herkomst</th><th>Verdict</th><th className="num">Score</th>
                <th className="num">Sample</th><th className="num">OOS trades</th><th className="num">OOS netto</th>
                <th className="num">OOS exp</th><th className="num">OOS wr</th><th className="num">OOS PF</th>
                <th className="num">OOS DD</th><th>Afwijsreden</th><th>Exploratie</th>
              </tr></thead>
              <tbody>
                {candidates.map((c) => {
                  const v = verdict(c);
                  return (
                    <tr key={c.id}>
                      <td className="mono">{c.name}</td>
                      <td className="dim">{c.origin === "ai" ? "AI-hypothese" : c.origin === "baseline" ? "baseline" : c.origin}</td>
                      <td><Badge tone={v.tone} dot={false}>{v.label}</Badge></td>
                      <td className="num">{c.score ?? "—"}</td>
                      <td className="num dim">{c.sample_size ?? "—"}</td>
                      <td className="num dim">{c.oos_metrics?.trades ?? "—"}</td>
                      <td className={`num ${(c.oos_metrics?.netPnl ?? 0) >= 0 ? "pos" : "neg"}`}>{c.oos_metrics?.netPnl !== undefined ? eur(c.oos_metrics.netPnl) : "—"}</td>
                      <td className="num dim">{c.oos_metrics?.expectancyEur !== undefined ? eur(c.oos_metrics.expectancyEur) : "—"}</td>
                      <td className="num dim">{c.oos_metrics?.winratePct !== undefined ? `${c.oos_metrics.winratePct}%` : "—"}</td>
                      <td className="num dim">{c.oos_metrics?.profitFactor !== undefined ? c.oos_metrics.profitFactor : "—"}</td>
                      <td className="num dim">{c.oos_metrics?.maxDrawdownPct !== undefined ? `${c.oos_metrics.maxDrawdownPct}%` : "—"}</td>
                      <td className="dim" style={{ maxWidth: 260, whiteSpace: "normal", fontSize: 12 }}>
                        {c.rejection_reasons?.length ? c.rejection_reasons.join(" · ") : "—"}
                      </td>
                      <td className="dim" title={c.research_explanation ?? ""} style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", fontSize: 12 }}>
                        {c.research_explanation ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Research runs" note={`${runs.length} recent`}>
        {runs.length === 0 ? <EmptyState title="Nog geen research-runs" /> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Run</th><th>Gestart</th><th>Duur</th><th>AI calls</th><th className="num">AI kosten</th><th>Status</th><th>Fout</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="mono dim">#{r.id}</td>
                    <td className="dim mono">{r.created_at ? `${dt(r.created_at)} (${ago(r.created_at)} geleden)` : "—"}</td>
                    <td className="dim mono">{r.duration_s ? `${r.duration_s}s` : "—"}</td>
                    <td className="num dim">{r.ai?.calls ?? "—"}</td>
                    <td className="num dim">{r.ai?.cost_usd_est !== undefined ? `$${r.ai.cost_usd_est.toFixed(4)}` : "—"}</td>
                    <td>{r.status === "ok" ? <Badge tone="green" dot={false}>OK</Badge> : r.status === "error" ? <Badge tone="red" dot={false}>ERROR</Badge> : <Badge tone="neutral" dot={false}>{r.status ?? "—"}</Badge>}</td>
                    <td className="dim" style={{ maxWidth: 300, whiteSpace: "normal", fontSize: 12 }}>{r.error ?? "—"}</td>
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
