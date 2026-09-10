"use client";

// ── VALIDATION — Phase 4: lifecycle, drift-dimensies, canary, runs ─────
// Data: GET /api/evolution/status (registry, validation.runs met volledig
// rapport, paperMetrics). Read-only; de lifecycle toont de ÉCHTE status.

import { Panel, Badge, eur, dt, ago, Loading, EmptyState, useJson, statusTone } from "../ui";

interface RegistryRow {
  id: number; created_at: string; strategy_id: string; family: string; version: string;
  status: string; canary: boolean; activated_at: string | null;
}
interface DriftDim { dimension: string; expected: string; actual: string; delta: string; level: string }
interface ValReport {
  metrics?: {
    observationDays?: number; closed?: number; activeDays?: number;
    netPnl?: number; fees?: number; slippage?: number;
    confidence?: { label?: string };
  };
  drift?: { dimensions?: DriftDim[] };
  criteria?: { name: string; pass: boolean }[];
}
interface ValRun {
  id: number; created_at: string; execution_id: string; registry_id: number;
  strategy_key: string | null; verdict: string; duration_ms: number | null;
  report: ValReport | string | null;
}
interface EvoPayload {
  configured: boolean;
  registry: RegistryRow[];
  validation: { runs: ValRun[]; paperMetrics: Record<string, unknown[]> };
  live_trading: string;
}

/** volledige lifecycle — exact de state-machine uit lib/evolution/lifecycle.ts */
const FLOW = [
  "HYPOTHESIS", "TESTING", "RESEARCH_CANDIDATE", "VALIDATION_PENDING", "PAPER_CANDIDATE",
  "PAPER_ACTIVE", "VALIDATION_EARLY", "VALIDATION_PROGRESS", "VALIDATION_READY", "PAPER_APPROVED",
];
const VALIDATION_STATUSES = ["VALIDATION_EARLY", "VALIDATION_PROGRESS", "VALIDATION_READY", "WAITING_FOR_CANARY_SLOT", "PAPER_CANDIDATE"];

function parseReport(r: ValRun["report"]): ValReport | null {
  if (!r) return null;
  if (typeof r === "string") { try { return JSON.parse(r); } catch { return null; } }
  return r;
}

export default function ValidationPage() {
  const q = useJson<EvoPayload>("/api/evolution/status", 60_000);
  if (q.loading) return <Loading h={300} />;
  if (q.error || q.data?.configured === false) return <EmptyState title="Validation-status onbeschikbaar" />;

  const { registry, validation } = q.data!;
  const runs = (validation?.runs ?? []).map((r) => ({ ...r, parsed: parseReport(r.report) }));
  const canary = registry.find((r) => r.status === "PAPER_ACTIVE" && r.canary) ?? null;
  const reached = new Set(registry.map((r) => r.status));
  const currentIx = Math.max(-1, ...[...reached].map((s) => FLOW.indexOf(s)).filter((i) => i >= 0));
  const inValidation = registry.filter((r) => VALIDATION_STATUSES.includes(r.status));

  return (
    <>
      <Panel title="Lifecycle" note={q.data!.live_trading}>
        <div className="lifecycle">
          {FLOW.map((f, i) => (
            <span key={f} style={{ display: "contents" }}>
              <span className={"lc-node" + (reached.has(f) ? " current" : i <= currentIx ? " done" : "")}>{f.replace(/_/g, " ")}</span>
              {i < FLOW.length - 1 && <span className="lc-sep">→</span>}
            </span>
          ))}
        </div>
        <p className="faint" style={{ fontSize: 12, marginBottom: 0, marginTop: 8 }}>
          PAPER APPROVED is het eindpunt van deze codebase — een LIVE-status bestaat niet (DB-constraint). Falende takken uit de lifecycle: INSUFFICIENT_DATA, FAILED, ROLLED_BACK — alleen getoond als ze écht in het register voorkomen.
        </p>
        <div className="lifecycle" style={{ marginTop: 8 }}>
          {["INSUFFICIENT_DATA", "FAILED", "ROLLED_BACK"].map((f) => reached.has(f) ? <span key={f} className="lc-node fail">{f.replace(/_/g, " ")}</span> : null)}
        </div>
      </Panel>

      <div className="grid cols-2">
        <Panel title="Paper canary" note={canary ? "actief" : "geen"}>
          {!canary ? <EmptyState title="NO ACTIVE PAPER CANARY" hint="Zodra een candidate de evolution-gate passeert, verschijnt hier de canary met risk-cap, startdatum en status." /> : (
            <dl className="kv">
              <dt>Strategie</dt><dd>{canary.strategy_id}@{canary.version}</dd>
              <dt>Risk cap</dt><dd>0,25% per trade (canary-cap)</dd>
              <dt>Start</dt><dd>{dt(canary.activated_at)}</dd>
              <dt>Status</dt><dd>{canary.status}</dd>
            </dl>
          )}
        </Panel>

        <Panel title="In validatie / wachtend">
          {inValidation.length === 0 ? <EmptyState title="Niets in validatie" hint="Geen strategie-versies in een validation-status." /> : (
            <div className="tbl-wrap"><table className="tbl">
              <thead><tr><th>Strategie</th><th>Status</th><th>Sinds</th></tr></thead>
              <tbody>
                {inValidation.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.strategy_id}@{r.version}</td>
                    <td><Badge tone={statusTone(r.status)} dot={false}>{r.status.replace(/_/g, " ")}</Badge></td>
                    <td className="dim mono">{ago(r.created_at)} geleden</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Panel>
      </div>

      <Panel title="Validatie-runs" note={`${runs.length} runs · gebonden: max 1×/12u, 1×/strategie/dag`}>
        {runs.length === 0 ? (
          <EmptyState title="GEEN VALIDATIE-RUNS" hint="Er valt nog niks te valideren: geen strategie in validatie. De tick draait mee met de order-loop." />
        ) : runs.slice(0, 5).map((r) => {
          const rep = r.parsed;
          const m = rep?.metrics;
          const dims = rep?.drift?.dimensions ?? [];
          return (
            <Panel key={r.id} title={`${r.strategy_key ?? r.registry_id} — ${r.verdict}`} note={`${dt(r.created_at)} · ${r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : ""}`}>
              {m && (
                <div className="kpi-grid" style={{ marginBottom: 10 }}>
                  <div className="kpi"><span className="kpi-label">Observatie</span><span className="kpi-value" style={{ fontSize: 16 }}>{m.observationDays !== undefined ? `${m.observationDays}d` : "—"}</span></div>
                  <div className="kpi"><span className="kpi-label">Closed trades</span><span className="kpi-value" style={{ fontSize: 16 }}>{m.closed ?? "—"}</span></div>
                  <div className="kpi"><span className="kpi-label">Actieve dagen</span><span className="kpi-value" style={{ fontSize: 16 }}>{m.activeDays ?? "—"}</span></div>
                  <div className="kpi"><span className="kpi-label">Netto</span><span className={"kpi-value " + ((m.netPnl ?? 0) >= 0 ? "pos" : "neg")} style={{ fontSize: 16 }}>{eur(m.netPnl)}</span></div>
                  <div className="kpi"><span className="kpi-label">Fees</span><span className="kpi-value" style={{ fontSize: 16 }}>{eur(m.fees)}</span></div>
                  <div className="kpi"><span className="kpi-label">Confidence</span><span className="kpi-value" style={{ fontSize: 16 }}>{m.confidence?.label ?? "—"}</span></div>
                </div>
              )}
              {dims.length > 0 && (
                <div className="tbl-wrap"><table className="tbl">
                  <thead><tr><th>Dimensie</th><th className="num">Verwacht</th><th className="num">Gerealiseerd</th><th className="num">Delta</th><th>Drift</th></tr></thead>
                  <tbody>
                    {dims.map((d) => (
                      <tr key={d.dimension}>
                        <td className="dim">{d.dimension.replace(/_/g, " ")}</td>
                        <td className="num">{d.expected}</td>
                        <td className="num">{d.actual}</td>
                        <td className="num dim">{d.delta}</td>
                        <td><Badge tone={d.level === "NORMAL" ? "green" : d.level === "WARNING" ? "amber" : "red"} dot={false}>{d.level}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
              {rep?.criteria && rep.criteria.length > 0 && (
                <p className="faint" style={{ fontSize: 12, marginBottom: 0, marginTop: 8 }}>
                  Gate: {rep.criteria.filter((c) => c.pass).length}/{rep.criteria.length} criteria gehaald{rep.criteria.filter((c) => !c.pass).length > 0 ? ` — niet gehaald: ${rep.criteria.filter((c) => !c.pass).map((c) => c.name).join(", ")}` : ""}
                </p>
              )}
            </Panel>
          );
        })}
      </Panel>
    </>
  );
}
