// ── /research — sobere research-interface (Fase 2) ───────────────────────
// Leest het publieke /api/research/status: runs, jobs, candidates met
// metrics, OOS, walk-forward, robustness en rejection-redenen.
// Bewust functioneel gehouden — geen design-wedstrijd (Deel 30).

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Candidate {
  id: number;
  created_at: string;
  name: string;
  status: string;
  origin: string;
  score: number;
  sample_size: number;
  timeframe: string;
  pairs: string[];
  rejection_reasons: string[] | string;
  research_explanation: string;
  oos_metrics: {
    trades: number; winratePct: number; netPnl: number;
    expectancyEur: number; profitFactor: number | null;
    maxDrawdownPct: number; fees: number; grossPnl: number;
  } | string;
}

interface Run {
  created_at: string;
  run_id: string;
  type: string;
  model: string | null;
  ai_calls: number;
  cost_usd_est: number;
  strategies_tested: number;
  candidates_found: number;
  rejected: number;
  insufficient_data: number;
  errors: string[] | string;
}

export default function ResearchPage() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/research/status")
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => setData({ error: "status-endpoint onbereikbaar" }))
      .finally(() => setLoading(false));
  }, []);

  const candidates = ((data?.candidates ?? []) as Candidate[]).filter((c) => c.origin !== "baseline");
  const baselines = ((data?.candidates ?? []) as Candidate[]).filter((c) => c.origin === "baseline");
  const runs = (data?.runs ?? []) as Run[];
  const jobs = (data?.jobs ?? []) as { id: number; type: string; status: string; summary: string | null; created_at: string }[];

  const num = (x: unknown, suffix = "") => (typeof x === "number" ? `${x}${suffix}` : "—");
  const oos = (c: Candidate) => (typeof c.oos_metrics === "string" ? JSON.parse(c.oos_metrics) : c.oos_metrics);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-200 p-6">
      <div className="max-w-6xl mx-auto space-y-8">
        <header className="flex items-baseline justify-between">
          <h1 className="text-2xl font-bold">🔬 Research Engine (Fase 2)</h1>
          <Link href="/ai" className="text-sm text-slate-400 hover:text-slate-200">← dashboard</Link>
        </header>
        <p className="text-sm text-slate-400 max-w-3xl">
          Onderzoekslayer, strikt gescheiden van de trading-engine: hypotheses worden als data gevalideerd,
          teruggetest (in-sample + out-of-sample + walk-forward + robustness) en opgeslagen als RESEARCH CANDIDATE of
          REJECTED — <span className="text-amber-400">nooit automatisch actief</span> (activering is Fase 3).
        </p>

        {loading && <p className="text-slate-500">Laden…</p>}

        {data && (data as { configured?: boolean }).configured === false && (
          <div className="border border-amber-700/50 bg-amber-900/20 rounded p-4 text-sm text-amber-300">
            {(data as { note?: string }).note}
          </div>
        )}

        {/* Jobs */}
        <section>
          <h2 className="text-lg font-semibold mb-2">Research-jobs</h2>
          {jobs.length === 0 ? <p className="text-sm text-slate-500">Nog geen jobs (draai een run: POST /api/research/run?mode=baseline|full).</p> : (
            <table className="w-full text-xs border border-slate-800">
              <thead className="text-slate-400 border-b border-slate-800">
                <tr><th className="p-2 text-left">gestart</th><th className="p-2 text-left">type</th><th className="p-2 text-left">status</th><th className="p-2 text-left">samenvatting</th></tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-b border-slate-900">
                    <td className="p-2">{new Date(j.created_at).toLocaleString("nl-NL")}</td>
                    <td className="p-2">{j.type}</td>
                    <td className={`p-2 ${j.status === "completed" ? "text-emerald-400" : j.status === "failed" ? "text-rose-400" : "text-amber-400"}`}>{j.status}</td>
                    <td className="p-2 text-slate-400">{j.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* AI candidates */}
        <section>
          <h2 className="text-lg font-semibold mb-2">AI-hypotheses (candidates &amp; rejections)</h2>
          {candidates.length === 0 ? <p className="text-sm text-slate-500">Nog geen AI-hypotheses getest.</p> : (
            <div className="space-y-3">
              {candidates.map((c) => {
                const m = oos(c);
                const rej = typeof c.rejection_reasons === "string" ? JSON.parse(c.rejection_reasons) : c.rejection_reasons;
                return (
                  <div key={c.id} className="border border-slate-800 rounded p-4">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold">{c.name} <span className="text-xs text-slate-500">({c.timeframe})</span></div>
                      <div className="flex items-center gap-3">
                        <span className={`text-xs px-2 py-0.5 rounded ${c.status === "RESEARCH_CANDIDATE" ? "bg-emerald-900/40 text-emerald-300" : c.status === "REJECTED" ? "bg-rose-900/40 text-rose-300" : "bg-slate-800 text-slate-400"}`}>{c.status}</span>
                        <span className="text-xs text-slate-400">score {num(c.score)}</span>
                      </div>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">{c.research_explanation}</p>
                    {m && (
                      <div className="text-xs text-slate-300 mt-2 flex flex-wrap gap-x-5 gap-y-1">
                        <span>OOS: {m.trades} trades</span>
                        <span>wr {num(m.winratePct, "%")}</span>
                        <span className={m.netPnl >= 0 ? "text-emerald-400" : "text-rose-400"}>net €{num(m.netPnl)}</span>
                        <span>exp €{num(m.expectancyEur)}/trade</span>
                        <span>PF {num(m.profitFactor)}</span>
                        <span>maxDD {num(m.maxDrawdownPct, "%")}</span>
                        <span>fees €{num(m.fees)} (gross €{num(m.grossPnl)})</span>
                      </div>
                    )}
                    {rej && rej.length > 0 && <p className="text-xs text-rose-400 mt-1">⚠ {rej.join(" · ")}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Baselines */}
        <section>
          <h2 className="text-lg font-semibold mb-2">Baselines (productie-strategieën, zelfde engine)</h2>
          {baselines.length === 0 ? <p className="text-sm text-slate-500">Nog geen baseline-run uitgevoerd.</p> : (
            <div className="space-y-2">
              {baselines.map((c) => {
                const m = oos(c);
                const rej = typeof c.rejection_reasons === "string" ? JSON.parse(c.rejection_reasons) : c.rejection_reasons;
                return (
                  <div key={c.id} className="border border-slate-800 rounded p-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-200">{c.name}</span>
                      <span className={c.status === "RESEARCH_CANDIDATE" ? "text-emerald-400" : "text-rose-400"}>{c.status} · score {num(c.score)}</span>
                    </div>
                    {m && <p className="text-slate-400 mt-1">OOS: {m.trades} trades · wr {num(m.winratePct, "%")} · net €{num(m.netPnl)} · exp €{num(m.expectancyEur)} · PF {num(m.profitFactor)} · DD {num(m.maxDrawdownPct, "%")}</p>}
                    {rej && rej.length > 0 && <p className="text-rose-400/80 mt-1">{rej.join(" · ")}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Runs */}
        <section>
          <h2 className="text-lg font-semibold mb-2">Runs</h2>
          {runs.length === 0 ? <p className="text-sm text-slate-500">Nog geen runs gelogd.</p> : (
            <div className="space-y-1 text-xs">
              {runs.map((r) => (
                <div key={r.run_id} className="border-b border-slate-900 py-1 text-slate-400">
                  {new Date(r.created_at).toLocaleString("nl-NL")} · {r.type} · {r.strategies_tested} strategieën · {r.candidates_found} candidate · {r.rejected} rejected · {r.insufficient_data} insufficient · AI: {r.ai_calls} calls ${r.cost_usd_est.toFixed(3)}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
