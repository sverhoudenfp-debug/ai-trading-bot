"use client";

// ── TRADES — volledige paper trade-historie met filters en detail ─────
// Data: GET /api/paper/trades (read-only). Geen trading-acties.

import { Fragment, useMemo, useState } from "react";
import { Panel, Badge, pnlClass, eur, pct, dur, dt, price, Loading, ErrorState, EmptyState, useJson } from "../ui";

interface TradeRow {
  id: number; created_at: string | null; pair: string; side: string; price: number;
  size: number; reason: string; equity_after: number; pnl_eur: number | null; pnl_pct: number | null;
  strategy?: string | null; ai_explanation?: string | null;
  context?: {
    fees_eur?: number; slippage_eur?: number; hold_min?: number; exit_reason?: string;
    sl_pct?: number; tp_pct?: number; risk_pct?: number; net_pnl_eur?: number; gross_pnl_eur?: number;
  } | null;
}
type SortKey = "time" | "pair" | "pnl" | "pnlpct" | "hold";

export default function TradesPage() {
  const q = useJson<{ trades: TradeRow[]; total: number; configured: boolean }>(
    "/api/paper/trades?limit=500", 60_000);

  const [fPair, setFPair] = useState("");
  const [fSide, setFSide] = useState("");
  const [fRes, setFRes] = useState("");        // win/loss/all
  const [fStrategy, setFStrategy] = useState("");
  const [fSearch, setFSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("time");
  const [asc, setAsc] = useState(false);
  const [pageIx, setPageIx] = useState(0);
  const [detail, setDetail] = useState<number | null>(null);
  const perPage = 25;

  const rows = useMemo(() => {
    let r = q.data?.trades ?? [];
    if (fPair) r = r.filter((t) => t.pair === fPair);
    if (fSide) r = r.filter((t) => (fSide === "buy" ? t.side === "buy" && t.pnl_eur === null : t.side === "sell"));
    if (fRes === "win") r = r.filter((t) => (t.pnl_eur ?? 0) > 0);
    if (fRes === "loss") r = r.filter((t) => (t.pnl_eur ?? 0) < 0);
    if (fStrategy) r = r.filter((t) => (t.strategy ?? "") === fStrategy);
    if (fSearch) {
      const s = fSearch.toLowerCase();
      r = r.filter((t) =>
        t.pair.toLowerCase().includes(s) ||
        (t.strategy ?? "").toLowerCase().includes(s) ||
        (t.ai_explanation ?? "").toLowerCase().includes(s) ||
        t.reason.toLowerCase().includes(s));
    }
    const dir = asc ? 1 : -1;
    return [...r].sort((a, b) => {
      switch (sort) {
        case "pair": return a.pair.localeCompare(b.pair) * dir;
        case "pnl": return ((a.pnl_eur ?? -1e9) - (b.pnl_eur ?? -1e9)) * dir;
        case "pnlpct": return ((a.pnl_pct ?? -1e9) - (b.pnl_pct ?? -1e9)) * dir;
        case "hold": return ((a.context?.hold_min ?? -1e9) - (b.context?.hold_min ?? -1e9)) * dir;
        default: return (a.created_at ?? "").localeCompare(b.created_at ?? "") * dir;
      }
    });
  }, [q.data, fPair, fSide, fRes, fStrategy, fSearch, sort, asc]);

  const allPairs = [...new Set((q.data?.trades ?? []).map((t) => t.pair))].sort();
  const allStrategies = [...new Set((q.data?.trades ?? []).map((t) => t.strategy).filter(Boolean) as string[])].sort();

  if (q.loading) return <Loading h={300} />;
  if (q.error || !q.data?.configured) return <ErrorState retry={q.retry} />;

  const pageRows = rows.slice(pageIx * perPage, (pageIx + 1) * perPage);
  const totalPages = Math.max(1, Math.ceil(rows.length / perPage));

  const th = (label: string, key?: SortKey, cls = "") => key ? (
    <th className={"sortable num " + cls} onClick={() => { setSort(key); setAsc(sort === key ? !asc : false); }}>
      {label} {sort === key ? (asc ? "↑" : "↓") : ""}
    </th>
  ) : <th className={cls}>{label}</th>;

  return (
    <>
      <Panel title="Trade history" note={`${rows.length} van ${q.data.total} orders${rows.length !== q.data.total ? " (gefilterd)" : ""}`}>
        <div className="filterbar">
          <input className="grow" placeholder="Zoek coin, strategie, reden…" value={fSearch} onChange={(e) => { setFSearch(e.target.value); setPageIx(0); }} />
          <select value={fPair} onChange={(e) => { setFPair(e.target.value); setPageIx(0); }}>
            <option value="">Alle coins</option>
            {allPairs.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select value={fSide} onChange={(e) => { setFSide(e.target.value); setPageIx(0); }}>
            <option value="">Entries + exits</option>
            <option value="buy">Entries (long)</option>
            <option value="sell">Exits</option>
          </select>
          <select value={fRes} onChange={(e) => { setFRes(e.target.value); setPageIx(0); }}>
            <option value="">Winst + verlies</option>
            <option value="win">Alleen winst</option>
            <option value="loss">Alleen verlies</option>
          </select>
          <select value={fStrategy} onChange={(e) => { setFStrategy(e.target.value); setPageIx(0); }}>
            <option value="">Alle strategieën</option>
            {allStrategies.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {rows.length === 0 ? <EmptyState title="Geen trades gevonden" hint="Pas de filters aan — er is geen data die aan deze filters voldoet." /> : (
          <>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    {th("Tijd", "time")}
                    {th("Coin", "pair")}
                    <th>Type</th>
                    <th>Strategie</th>
                    {th("Koers", undefined, "num")}
                    {th("PnL €", "pnl", "num")}
                    {th("PnL %", "pnlpct", "num")}
                    {th("Hold", "hold", "num")}
                    <th>Exit</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((t) => {
                    const isExit = t.pnl_eur !== null;
                    return (
                      <Fragment key={t.id}>
                        <tr className="clickable" onClick={() => setDetail(detail === t.id ? null : t.id)}>
                          <td className="dim mono">{dt(t.created_at)}</td>
                          <td className="mono">{t.pair.replace("-EUR", "")}</td>
                          <td>{isExit ? <Badge tone="neutral" dot={false}>EXIT</Badge> : <Badge tone="green" dot={false}>LONG</Badge>}</td>
                          <td className="dim">{t.strategy ?? "—"}</td>
                          <td className="num">{price(t.price)}</td>
                          <td className={`num ${pnlClass(t.pnl_eur)}`}>{isExit ? eur(t.pnl_eur) : "—"}</td>
                          <td className={`num ${pnlClass(t.pnl_pct)}`}>{isExit ? pct(t.pnl_pct) : "—"}</td>
                          <td className="num dim">{t.context?.hold_min !== undefined ? dur(t.context.hold_min) : "—"}</td>
                          <td className="dim">{t.context?.exit_reason ?? (isExit ? t.reason : "—")}</td>
                        </tr>
                        {detail === t.id && (
                          <tr className="detail-row">
                            <td colSpan={9}>
                              <dl className="kv" style={{ gridTemplateColumns: "auto auto auto auto", gap: "4px 40px" }}>
                                <dt>Order ID</dt><dd>{t.id}</dd>
                                <dt>Type</dt><dd>{isExit ? "exit (sell)" : "entry (long)"}</dd>
                                <dt>Tijdstip</dt><dd>{dt(t.created_at)}</dd>
                                <dt>Pair</dt><dd>{t.pair}</dd>
                                <dt>Koers</dt><dd>€{price(t.price)}</dd>
                                <dt>Size</dt><dd>{t.size}</dd>
                                <dt>Notional</dt><dd>{eur(t.price * t.size)}</dd>
                                <dt>Equity na</dt><dd>{eur(t.equity_after)}</dd>
                                <dt>Strategie</dt><dd>{t.strategy ?? "—"}</dd>
                                <dt>Reden</dt><dd>{t.reason}</dd>
                                {isExit && <>
                                  <dt>Netto PnL</dt><dd className={pnlClass(t.pnl_eur)}>{eur(t.pnl_eur)}</dd>
                                  <dt>Gross PnL</dt><dd>{t.context?.gross_pnl_eur !== undefined ? eur(t.context.gross_pnl_eur) : "—"}</dd>
                                  <dt>Fees</dt><dd>{t.context?.fees_eur !== undefined ? eur(t.context.fees_eur) : "niet gelogd"}</dd>
                                  <dt>Slippage</dt><dd>{t.context?.slippage_eur !== undefined ? eur(t.context.slippage_eur) : "niet gelogd"}</dd>
                                  <dt>Hold-tijd</dt><dd>{t.context?.hold_min !== undefined ? dur(t.context.hold_min) : "—"}</dd>
                                  <dt>Exit-reden</dt><dd>{t.context?.exit_reason ?? "—"}</dd>
                                </>}
                                <dt>SL / TP</dt><dd>{t.context?.sl_pct ? `${t.context.sl_pct}%` : "—"} / {t.context?.tp_pct ? `${t.context.tp_pct}%` : "—"}</dd>
                                <dt>Risico</dt><dd>{t.context?.risk_pct ? `${t.context.risk_pct}%` : "—"}</dd>
                              </dl>
                              {t.ai_explanation && (
                                <p className="dim" style={{ fontSize: 12.5, maxWidth: 720, marginTop: 10 }}>
                                  <b>AI:</b> {t.ai_explanation}
                                </p>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <button disabled={pageIx === 0} onClick={() => setPageIx(pageIx - 1)}>← Vorige</button>
              <span>pagina {pageIx + 1} / {totalPages}</span>
              <button disabled={pageIx >= totalPages - 1} onClick={() => setPageIx(pageIx + 1)}>Volgende →</button>
            </div>
          </>
        )}
      </Panel>
      <p className="faint" style={{ fontSize: 12 }}>
        Fees/slippage worden pas sinds de Fase 1-hardening per trade opgeslagen — oudere trades tonen "niet gelogd". Alle bedragen zijn paper-geld uit de demo-pot.
      </p>
    </>
  );
}
