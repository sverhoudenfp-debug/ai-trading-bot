"use client";

// ── Fase 2-paneel: live paper trading ───────────────────────────────────
// Toont wat de bot NU aan het doen is op live data (gesimuleerd geld).
// Wordt pas "live" zodra de cron-wekker (en Supabase) actief is.

import { useEffect, useState } from "react";

const fmtEUR = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
const dt = (t: string) => new Date(t).toLocaleString("nl-NL", { dateStyle: "short", timeStyle: "short" });
const sign = (x: number, d = 2) => (x >= 0 ? "+" : "") + x.toFixed(d) + "%";

interface Order {
  id: number; created_at: string; side: "buy" | "sell"; price: number;
  size: number; reason: string; equity_after: number;
  pnl_eur: number | null; pnl_pct: number | null;
}
interface PaperStatus {
  configured?: boolean; initialized?: boolean; error?: string;
  state?: {
    status: "flat" | "long"; cash: number;
    entry_price: number | null; entry_time: string | null;
    size: number | null; cost: number | null;
    day: string | null; day_start_equity: number; halted: boolean;
  };
  orders?: Order[];
}

export default function PaperPanel() {
  const [ps, setPs] = useState<PaperStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    setErr(null);
    fetch("/api/paper/status")
      .then((r) => r.json())
      .then(setPs)
      .catch((e) => setErr(e.message));
  };

  useEffect(load, []);
  useEffect(() => {
    const iv = setInterval(load, 60_000); // elke minuut verversen
    return () => clearInterval(iv);
  }, []);

  if (err) return <div className="card"><p className="delta">Paper-status niet beschikbaar: {err}</p></div>;

  if (!ps?.configured) {
    return (
      <div className="card">
        <p className="delta">
          Paper trading staat klaar in de code, maar Supabase is nog niet gekoppeld op Vercel.
          Zet SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY als environment variables in Vercel en herdeploy.
        </p>
      </div>
    );
  }
  if (ps.error) return <div className="card"><p className="delta">Supabase-fout: {ps.error} — draai je het SQL-script al?</p></div>;
  if (!ps.initialized) {
    return <div className="card"><p className="delta">Database gevonden, maar de tabellen bestaan nog niet — draai het SQL-script uit de README in de Supabase SQL-editor.</p></div>;
  }

  const s = ps.state!;
  const orders = ps.orders ?? [];
  const inPos = s.status === "long" && s.size && s.entry_price;
  const equity = s.cash + (inPos ? s.size! * s.entry_price! : 0);
  const dayPnl = s.day ? (equity / s.day_start_equity - 1) * 100 : 0;

  return (
    <>
      <div className="grid">
        <div className="card">
          <h3>Bot-status</h3>
          <div className="big">{s.halted ? "⏸ Pauze" : inPos ? "🟢 In positie" : "⏳ Wacht op signaal"}</div>
          <div className="delta">
            {s.halted
              ? "daglimiet geraakt — bot rust tot morgen (UTC)"
              : inPos
              ? `LONG sinds ${s.entry_time ? dt(s.entry_time) : "?"}`
              : "geen open positie — bot kijkt elke 5 min mee"}
          </div>
        </div>
        <div className="card">
          <h3>Virtueel vermogen</h3>
          <div className="big">{fmtEUR.format(equity)}</div>
          <div className={"delta " + (dayPnl >= 0 ? "up" : "down")}>vandaag {sign(dayPnl)} (daglimiet −3%)</div>
        </div>
        <div className="card">
          <h3>Open positie</h3>
          {inPos ? (
            <>
              <div className="big">{s.size!.toFixed(6)} BTC</div>
              <div className="delta">gekocht @ {fmtEUR.format(s.entry_price!)} · kosten {fmtEUR.format(s.cost!)}</div>
            </>
          ) : (
            <>
              <div className="big">—</div>
              <div className="delta">kas: {fmtEUR.format(s.cash)}</div>
            </>
          )}
        </div>
        <div className="card">
          <h3>Trades tot nu toe</h3>
          <div className="big">{orders.filter((o) => o.side === "sell").length}</div>
          <div className="delta">gesimuleerd — geen echt geld in beweging</div>
        </div>
      </div>

      {orders.length > 0 ? (
        <table>
          <thead>
            <tr><th>Tijdstip</th><th>Actie</th><th>Koers</th><th>Reden</th><th>Vermogen</th><th>Resultaat</th></tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>{dt(o.created_at!)}</td>
                <td>{o.side === "buy" ? "Koop" : "Verkoop"}</td>
                <td>{fmtEUR.format(o.price)}</td>
                <td>{o.reason}</td>
                <td>{fmtEUR.format(o.equity_after)}</td>
                <td className={o.pnl_eur == null ? "" : o.pnl_eur >= 0 ? "up" : "down"}>
                  {o.pnl_eur == null ? "—" : `${o.pnl_eur >= 0 ? "+" : "−"}${fmtEUR.format(Math.abs(o.pnl_eur))} (${sign(o.pnl_pct!)})`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="card">
          <p className="delta">
            Nog geen orders. Zodra de cron-wekker actief is en de strategie een signaal ziet,
            verschijnen hier de gesimuleerde trades vanzelf.
          </p>
        </div>
      )}
    </>
  );
}
