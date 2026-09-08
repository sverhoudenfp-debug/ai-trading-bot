"use client";

import { useEffect, useRef, useState } from "react";

interface Trade {
  entryTime: number; exitTime: number; entryPrice: number; exitPrice: number;
  size: number; pnl: number; pnlPct: number;
  reason: "take-profit" | "stop-loss" | "signaal" | "max-hold" | "daglimiet";
  holdHours: number;
}
interface Result {
  stats: {
    totalReturnPct: number; buyHoldPct: number; winRatePct: number; numTrades: number;
    maxDrawdownPct: number; dailyStops: number; avgHoldHours: number; feesPaid: number;
    bestTradePct: number; worstTradePct: number;
  };
  equity: number[]; prices: number[]; trades: Trade[];
  candlesUsed: number; periodStart: number; periodEnd: number;
}

const fmtEUR = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
const fmtEUR0 = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const dt = (t: number) => new Date(t * 1000).toLocaleString("nl-NL", { dateStyle: "short", timeStyle: "short" });

function sign(x: number, d = 2) { return (x >= 0 ? "+" : "") + x.toFixed(d) + "%"; }
function cls(x: number) { return x >= 0 ? "up" : "down"; }

const REASONS: Record<Trade["reason"], string> = {
  "take-profit": "Take-profit",
  "stop-loss": "Stop-loss",
  "signaal": "Exit-signaal",
  "max-hold": "Max. houdtijd",
  "daglimiet": "Daglimiet",
};

import PaperPanel from "./paper";

export default function Dashboard() {
  const [data, setData] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const load = () => {
    setLoading(true); setErr(null);
    fetch("/api/backtest")
      .then((r) => r.json())
      .then((j) => { if (j.error) throw new Error(j.error); setData(j); })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  useEffect(() => {
    if (!data || !canvasRef.current) return;
    const c = canvasRef.current, ctx = c.getContext("2d");
    if (!ctx) return;
    const W = c.width, H = c.height, padL = 60, padR = 10, padT = 10, padB = 22;
    const e = data.equity, pr = data.prices;
    const eqMin = Math.min(...e, 1000), eqMax = Math.max(...e, 1000);
    const all = [...e, ...pr.map((p) => (p / pr[0]) * 1000)];
    const lo = Math.min(...all), hi = Math.max(...all);
    const X = (i: number) => padL + (i / (e.length - 1)) * (W - padL - padR);
    const Y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

    ctx.clearRect(0, 0, W, H);
    // grid + as
    ctx.strokeStyle = "#26263a"; ctx.fillStyle = "#9a94a8"; ctx.font = "11px sans-serif";
    for (let g = 0; g <= 4; g++) {
      const v = lo + ((hi - lo) * g) / 4;
      const y = Y(v);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillText(fmtEUR0.format(v), 2, y + 4);
    }
    // startkapitaal-lijn
    ctx.strokeStyle = "#3a3a52"; ctx.setLineDash([4, 4]); ctx.beginPath();
    ctx.moveTo(padL, Y(1000)); ctx.lineTo(W - padR, Y(1000)); ctx.stroke(); ctx.setLineDash([]);
    // buy & hold
    ctx.strokeStyle = "#6d6880"; ctx.lineWidth = 1.5; ctx.beginPath();
    pr.forEach((p, i) => { const v = (p / pr[0]) * 1000; i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); });
    ctx.stroke();
    // bot
    ctx.strokeStyle = "#d9b45f"; ctx.lineWidth = 2; ctx.beginPath();
    e.forEach((v, i) => { i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); });
    ctx.stroke();
    // labels
    ctx.fillStyle = "#d9b45f"; ctx.fillText("● AI-bot", W - 130, padT + 10);
    ctx.fillStyle = "#6d6880"; ctx.fillText("● Buy & hold", W - 130, padT + 24);
    ctx.fillStyle = "#9a94a8";
    ctx.fillText(dt(data.periodStart), padL, H - 6);
    const endLbl = dt(data.periodEnd);
    ctx.fillText(endLbl, W - padR - ctx.measureText(endLbl).width, H - 6);
  }, [data]);

  const s = data?.stats;

  return (
    <main>
      <header className="top">
        <div>
          <div className="kicker">Fase 1 · Backtest-modus</div>
          <h1>AI Trading <span>Bot</span></h1>
          <p className="sub">BTC/EUR · 15-minuten candles · {data ? data.candlesUsed.toLocaleString("nl-NL") + " candles geanalyseerd" : "…"}</p>
        </div>
        <div className="status" title="De bot plaatst geen echte orders in deze fase">
          <span className="dot" /> Bot: paper (gesimuleerd)
        </div>
      </header>

      {err && <div className="error">Kon backtest niet draaien: {err} — <button onClick={load}>opnieuw</button></div>}

      <section className="grid">
        <div className="card"><h3>Rendement (bot)</h3><div className={"big " + cls(s?.totalReturnPct ?? 0)}>{loading && !data ? "…" : s ? sign(s.totalReturnPct) : "—"}</div><div className="delta">na kosten (fee + slippage)</div></div>
        <div className="card"><h3>Buy &amp; hold</h3><div className={"big " + cls(s?.buyHoldPct ?? 0)}>{s ? sign(s.buyHoldPct) : "—"}</div><div className="delta">gewoon kopen en vasthouden</div></div>
        <div className="card"><h3>Winrate</h3><div className="big">{s ? s.winRatePct.toFixed(0) + "%" : "—"}</div><div className="delta">{s ? `${s.numTrades} trades · gem. ${s.avgHoldHours.toFixed(1)}u vastgehouden` : ""}</div></div>
        <div className="card"><h3>Max. dip</h3><div className="big down">{s ? "−" + s.maxDrawdownPct.toFixed(1) + "%" : "—"}</div><div className="delta">diepste vermogensdaling in de periode</div></div>
      </section>

      <section>
        <h2>Kapitaalcurve — bot vs. vasthouden</h2>
        <div className="card">
          <canvas ref={canvasRef} width={920} height={280} />
        </div>
        {s && (
          <p className="note">
            Kosten betaald: {fmtEUR.format(s.feesPaid)} · Daglimiet-acties: {s.dailyStops}×
            {s.dailyStops > 0 && " (bot is automatisch gestopt op een verliesdag)"}
          </p>
        )}
      </section>

      <section>
        <h2>Fase 2 · Paper trading — live op actuele koersen</h2>
        <PaperPanel />
      </section>

      <section>
        <h2>Orderhistorie — laatste 25 trades</h2>
        {data && data.trades.length > 0 ? (
          <table>
            <thead>
              <tr><th>Geopend</th><th>Gesloten</th><th>Koop</th><th>Verkoop</th><th>Reden</th><th>Uren</th><th>Resultaat</th></tr>
            </thead>
            <tbody>
              {[...data.trades].reverse().slice(0, 25).map((t, i) => (
                <tr key={i}>
                  <td>{dt(t.entryTime)}</td>
                  <td>{dt(t.exitTime)}</td>
                  <td>{fmtEUR.format(t.entryPrice)}</td>
                  <td>{fmtEUR.format(t.exitPrice)}</td>
                  <td>{REASONS[t.reason]}</td>
                  <td>{t.holdHours.toFixed(1)}</td>
                  <td className={cls(t.pnl)}>
                    {t.pnl >= 0 ? "+" : "−"}{fmtEUR.format(Math.abs(t.pnl))} ({sign(t.pnlPct)})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="card"><p className="delta">Nog geen trades in deze periode — de strategie was streng (alleen koop bij een dip mét hogere trend).</p></div>
        )}
      </section>

      <section>
        <h2>Risicoregels — actief in elke simulatie</h2>
        <div className="grid">
          <div className="card"><h3>Stop-loss / take-profit</h3><div className="big">−1,5% / +2,5%</div><div className="delta">per trade, intrabar gecontroleerd</div></div>
          <div className="card"><h3>Risico per trade</h3><div className="big">1%</div><div className="delta">positiegrootte wordt hiernaar berekend</div></div>
          <div className="card"><h3>Daglimiet</h3><div className="big">−3%</div><div className="delta">bot stopt die dag automatisch</div></div>
          <div className="card"><h3>Max. houdtijd</h3><div className="big">16 u</div><div className="delta">day-trading: alles gaat dicht</div></div>
        </div>
      </section>

      <section>
        <h2>Roadmap</h2>
        <div className="phases">
          <div className="phase done"><b>1 · Backtest</b><span>afgerond ✓</span></div>
          <div className="phase now"><b>2 · Paper trading</b><span>actief — live meekijken, gesimuleerde orders</span></div>
          <div className="phase"><b>3 · Live trading</b><span>echte orders — alleen na goed fase 2</span></div>
        </div>
        <p className="note center">
          <button className="primary" onClick={load} disabled={loading}>
            {loading ? "Backtest draait…" : "Opnieuw backtesten"}
          </button>
        </p>
      </section>

      <footer>
        Fase 1-backtest op {data ? dt(data.periodEnd) : "—"} · Data: Bitvavo publieke API (gratis, geen account) · Leerproject — niets hier is financieel advies.
        Automatisch handelen met echt geld brengt verlies van je inleg met zich mee.
      </footer>
    </main>
  );
}
