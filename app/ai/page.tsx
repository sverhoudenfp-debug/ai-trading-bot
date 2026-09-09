"use client";

// ── AI-ZOECHTTOCHT — wat de AI-agent elke minuut ziet en doet ────────────
// Per scan (Claude Haiku): de nieuwsbeoordeling + alle voorstellen met
// onderbouwing, strategie en uitkomst. Plus strategie-prestaties (7 dagen)
// en de kosten van de zoektocht zelf.

import { useEffect, useState } from "react";

const fmtEUR = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" });
const dt = (t: string) => new Date(t).toLocaleString("nl-NL", { dateStyle: "short", timeStyle: "short" });
const tm = (t: string) => new Date(t).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });

interface Signal {
  id: number; created_at: string; pair: string; side: string; kind: string;
  reason: string; strategy_version: string; outcome: string; outcome_reason: string | null;
  ai_explanation?: string | null; proposed_by?: string | null; timeframe?: string | null;
  sl_pct?: number | null; tp_pct?: number | null; risk_pct?: number | null; confidence?: string | null;
}
interface AiRun { created_at: string; proposals: number; cost_usd_est: number; error: string | null }
interface StratStat { strategy: string; trades: number; wins: number; winrate: number; pnl_eur: number }

export default function AiPage() {
  const [data, setData] = useState<{
    signals: Signal[];
    news: { created_at: string; level: string; reason: string; valid_until: string } | null;
    aiStats: { calls: number; errors: number; proposals: number; costUsd: number } | null;
    aiLast: { created_at: string; error: string | null } | null;
    aiRuns: AiRun[];
    strategyStats: StratStat[];
    executeMode: boolean;
  } | null>(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/paper/status")
        .then((r) => r.json())
        .then((j) => j.configured && j.agents ? setData(j.agents) : setData(null))
        .catch(() => {});
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, []);

  if (!data) {
    return (
      <main className="hud">
        <section><h2><span className="hash">◎</span> AI-ZOECHTTOCHT</h2>
        <div className="card"><p className="delta">AI-gegevens laden… (de agent-tabellen zijn pas actief nadat de SQL-setup is gedraaid)</p></div></section>
      </main>
    );
  }

  const aiSignals = data.signals.filter((s) => s.proposed_by === "ai");
  const runsWithProposals = new Set(
    data.aiRuns.filter((r) => r.proposals > 0).map((r) => tm(r.created_at))
  );
  const signalsByMinute = new Map<string, Signal[]>();
  for (const s of aiSignals) {
    const key = tm(s.created_at);
    signalsByMinute.set(key, [...(signalsByMinute.get(key) ?? []), s]);
  }

  const outcomeBadge = (s: Signal) => {
    const map: Record<string, [string, string]> = {
      executed: ["✅ UITGEVOERD", "long"],
      blocked_news: ["⛔ NIEUWS-BLOK", "halt"],
      blocked_risk: ["⛔ RISICOCHECK", "halt"],
      blocked_long_only: ["⛔ LONG-ONLY", "halt"],
      skipped: ["⏭ OVERGESLAGEN", "wait"],
      expired: ["⌛ VERLOREN", "wait"],
      logged_test: ["👁 TESTVOORSTEL", "wait"],
      preview: ["👁 TEST (DRY)", "wait"],
      pending: ["⏳ WACHT OP ORDER-AGENT", "wait"],
    };
    const [label, cls] = map[s.outcome] ?? [s.outcome, "wait"];
    return (
      <span className={"pill sm " + cls}>{label}</span>
    );
  };

  return (
    <main className="hud">
      <section>
        <h2>
          <span className="hash">◎</span> AI-ZOECHTTOCHT
          <span className="hint">
            {data.executeMode ? "LIVE — voorstellen worden gekeurd en uitgevoerd" : "TESTMODUS — voorstellen worden alleen gelogd"}
          </span>
        </h2>

        <div className="grid4">
          <div className="card"><h3>Modus</h3>
            <div className="big">{data.executeMode ? "🤖 LIVE" : "👁 TEST"}</div>
            <div className="delta">{data.executeMode ? "AI stuurt de bot — risicocheck eromheen" : "AI logt alleen; regel-bot handelt"}</div>
          </div>
          <div className="card"><h3>Scans (24 uur)</h3>
            <div className="big">{data.aiStats?.calls ?? 0}</div>
            <div className="delta">{data.aiStats?.errors ? `${data.aiStats.errors} fouten` : "alles goed gelopen"}</div>
          </div>
          <div className="card"><h3>Kosten (24 uur)</h3>
            <div className="big">${(data.aiStats?.costUsd ?? 0).toFixed(3)}</div>
            <div className="delta">Claude Haiku · prompt caching aan</div>
          </div>
          <div className="card"><h3>Voorstellen (24 uur)</h3>
            <div className="big">{data.aiStats?.proposals ?? 0}</div>
            <div className="delta">de rest van de scans: geen kans gevonden</div>
          </div>
        </div>

        <div className="cols" style={{ marginTop: 14 }}>
          <div className="card feedcard">
            <h3>◆ Nieuws-beoordeling <span className="hint">meegenomen in elke scan</span></h3>
            {data.news ? (
              (() => {
                const lvl = data.news.level === "high" ? "halt" : data.news.level === "caution" ? "wait" : "long";
                const label = data.news.level === "high" ? "HOOG RISICO" : data.news.level === "caution" ? "WAAKZAAM" : "RUSTIG";
                return (
                  <>
                    <span className={"pill " + lvl}>{label}</span>
                    <p className="delta" style={{ marginTop: 8 }}>{data.news.reason}</p>
                    <p className="delta dim" style={{ marginTop: 4 }}>laatste update: {dt(data.news.created_at)}</p>
                  </>
                );
              })()
            ) : (
              <p className="delta">Nog geen nieuws-status.</p>
            )}
            {data.aiLast && (
              <p className="delta dim" style={{ marginTop: 10 }}>
                Laatste AI-scan: {tm(data.aiLast.created_at)}{data.aiLast.error ? ` — fout: ${data.aiLast.error.slice(0, 80)}` : ""}
              </p>
            )}
          </div>
          <div className="card feedcard">
            <h3>◆ Strategie-prestaties <span className="hint">afgelopen 7 dagen — de AI weegt deze mee</span></h3>
            {data.strategyStats.length ? (
              <div className="ordertable-wrap"><table>
                <thead><tr><th>Strategie</th><th>Trades</th><th>Winrate</th><th>Resultaat</th></tr></thead>
                <tbody>
                  {data.strategyStats.map((s) => (
                    <tr key={s.strategy}>
                      <td><b>{s.strategy}</b></td>
                      <td>{s.trades}</td>
                      <td>{s.winrate}%</td>
                      <td className={s.pnl_eur >= 0 ? "up" : "down"}>{s.pnl_eur >= 0 ? "+" : "−"}{fmtEUR.format(Math.abs(s.pnl_eur))}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            ) : (
              <p className="delta">Nog geen gesloten AI-trades — zodra trades sluiten met een strategie-stempel verschijnen ze hier.</p>
            )}
          </div>
        </div>
      </section>

      <section>
        <h2><span className="hash">◷</span> DE ZOECHTTOCHT <span className="hint">elke regel = één AI-scan · per voorstel de volledige onderbouwing</span></h2>
        <div className="card feedcard">
          <div className="scanfeed">
            {(data.aiRuns ?? []).map((r, i) => {
              const minute = tm(r.created_at);
              const sigs = signalsByMinute.get(minute) ?? [];
              return (
                <div key={i} className={"scanrun " + (r.proposals > 0 ? "hit" : "")}>
                  <div className="scanline">
                    <span className="fi-time">{minute}</span>
                    {r.error ? (
                      <span className="fi-text err">⚠ scan mislukt — {r.error.slice(0, 90)}</span>
                    ) : sigs.length ? (
                      <span className="fi-text">◎ markt gescand — <b>{sigs.length} voorstel{plural(sigs)}</b> (klik hieronder)</span>
                    ) : (
                      <span className="fi-text dim">◎ markt gescand — 8 coins × 3 timeframes · <b>geen kans</b> (discipline &gt; actie)</span>
                    )}
                    <span className="scan-cost">${r.cost_usd_est.toFixed(4)}</span>
                  </div>
                  {sigs.map((s) => (
                    <div key={s.id} className="proposal">
                      <div className="prop-head">
                        <b className={s.side === "buy" ? "up" : "down"}>{s.pair.replace("-EUR", "")} {s.side === "buy" ? "LONG" : "SHORT"}</b>
                        <span className="pill sm wait">{s.strategy_version}</span>
                        {s.timeframe && <span className="pill sm wait">⏱ {s.timeframe}</span>}
                        {s.confidence && <span className="pill sm wait">{s.confidence}</span>}
                        {s.kind === "exit" && <span className="pill sm wait">EXIT-VOORSTEL</span>}
                        {outcomeBadge(s)}
                      </div>
                      <div className="prop-metrics">
                        {s.sl_pct != null && <>SL {s.sl_pct}% · TP {s.tp_pct}% · risico {s.risk_pct}%</>}
                      </div>
                      <div className="prop-explain">{s.ai_explanation ?? "—"}</div>
                      {s.outcome_reason && <div className="prop-reason">order-agent: {s.outcome_reason}</div>}
                    </div>
                  ))}
                </div>
              );
            })}
            {!data.aiRuns?.length && <p className="delta">Nog geen AI-scans gelogd.</p>}
          </div>
        </div>
      </section>

      <footer>
        De AI-agent combineert nieuws (RSS) + koersanalyse (5m/15m/1u) in één scan per minuut en stelt maximaal 2 trades voor.
        Elk voorstel gaat door het vaste veiligheids-laagje (risico 5-10%, SL 1-10%, TP 0,5-15%, daglimiet −15%) vóór uitvoering.
      </footer>
    </main>
  );
}

const plural = (arr: unknown[]) => (arr.length > 1 ? "len" : ""); // 1 voorstel · 2 voorstellen
