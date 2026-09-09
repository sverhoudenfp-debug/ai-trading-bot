"use client";

// ── ORDERS — complete trade-historie van de paper-bot ───────────────────
// Elke order met strategie-stempel en AI-onderbouwing, plus de pot-status
// en het dagresultaat.

import { useEffect, useState } from "react";

const fmtEUR = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" });
const dt = (t: string) => new Date(t).toLocaleString("nl-NL", { dateStyle: "short", timeStyle: "short" });
const cls = (x: number) => (x >= 0 ? "up" : "down");

interface Order {
  id: number; created_at: string; pair: string; side: "buy" | "sell";
  price: number; size: number; reason: string; equity_after: number;
  pnl_eur: number | null; pnl_pct: number | null;
  strategy?: string | null; ai_explanation?: string | null;
}
interface State {
  pair: string; status: string; cash: number; entry_price: number | null;
  day_start_equity: number; halted: boolean;
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [states, setStates] = useState<State[]>([]);
  const [pot, setPot] = useState<{ cash: number; day_start_equity: number; halted: boolean } | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const load = () =>
      fetch("/api/paper/status")
        .then((r) => r.json())
        .then((j) => {
          if (!j.configured) return;
          setOrders(j.orders ?? []);
          setStates(j.states ?? []);
          setPot(j.pot ?? null);
          setReady(true);
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, []);

  const closed = orders.filter((o) => o.pnl_eur !== null);
  const wins = closed.filter((o) => (o.pnl_eur ?? 0) > 0).length;
  const totalPnl = closed.reduce((a, o) => a + (o.pnl_eur ?? 0), 0);
  const open = states.filter((s) => s.status !== "flat" && s.pair !== "__POT__");

  return (
    <main className="hud">
      <section>
        <h2><span className="hash">≡</span> ORDERS <span className="hint">complete paper-historie · live elke 20 sec</span></h2>
        <div className="grid4">
          <div className="card"><h3>Pot</h3><div className="big">{pot ? fmtEUR.format(pot.cash) : "—"}</div><div className="delta">kas · open posities extra</div></div>
          <div className="card"><h3>Open posities</h3><div className="big">{open.length}</div>
            <div className="delta">{open.length ? open.map((s) => `${s.pair.replace("-EUR", "")} ${s.status}`).join(" · ") : "alles plat"}</div>
          </div>
          <div className="card"><h3>Gesloten trades</h3><div className="big">{closed.length}</div>
            <div className="delta">winrate {closed.length ? Math.round((wins / closed.length) * 100) : 0}%</div>
          </div>
          <div className="card"><h3>Totaal resultaat</h3><div className={"big " + cls(totalPnl)}>{totalPnl >= 0 ? "+" : "−"}{fmtEUR.format(Math.abs(totalPnl))}</div>
            <div className="delta">van gesloten trades (excl. open posities)</div>
          </div>
        </div>
      </section>

      <section>
        <h2><span className="hash">◷</span> TRADE-HISTORIE</h2>
        <div className="card">
          {orders.length ? (
            <div className="ordertable-wrap"><table>
              <thead><tr><th>Tijd</th><th>Coin</th><th>Actie</th><th>Koers</th><th>Strategie</th><th>Resultaat</th><th>Reden / AI-onderbouwing</th></tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>{dt(o.created_at)}</td>
                    <td><b>{o.pair.replace("-EUR", "")}</b></td>
                    <td>{o.side === "buy" ? "🟢 koop" : "🔴 verkoop"}</td>
                    <td>{fmtEUR.format(o.price)}</td>
                    <td>{o.strategy ? <span className="pill sm wait">{o.strategy}</span> : "—"}</td>
                    <td className={o.pnl_eur == null ? "" : cls(o.pnl_eur)}>
                      {o.pnl_eur == null ? "open" : `${o.pnl_eur >= 0 ? "+" : "−"}${fmtEUR.format(Math.abs(o.pnl_eur))}`}
                    </td>
                    <td className="delta" style={{ maxWidth: 320 }}>{o.ai_explanation ?? o.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : (
            <p className="delta">{ready ? "Nog geen orders — zodra de AI of de regel-bot handelt verschijnen ze hier." : "Laden…"}</p>
          )}
        </div>
      </section>

      <footer>
        Elke order is paper + spiegeling naar het Blofin demo-account. Leerproject — geen echt geld.
      </footer>
    </main>
  );
}
