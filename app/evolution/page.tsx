// ── /evolution — Fase 3 dashboard: lifecycle, drift en rollbacks ────────
// Correcte data > design. Toont: actieve paper-strategieën, candidates,
// research-resultaten, paper-prestaties vs backtest, rollbacks, historie.

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface RegistryRow {
  id: number;
  created_at: string;
  strategy_id: string;
  family: string;
  version: string;
  parent_strategy_id: string | null;
  status: string;
  canary: boolean;
  is_legacy: boolean;
  score: number | null;
  hypothesis: string | null;
  research_metrics: unknown;
  activated_at: string | null;
  rollback_reason: string | null;
  activation_reason: string | null;
}

interface ActivationRow {
  id: number;
  created_at: string;
  registry_id: number;
  action: string;
  from_status: string | null;
  to_status: string | null;
  reason: string;
  performed_by: string;
}

interface ValRun {
  id: number; created_at: string; strategy_key: string | null;
  verdict: string; duration_ms: number | null;
  report?: { metrics?: { closed?: number; netPnl?: number; fees?: number; expectancyEur?: number; maxDrawdownPct?: number }; drift?: { worst?: string } } | string | null;
}

interface StatusResp {
  configured: boolean;
  registry: RegistryRow[];
  activations: ActivationRow[];
  validation?: { runs: ValRun[]; paperMetrics: Record<string, unknown[]> };
  live_trading: string;
}

function rm(o: unknown): string {
  // research_metrics zijn een JSON-string of object
  try {
    const m = typeof o === "string" ? JSON.parse(o) : o;
    return m as unknown as string;
  } catch { return ""; }
}

function oosOf(row: RegistryRow): { expectancyEur?: number; netPnl?: number; trades?: number; maxDrawdownPct?: number; fees?: number; profitFactor?: number } | null {
  const m = rm(row.research_metrics) as { oos?: { expectancyEur?: number; netPnl?: number; trades?: number; maxDrawdownPct?: number; fees?: number; profitFactor?: number } } | "";
  return m && (m as { oos?: object }).oos ? (m as { oos: object }).oos as never : null;
}

const statusColor: Record<string, string> = {
  PAPER_ACTIVE: "bg-emerald-100 text-emerald-800",
  PAPER_CANDIDATE: "bg-blue-100 text-blue-800",
  PAPER_VALIDATING: "bg-indigo-100 text-indigo-800",
  PAPER_APPROVED: "bg-emerald-100 text-emerald-800",
  RESEARCH_CANDIDATE: "bg-amber-100 text-amber-800",
  VALIDATION_PENDING: "bg-amber-100 text-amber-800",
  ROLLED_BACK: "bg-red-100 text-red-800",
  REJECTED: "bg-neutral-200 text-neutral-700",
  INSUFFICIENT_DATA: "bg-neutral-100 text-neutral-600",
  LEGACY: "bg-violet-100 text-violet-800",
  DEPRECATED: "bg-neutral-200 text-neutral-500",
};

export default function EvolutionPage() {
  const [data, setData] = useState<StatusResp | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () =>
    fetch("/api/evolution/status")
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch((e) => setErr(String(e)));

  useEffect(() => { load(); }, []);

  const rows = data?.registry ?? [];
  const active = rows.filter((r) => r.status === "PAPER_ACTIVE" || r.status === "PAPER_VALIDATING");
  const candidates = rows.filter((r) => r.status === "PAPER_CANDIDATE" || r.status === "VALIDATION_PENDING" || r.status === "RESEARCH_CANDIDATE");
  const rollbacks = (data?.activations ?? []).filter((a) => a.action === "rollback");

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <main className="mx-auto max-w-6xl p-6 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold">Strategy Evolution — Fase 3</h1>
            <p className="text-sm text-neutral-600">
              Research → Validation Gate → PAPER canary → drift → rollback. {data?.live_trading}
            </p>
          </div>
          <div className="flex gap-2 items-center text-sm">
            <Link href="/research" className="text-blue-700 underline">research</Link>
            <Link href="/ai" className="text-blue-700 underline">ai</Link>
            <span className="text-neutral-500">cycle starten: <code className="text-xs">npm run evolution</code> lokaal, of POST /api/evolution/run met token</span>
          </div>
        </div>

        {err && <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">{err}</div>}
        {data && !data.configured && (
          <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
            Registry niet geconfigureerd (tabellen ontbreken?) — draai supabase-phase3-setup.sql. Fail-closed: geen activatie.
          </div>
        )}

        {/* ACTIEF */}
        <section className="rounded-lg border bg-white p-4">
          <h2 className="font-semibold mb-2">Actieve paper-strategieën ({active.length})</h2>
          {active.length === 0 && <p className="text-sm text-neutral-500">Geen actieve evolution-strategieën.</p>}
          {active.map((r) => {
            const oos = oosOf(r);
            return (
              <div key={r.id} className="border-t py-2 text-sm">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">evo/{r.strategy_id}@{r.version}</span>
                  <span className={`rounded px-2 py-0.5 text-xs ${statusColor[r.status] ?? ""}`}>{r.status}</span>
                  {r.canary && <span className="rounded bg-orange-100 text-orange-800 px-2 py-0.5 text-xs">PAPER CANARY</span>}
                  <span className="text-neutral-500">score {r.score ?? "-"} · geactiveerd {r.activated_at?.slice(0, 16).replace("T", " ") ?? "-"}</span>
                </div>
                <p className="text-neutral-600 mt-1">
                  backtest(OOS): exp €{oos?.expectancyEur ?? "-"}/trade · netto €{oos?.netPnl ?? "-"} · DD {oos?.maxDrawdownPct ?? "-"}% —
                  paper-metrics: zie strategy_paper_metrics (drift-monitor draait in de order-tick)
                </p>
                {r.activation_reason && <p className="text-neutral-500 text-xs mt-1">reden: {r.activation_reason}</p>}
              </div>
            );
          })}
        </section>

        {/* CANDIDATES */}
        <section className="rounded-lg border bg-white p-4">
          <h2 className="font-semibold mb-2">Candidates in de lifecycle ({candidates.length})</h2>
          {candidates.length === 0 && <p className="text-sm text-neutral-500">Geen open kandidaten — de laatste cycle leverde NO VALID CANDIDATE (eerlijk resultaat).</p>}
          {candidates.map((r) => (
            <div key={r.id} className="border-t py-2 text-sm flex items-center gap-2 flex-wrap">
              <span className="font-medium">{r.strategy_id}@{r.version}</span>
              <span className={`rounded px-2 py-0.5 text-xs ${statusColor[r.status] ?? ""}`}>{r.status}</span>
              <span className="text-neutral-500">score {r.score ?? "-"} · parent {r.parent_strategy_id ?? "-"}</span>
            </div>
          ))}
        </section>

        {/* VOLLEDIGE REGISTRY */}
        <section className="rounded-lg border bg-white p-4">
          <h2 className="font-semibold mb-2">Strategie-historie & research-resultaten ({rows.length})</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-neutral-500 border-b">
                  <th className="py-1 pr-3">versie</th><th className="pr-3">status</th><th className="pr-3">score</th>
                  <th className="pr-3">OOS exp</th><th className="pr-3">OOS netto</th><th className="pr-3">OOS trades</th>
                  <th className="pr-3">OOS DD</th><th className="pr-3">family</th><th>activeer/rollback</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const oos = oosOf(r);
                  return (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-1 pr-3 font-mono text-xs">{r.strategy_id}@{r.version}</td>
                      <td className="pr-3"><span className={`rounded px-1.5 py-0.5 text-xs ${statusColor[r.status] ?? ""}`}>{r.status}</span></td>
                      <td className="pr-3">{r.score ?? "-"}</td>
                      <td className="pr-3">€{oos?.expectancyEur ?? "-"}</td>
                      <td className="pr-3">€{oos?.netPnl ?? "-"}</td>
                      <td className="pr-3">{oos?.trades ?? "-"}</td>
                      <td className="pr-3">{oos?.maxDrawdownPct ?? "-"}%</td>
                      <td className="pr-3 text-xs">{r.family}</td>
                      <td className="text-xs">{r.rollback_reason ? `rollback: ${r.rollback_reason.slice(0, 60)}` : r.activated_at?.slice(0, 10) ?? "-"}</td>
                    </tr>
                  );
                })}
                {rows.length === 0 && <tr><td colSpan={9} className="py-2 text-neutral-500">lege registry</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        {/* FASE 4: PAPER VALIDATION (alleen data, geen redesign) */}
        <section className="rounded-lg border bg-white p-4">
          <h2 className="font-semibold mb-2">Paper validation (Fase 4)</h2>
          {(() => {
            const runs = data?.validation?.runs ?? [];
            if (!runs.length) return <p className="text-sm text-neutral-500">Nog geen validatie-runs uitgevoerd (de tick draait max 1x per 12u, of via POST /api/validation/run met token).</p>;
            return (
              <div className="space-y-1 text-sm">
                {runs.slice(0, 12).map((v) => {
                  const rep = typeof v.report === "string" ? (() => { try { return JSON.parse(v.report); } catch { return null; } })() : v.report ?? null;
                  const m = rep?.metrics;
                  return (
                    <div key={v.id} className="border-b last:border-0 py-1">
                      <span className="text-neutral-400">{v.created_at.slice(0, 16).replace("T", " ")}</span>{" "}
                      <span className="font-medium">{v.strategy_key}</span>{" "}
                      <span className={`rounded px-1.5 py-0.5 text-xs ${
                        v.verdict === "PAPER_APPROVED" ? "bg-emerald-100 text-emerald-800"
                        : v.verdict === "FAILED" || v.verdict === "ERROR" ? "bg-red-100 text-red-800"
                        : v.verdict === "VALIDATION_READY" ? "bg-blue-100 text-blue-800"
                        : "bg-neutral-100 text-neutral-700"}`}>{v.verdict}</span>{" "}
                      {m && <span className="text-neutral-600">
                        {m.closed ?? 0} trades · netto €{m.netPnl ?? 0} · fees €{m.fees ?? 0} · exp €{m.expectancyEur ?? 0}/trade · DD {m.maxDrawdownPct ?? 0}%
                        {rep?.drift?.worst ? ` · drift ${rep.drift.worst}` : ""}
                      </span>}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </section>

        {/* ROLLBACKS */}
        <section className="rounded-lg border bg-white p-4">
          <h2 className="font-semibold mb-2">Rollbacks ({rollbacks.length})</h2>
          {rollbacks.length === 0 && <p className="text-sm text-neutral-500">Nog geen rollbacks.</p>}
          {rollbacks.map((a) => (
            <div key={a.id} className="border-t py-2 text-sm">
              <span className="text-neutral-500">{a.created_at.slice(0, 16).replace("T", " ")}</span> — {a.reason}
            </div>
          ))}
        </section>

        {/* AUDIT TRAIL */}
        <section className="rounded-lg border bg-white p-4">
          <h2 className="font-semibold mb-2">Audit trail (laatste {(data?.activations ?? []).length})</h2>
          <div className="space-y-1 text-xs text-neutral-600 max-h-72 overflow-y-auto">
            {(data?.activations ?? []).map((a) => (
              <div key={a.id} className="border-b last:border-0 py-1">
                <span className="text-neutral-400">{a.created_at.slice(0, 19).replace("T", " ")}</span>{" "}
                <span className="font-medium">#{a.registry_id}</span> <span className="rounded bg-neutral-100 px-1">{a.action}</span>{" "}
                {a.from_status && <span>{a.from_status} → {a.to_status}</span>} — {a.reason} <span className="text-neutral-400">({a.performed_by})</span>
              </div>
            ))}
            {(data?.activations ?? []).length === 0 && <p className="text-neutral-500">geen lifecycle-stappen vastgelegd</p>}
          </div>
        </section>
      </main>
    </div>
  );
}
