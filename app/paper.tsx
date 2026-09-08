"use client";

// ── Fase 2-paneel: live paper trading (meerdere coins) ─────────────────
// Elke coin heeft zijn eigen virtuele potje van €1000. Verversen elke minuut.

import { useEffect, useState } from "react";

const fmtEUR = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
const dt = (t: string) => new Date(t).toLocaleString("nl-NL", { dateStyle: "short", timeStyle: "short" });
const sign = (x: number, d = 2) => (x >= 0 ? "+" : "") + x.toFixed(d) + "%";

const COIN_NAMES: Record<string, string> = {
  "BTC-EUR": "Bitcoin", "ETH-EUR": "Ethereum", "SOL-EUR": "Solana", "XRP-EUR": "XRP",
};

interface Order {
  id: number; created_at: string; pair: string; side: "buy" | "sell"; price: number;
  size: number; reason: string; equity_after: number;
  pnl_eur: number | null; pnl_pct: number | null;
}
interface State {
  pair: string; status: "flat" | "long" | "short"; cash: number;
  entry_price: number | null; entry_time: string | null;
  size: number | null; cost: number | null;
  day: string | null; day_start_equity: number; halted: boolean;
}
interface PaperStatus {
  configured?: boolean; initialized?: boolean; error?: string;
  states?: State[]; orders?: Order[];
}

export default function PaperPanel() {
  const [ps, setPs] = useState<PaperStatus | null>(null);

  const load = () => {
    fetch("/api/paper/status")
      .then((r) => r.json())
      .then(setPs)
      .catch(() => setPs({ configured: true, error: "onbereikbaar" }));
  };

  useEffect(load, []);
  useEffect(() => {
    const iv = setInterval(load, 60_000);
    return () => clearInterval(iv);
  }, []);

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
  if (!ps.initialized || !ps.states?.length) {
    return <div className="card"><p className="delta">Tabellen gevonden, maar nog geen bot-status — de cron-wekker vult dit zodra hij loopt.</p></div>;
  }

  const orders = ps.orders ?? [];

  return (
    <>
      <div className="grid">
        {ps.states.map((s) => {
          const inPos = s.status !== "flat" && s.size && s.entry_price;
          const equity = s.cash + (inPos
            ? s.status === "long"
              ? s.size! * s.entry_price!
              : s.size! * (2 * s.entry_price! - s.entry_price!)
            : 0);
          const dayPnl = s.day ? (equity / s.day_start_equity - 1) * 100 : 0;
          return (
            <div className="card" key={s.pair}>
              <h3>{COIN_NAMES[s.pair] ?? s.pair}</h3>
              <div className="big" style={{ fontSize: "1.4rem" }}>
                {s.halted ? "⏸ Pauze" : s.status === "long" ? "🟢 LONG" : s.status === "short" ? "🔴 SHORT" : "⏳ Wacht"}
              </div>
              <div className="delta">
                {fmtEUR.format(equity)} · vandaag <span className={dayPnl >= 0 ? "up" : "down"}>{sign(dayPnl)}</span>
              </div>
              <div className="delta">
                {inPos
                  ? `${s.size!.toFixed(6)} @ ${fmtEUR.format(s.entry_price!)}`
                  : `kas: ${fmtEUR.format(s.cash)}`}
              </div>
            </div>
          );
        })}
      </div>

      {orders.length > 0 ? (
        <table>
          <thead>
            <tr><th>Tijdstip</th><th>Coin</th><th>Actie</th><th>Koers</th><th>Reden</th><th>Vermogen</th><th>Resultaat</th></tr>
          </thead>
          <tbody>
            {orders.slice(0, 12).map((o) => (
              <tr key={o.id}>
                <td>{dt(o.created_at!)}</td>
                <td>{COIN_NAMES[o.pair] ?? o.pair}</td>
                <td>{o.side === "buy" ? "🟢 Koop" : "🔴 Verkoop"}</td>
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
            Nog geen orders. De bot kijkt alle 4 de coins elke 5 minuten na — zodra er ergens een
            signaal is (long of short), verschijnt het hier vanzelf.
          </p>
        </div>
      )}
    </>
  );
}
