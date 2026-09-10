"use client";

// ── SYSTEM — technische status van alle engines + laatste runs ──────────
// Alles afgeleid uit de bestaande read-only endpoints. "ONLINE" betekent:
// geconfigureerd én de laatste bekende activiteit is vers/geen fout.

import { useStatus } from "../status-store";
import { Panel, Badge, type BadgeTone, ago, dt, Loading, EmptyState, useJson } from "../ui";

interface EvoStatus { configured: boolean; validation: { runs: { created_at: string }[] }; }
interface ResearchStatus { configured: boolean; runs: { created_at: string }[]; }

export default function SystemPage() {
  const status = useStatus();
  const evo = useJson<EvoStatus>("/api/evolution/status", 60_000);
  const res = useJson<ResearchStatus>("/api/research/status", 60_000);

  if (!status) return <Loading h={300} />;

  const states = status.states ?? [];
  const lastTickIso = states.map((s) => s.updated_at ?? "").sort().pop() ?? "";
  const blofin = status.blofin;
  const agents = status.agents;
  const monitor = (status.monitor ?? {}) as { available?: boolean };

  const fresh = (iso: string | null | undefined, maxMin: number) =>
    iso ? (Date.now() - Date.parse(iso)) / 60000 <= maxMin : false;

  const engines: { name: string; note: string; state: "ok" | "warn" | "err"; detail: string }[] = [
    {
      name: "Trading engine (paper)",
      note: "order-agent via cron (1 min)",
      state: status.configured === false ? "err" : fresh(lastTickIso, 10) ? "ok" : "warn",
      detail: lastTickIso ? `laatste bot-tick ${ago(lastTickIso)} geleden (${dt(lastTickIso)})` : "nog geen tick ontvangen",
    },
    {
      name: "Risk engine",
      note: "Phase 1-guards, onafhankelijk van de AI",
      state: "ok",
      detail: "actief — limieten zichtbaar onder Risk",
    },
    {
      name: "Paper engine (pot)",
      note: "gedeelde pot, BloFin demo-mirror",
      state: status.pot ? "ok" : "warn",
      detail: status.pot ? `pot ${status.pot.cash.toFixed(2)} · dagstart ${status.pot.day_start_equity.toFixed(2)}` : "pot niet geïnitialiseerd",
    },
    {
      name: "Research engine",
      note: "Phase 2 — hypotheses + backtests",
      state: res.data?.configured ? "ok" : "warn",
      detail: res.data?.configured
        ? (res.data.runs?.[0] ? `laatste run ${ago(res.data.runs[0].created_at)} geleden` : "geconfigureerd, nog geen runs")
        : "tabellen niet beschikbaar (migration niet gedraaid)",
    },
    {
      name: "Evolution engine",
      note: "Phase 3 — lifecycle + canary",
      state: evo.data?.configured ? "ok" : "warn",
      detail: evo.data?.configured ? "registry bereikbaar" : "registry niet geconfigureerd",
    },
    {
      name: "Validation engine",
      note: "Phase 4 — drift + approval gate",
      state: evo.data?.configured ? "ok" : "warn",
      detail: evo.data?.validation?.runs?.[0]
        ? `laatste run ${ago(evo.data.validation.runs[0].created_at)} geleden`
        : "gereed — nog geen runs (niets te valideren)",
    },
    {
      name: "Supabase",
      note: "data-opslag (source of truth)",
      state: status.configured ? "ok" : "err",
      detail: status.configured ? "verbonden — tabellen bereikbaar" : "niet geconfigureerd",
    },
    {
      name: "BloFin DEMO",
      note: "paper-mirror account (nooit live)",
      state: blofin?.live ? (blofin.error ? "warn" : "ok") : blofin?.configured ? "warn" : "warn",
      detail: blofin?.live
        ? `verbonden · equity $${blofin.equityUsd?.toFixed(2) ?? "—"} · ${blofin.positions.length} posities`
        : blofin?.error ? `fout: ${blofin.error}` : "niet verbonden (alleen demo mogelijk)",
    },
    {
      name: "AI provider (Anthropic Haiku)",
      note: "analyse-agent, budgetbewaakt",
      state: agents ? (agents.aiLast?.error ? "err" : agents.aiLast ? "ok" : "warn") : "warn",
      detail: agents?.aiLast
        ? `laatste run ${ago(agents.aiLast.created_at)} geleden${agents.aiLast.error ? ` · fout: ${agents.aiLast.error}` : ""}`
        : "nog geen AI-runs opgeslagen",
    },
  ];

  const toneOf = (s: "ok" | "warn" | "err"): BadgeTone => (s === "ok" ? "green" : s === "warn" ? "amber" : "red");
  const labelOf = (s: "ok" | "warn" | "err") => (s === "ok" ? "ONLINE" : s === "warn" ? "WARNING" : "ERROR");

  return (
    <>
      <Panel title="Systeemstatus" note="paper trading — live trading bestaat niet in deze codebase">
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Engine</th><th>Rol</th><th>Status</th><th>Detail</th></tr></thead>
            <tbody>
              {engines.map((e) => (
                <tr key={e.name}>
                  <td style={{ fontWeight: 600 }}>{e.name}</td>
                  <td className="dim">{e.note}</td>
                  <td><Badge tone={toneOf(e.state)}>{labelOf(e.state)}</Badge></td>
                  <td className="dim" style={{ whiteSpace: "normal", fontSize: 12.5 }}>{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <Panel title="Laatste runs">
          <dl className="kv">
            <dt>Bot-tick (cron elke minuut)</dt><dd>{lastTickIso ? `${ago(lastTickIso)} geleden` : "—"}</dd>
            <dt>AI-run</dt><dd>{agents?.aiLast ? `${ago(agents.aiLast.created_at)} geleden` : "—"}</dd>
            <dt>Research-run</dt><dd>{res.data?.runs?.[0] ? `${ago(res.data.runs[0].created_at)} geleden` : "—"}</dd>
            <dt>Validation-run</dt><dd>{evo.data?.validation?.runs?.[0] ? `${ago(evo.data.validation.runs[0].created_at)} geleden` : "—"}</dd>
            <dt>Monitor-beschikbaarheid</dt><dd>{monitor.available ? "volledig" : "beperkt (optionele velden)"}</dd>
            <dt>Dashboarddata</dt><dd>{ago((status as { __atIso?: string }).__atIso)} geleden opgehaald</dd>
          </dl>
        </Panel>

        <Panel title="Agent-activiteit (fouten)" note="uit agent_runs — laatste 20">
          {!agents?.aiRuns || agents.aiRuns.length === 0 ? <EmptyState title="Geen AI-runs gelogd" /> : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Tijd</th><th className="num">Voorstellen</th><th className="num">Kosten (est)</th><th>Fout</th></tr></thead>
                <tbody>
                  {agents.aiRuns.map((r, i) => (
                    <tr key={i}>
                      <td className="dim mono">{dt(r.created_at)}</td>
                      <td className="num">{r.proposals}</td>
                      <td className="num dim">${(r.cost_usd_est ?? 0).toFixed(4)}</td>
                      <td className={r.error ? "neg" : "dim"} style={{ whiteSpace: "normal", fontSize: 12 }}>{r.error ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
