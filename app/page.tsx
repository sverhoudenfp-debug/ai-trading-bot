"use client";

// ── MISSION CONTROL — AI Trading System dashboard ──────────────────────
// Eén overzichtspagina in HUD-stijl: live ticker, coin-status, grafieken
// met trade-markers, live activiteitenfeed en backtest-historie.
// De bot-logica (API's, strategie) is volledig onveranderd.

import { useCallback, useEffect, useRef, useState } from "react";

const fmtEUR = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
const fmtEUR0 = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const fmtPrice = (p: number) =>
  p >= 100 ? fmtEUR0.format(p) : new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: p >= 1 ? 2 : 4 }).format(p);
const dt = (t: number | string) =>
  new Date(typeof t === "number" ? t * 1000 : t).toLocaleString("nl-NL", { dateStyle: "short", timeStyle: "short" });
const sign = (x: number, d = 2) => (x >= 0 ? "+" : "") + x.toFixed(d) + "%";
const cls = (x: number) => (x >= 0 ? "up" : "down");

interface MiniTrade {
  side: "long" | "short"; entryTime: number; exitTime: number;
  entryPrice: number; exitPrice: number; pnl: number; pnlPct: number;
  reason: string; holdHours: number;
}
interface MultiPair {
  pair: string; name: string; price: number;
  stats: {
    totalReturnPct: number; buyHoldPct: number; winRatePct: number; numTrades: number;
    numShorts: number; maxDrawdownPct: number; avgHoldHours: number; feesPaid: number;
    dailyStops: number; bestTradePct: number; worstTradePct: number;
  };
  times: number[]; prices: number[]; equity: number[]; trades: MiniTrade[];
}
interface PaperOrder {
  id: number; created_at: string; pair: string; side: "buy" | "sell";
  price: number; size: number; reason: string; equity_after: number;
  pnl_eur: number | null; pnl_pct: number | null;
}
interface PaperState {
  pair: string; status: "flat" | "long" | "short"; cash: number;
  entry_price: number | null; entry_time: string | null;
  size: number | null; cost: number | null;
  day: string | null; day_start_equity: number; halted: boolean;
}
interface FeedItem { id: string; time: string; text: string; kind: "info" | "tick" | "order" }

/** x-positie van een timestamp in een (gedownsamplede) tijdreeks */
function idxForTime(times: number[], t: number): number {
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function drawLine(ctx: CanvasRenderingContext2D, values: number[], X: (i: number) => number, Y: (v: number) => number, color: string, width = 1.6) {
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.stroke();
}

function marker(ctx: CanvasRenderingContext2D, x: number, y: number, up: boolean, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  const s = 5;
  if (up) { ctx.moveTo(x, y - s); ctx.lineTo(x - s, y + s * 0.8); ctx.lineTo(x + s, y + s * 0.8); }
  else { ctx.moveTo(x, y + s); ctx.lineTo(x - s, y - s * 0.8); ctx.lineTo(x + s, y - s * 0.8); }
  ctx.closePath(); ctx.fill();
}

function MiniChart({ p, live, onPick, active }: { p: MultiPair; live?: PaperState; onPick: () => void; active: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current; const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const W = cv.width, H = cv.height, pad = 8;
    const pr = p.prices;
    const lo = Math.min(...pr), hi = Math.max(...pr);
    const X = (i: number) => pad + (i / (pr.length - 1)) * (W - 2 * pad);
    const Y = (v: number) => pad + (1 - (v - lo) / (hi - lo || 1)) * (H - 2 * pad);
    ctx.clearRect(0, 0, W, H);
    // gradient vulling
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "rgba(56,225,255,0.22)"); grad.addColorStop(1, "rgba(56,225,255,0)");
    ctx.beginPath();
    pr.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
    ctx.lineTo(X(pr.length - 1), H); ctx.lineTo(X(0), H); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    drawLine(ctx, pr, X, Y, "#38e1ff", 1.5);
    // trade-markers
    for (const t of p.trades) {
      marker(ctx, X(idxForTime(p.times, t.entryTime)), Y(t.entryPrice), t.side === "long", "#d9b45f");
      marker(ctx, X(idxForTime(p.times, t.exitTime)), Y(t.exitPrice), false, t.pnl >= 0 ? "#3ddc84" : "#ff5470");
    }
  }, [p]);
  const st = live?.status ?? "flat";
  return (
    <div className={"minichart" + (active ? " active" : "")} onClick={onPick}>
      <div className="mc-head">
        <b>{p.name}</b>
        <span className={"pill " + (live?.halted ? "halt" : st === "long" ? "long" : st === "short" ? "short" : "wait")}>
          {live?.halted ? "⏸ PAUZE" : st === "long" ? "🟢 LONG" : st === "short" ? "🔴 SHORT" : "⏳ SCAN"}
        </span>
      </div>
      <canvas ref={ref} width={272} height={92} />
      <div className="mc-foot">
        <span>{fmtPrice(p.price)}</span>
        <span className={cls(p.stats.totalReturnPct)}>bot 45d {sign(p.stats.totalReturnPct, 1)}</span>
      </div>
    </div>
  );
}

function BigChart({ p }: { p: MultiPair }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current; const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const W = cv.width, H = cv.height, padL = 62, padR = 12, padT = 14, padB = 26;
    const eq = p.equity, pr = p.prices;
    const bh = pr.map((v) => (v / pr[0]) * 1000);
    const all = [...eq, ...bh];
    const lo = Math.min(...all), hi = Math.max(...all);
    const X = (i: number) => padL + (i / (eq.length - 1)) * (W - padL - padR);
    const Y = (v: number) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
    const Yp = (v: number) => padT + (1 - (v - Math.min(...pr)) / (Math.max(...pr) - Math.min(...pr) || 1)) * (H - padT - padB);

    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(56,225,255,0.10)"; ctx.fillStyle = "#7d8aa0"; ctx.font = "10px ui-monospace, monospace";
    for (let g = 0; g <= 4; g++) {
      const v = lo + ((hi - lo) * g) / 4, y = Y(v);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillText(fmtEUR0.format(v), 4, y + 3);
    }
    ctx.strokeStyle = "rgba(56,225,255,0.20)"; ctx.setLineDash([4, 4]); ctx.beginPath();
    ctx.moveTo(padL, Y(1000)); ctx.lineTo(W - padR, Y(1000)); ctx.stroke(); ctx.setLineDash([]);
    drawLine(ctx, bh, X, Y, "rgba(125,138,160,0.55)", 1.3);
    drawLine(ctx, eq, X, Y, "#d9b45f", 2);
    // koers-lijn (rechter as, transparant)
    drawLine(ctx, pr, X, Yp, "rgba(56,225,255,0.35)", 1);
    // trade-markers op de koers
    for (const t of p.trades) {
      marker(ctx, X(idxForTime(p.times, t.entryTime)), Yp(t.entryPrice), t.side === "long", "#d9b45f");
      marker(ctx, X(idxForTime(p.times, t.exitTime)), Yp(t.exitPrice), false, t.pnl >= 0 ? "#3ddc84" : "#ff5470");
    }
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillStyle = "#d9b45f"; ctx.fillText("● bot-vermogen", W - 240, padT + 8);
    ctx.fillStyle = "rgba(125,138,160,0.8)"; ctx.fillText("● buy & hold", W - 150, padT + 8);
    ctx.fillStyle = "rgba(56,225,255,0.6)"; ctx.fillText("— koers (rechter as)", W - 60, padT + 8);
    ctx.fillStyle = "#7d8aa0";
    ctx.fillText(dt(p.times[0]), padL, H - 8);
    const end = dt(p.times[p.times.length - 1]);
    ctx.fillText(end, W - padR - ctx.measureText(end).width, H - 8);
  }, [p]);
  return <canvas ref={ref} width={1080} height={320} />;
}

export default function Dashboard() {
  const [multi, setMulti] = useState<{ pairs: MultiPair[]; periodStart: number; periodEnd: number } | null>(null);
  const [paper, setPaper] = useState<{ states: PaperState[]; orders: PaperOrder[] } | null>(null);
  const [pair, setPair] = useState("BTC-EUR");
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [clock, setClock] = useState("");
  const [busy, setBusy] = useState(true);
  const seen = useRef<Set<number>>(new Set());
  const tickNo = useRef(0);

  const addFeed = useCallback((text: string, kind: FeedItem["kind"]) => {
    setFeed((f) =>
      [{ id: `${Date.now()}-${Math.random()}`, time: new Date().toLocaleTimeString("nl-NL"), text, kind }, ...f].slice(0, 40)
    );
  }, []);

  const loadMulti = useCallback(() => {
    setBusy(true);
    fetch("/api/multi")
      .then((r) => r.json())
      .then((j) => {
        if (j.error) throw new Error(j.error);
        setMulti(j);
        addFeed(`Analyse voltooid — ${j.pairs.length} coins × 45 dagen backtest`, "info");
      })
      .catch((e) => addFeed(`Fout in analyse: ${e.message}`, "tick"))
      .finally(() => setBusy(false));
  }, [addFeed]);

  const loadPaper = useCallback(() => {
    fetch("/api/paper/status")
      .then((r) => r.json())
      .then((j) => {
        if (!j.configured || j.error) return;
        const orders: PaperOrder[] = j.orders ?? [];
        setPaper({ states: j.states ?? [], orders });
        tickNo.current++;
        const fresh = orders.filter((o) => !seen.current.has(o.id));
        if (seen.current.size === 0) {
          orders.forEach((o) => seen.current.add(o.id));
          addFeed("Verbonden met Supabase — orderhistorie gesynchroniseerd", "info");
        } else if (fresh.length) {
          fresh.forEach((o) => {
            seen.current.add(o.id);
            const nm = o.pair.split("-")[0];
            addFeed(
              o.pnl_eur == null
                ? `${nm} — ${o.side === "buy" ? "LONG GEOPEND" : "SHORT GEOPEND"} @ ${fmtEUR.format(o.price)} (${o.reason})`
                : `${nm} — POSITIE GESLOTEN (${o.reason}): ${o.pnl_eur >= 0 ? "+" : "−"}${fmtEUR.format(Math.abs(o.pnl_eur))}`,
              "order"
            );
          });
        } else {
          addFeed(`Marktscan #${tickNo.current} voltooid — 4 coins · geen nieuwe signalen`, "tick");
        }
      })
      .catch(() => {});
  }, [addFeed]);

  useEffect(() => {
    setClock(new Date().toLocaleTimeString("nl-NL"));
    addFeed("SYSTEEM ONLINE — AI Trading System initialiseren…", "info");
    loadMulti();
    loadPaper();
    const t = setInterval(loadPaper, 30_000);
    const c = setInterval(() => setClock(new Date().toLocaleTimeString("nl-NL")), 1000);
    return () => { clearInterval(t); clearInterval(c); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sel = multi?.pairs.find((p) => p.pair === pair) ?? null;
  const stateOf = (pair_: string) => paper?.states.find((s) => s.pair === pair_);

  return (
    <main className="hud">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◤</span>
          <div>
            <div className="brand-name">AI TRADING <span>SYSTEM</span></div>
            <div className="brand-sub">mission control · fase 2 · paper trading</div>
          </div>
        </div>
        <nav className="nav">
          <a href="#overzicht">OVERZICHT</a>
          <a href="#grafieken">GRAFIEKEN</a>
          <a href="#activiteit">ACTIVITEIT</a>
          <a href="#regels">REGELS</a>
        </nav>
        <div className="topright">
          <span className="heartbeat"><i /> LIVE</span>
          <span className="clock">{clock}</span>
        </div>
      </header>

      <div className="ticker">
        {(multi?.pairs ?? []).map((p) => {
          const st = stateOf(p.pair);
          return (
            <span key={p.pair} className="tick-item">
              <b>{p.pair.replace("-EUR", "")}</b>
              <span>{fmtPrice(p.price)}</span>
              <span className={cls(p.stats.buyHoldPct)}>{sign(p.stats.buyHoldPct, 1)}</span>
              <span className={"pill sm " + (st?.halted ? "halt" : st?.status === "long" ? "long" : st?.status === "short" ? "short" : "wait")}>
                {st?.halted ? "PAUZE" : st?.status === "long" ? "LONG" : st?.status === "short" ? "SHORT" : "SCAN"}
              </span>
            </span>
          );
        })}
        {!multi && <span className="tick-item muted">systemen opstarten…</span>}
      </div>

      <section id="overzicht">
        <h2><span className="hash">01</span> LIVE OVERZICHT <span className="hint">papieren vermogen per coin: €1000 start</span></h2>
        <div className="grid4">
          {(multi?.pairs ?? []).map((p) => {
            const st = stateOf(p.pair);
            const inPos = st && st.status !== "flat" && st.size && st.entry_price;
            const equity = st
              ? st.cash + (inPos
                ? st.status === "long"
                  ? st.size! * st.entry_price!
                  : st.size! * (2 * st.entry_price! - st.entry_price!)
                : 0)
              : 1000;
            const dayPnl = st?.day ? (equity / st.day_start_equity - 1) * 100 : 0;
            return (
              <div className="statcard" key={p.pair}>
                <div className="sc-top">
                  <b>{p.name}</b>
                  <span className={"pill " + (st?.halted ? "halt" : st?.status === "long" ? "long" : st?.status === "short" ? "short" : "wait")}>
                    {st?.halted ? "⏸ PAUZE" : st?.status === "long" ? "🟢 LONG" : st?.status === "short" ? "🔴 SHORT" : "⏳ SCAN"}
                  </span>
                </div>
                <div className="big">{fmtEUR.format(equity)}</div>
                <div className="delta">
                  vandaag <span className={cls(dayPnl)}>{sign(dayPnl)}</span> ·{" "}
                  {inPos ? `${st?.status} @ ${fmtEUR.format(st!.entry_price!)}` : `kas ${fmtEUR.format(st?.cash ?? 1000)}`}
                </div>
                <div className="delta dim">
                  backtest 45d: <span className={cls(p.stats.totalReturnPct)}>{sign(p.stats.totalReturnPct, 1)}</span> · {p.stats.numTrades} trades ({p.stats.numShorts} short) · win {p.stats.winRatePct.toFixed(0)}%
                </div>
              </div>
            );
          })}
          {!multi && <div className="statcard"><div className="big dim">systemen analyseren{busy ? "…" : ""}</div></div>}
        </div>
      </section>

      <section id="grafieken">
        <h2><span className="hash">02</span> GRAFIEKEN <span className="hint">klik een coin voor details · ▲ entry · ▼ exit (groen = winst)</span></h2>
        <div className="grid4">
          {(multi?.pairs ?? []).map((p) => (
            <MiniChart key={p.pair} p={p} live={stateOf(p.pair)} active={p.pair === pair} onPick={() => setPair(p.pair)} />
          ))}
        </div>
        {sel && (
          <div className="card wide">
            <div className="big-head">
              <h3>{sel.name} — vermogenscurve 45 dagen</h3>
              <select value={pair} onChange={(e) => setPair(e.target.value)} className="sel">
                {multi!.pairs.map((p) => <option key={p.pair} value={p.pair}>{p.name}</option>)}
              </select>
              <button className="btn" onClick={loadMulti} disabled={busy}>{busy ? "analyse draait…" : "↻ opnieuw analyseren"}</button>
            </div>
            <BigChart p={sel} />
            <div className="statrow">
              <span>bot: <b className={cls(sel.stats.totalReturnPct)}>{sign(sel.stats.totalReturnPct)}</b></span>
              <span>buy&amp;hold: <b className={cls(sel.stats.buyHoldPct)}>{sign(sel.stats.buyHoldPct)}</b></span>
              <span>trades: <b>{sel.stats.numTrades}</b> ({sel.stats.numShorts} short)</span>
              <span>winrate: <b>{sel.stats.winRatePct.toFixed(0)}%</b></span>
              <span>max. dip: <b className="down">−{sel.stats.maxDrawdownPct.toFixed(1)}%</b></span>
              <span>kosten: <b>{fmtEUR.format(sel.stats.feesPaid)}</b></span>
              <span>beste/slechtste: <b className="up">{sign(sel.stats.bestTradePct, 1)}</b> / <b className="down">{sign(sel.stats.worstTradePct, 1)}</b></span>
            </div>
          </div>
        )}
      </section>

      <section id="activiteit">
        <h2><span className="hash">03</span> LIVE ACTIVITEIT</h2>
        <div className="cols">
          <div className="card feedcard">
            <h3>◆ Systeemfeed</h3>
            <div className="feed">
              {feed.map((f) => (
                <div key={f.id} className={"feed-item " + f.kind}>
                  <span className="fi-time">{f.time}</span>
                  <span className="fi-text">{f.text}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <h3>◆ Paper-orderhistorie</h3>
            {paper && paper.orders.length > 0 ? (
              <table>
                <thead><tr><th>Tijd</th><th>Coin</th><th>Actie</th><th>Koers</th><th>Resultaat</th></tr></thead>
                <tbody>
                  {paper.orders.slice(0, 12).map((o) => (
                    <tr key={o.id}>
                      <td>{dt(o.created_at)}</td>
                      <td>{o.pair.replace("-EUR", "")}</td>
                      <td>{o.side === "buy" ? "🟢 koop" : "🔴 verkoop"}</td>
                      <td>{fmtEUR.format(o.price)}</td>
                      <td className={o.pnl_eur == null ? "" : cls(o.pnl_eur)}>
                        {o.pnl_eur == null ? "—" : `${o.pnl_eur >= 0 ? "+" : "−"}${fmtEUR.format(Math.abs(o.pnl_eur))}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="delta">Nog geen paper-orders — de bot scant elke minuut alle coins. Zodra er een signaal valt, verschijnt het hier én in de feed.</p>
            )}
            <h3 style={{ marginTop: 18 }}>◆ Backtest-historie {sel?.name}</h3>
            {sel && sel.trades.length > 0 ? (
              <table>
                <thead><tr><th>#</th><th>Richting</th><th>Geopend</th><th>Gesloten</th><th>Reden</th><th>Uren</th><th>Resultaat</th></tr></thead>
                <tbody>
                  {[...sel.trades].reverse().map((t, i) => (
                    <tr key={i}>
                      <td>{sel.trades.length - i}</td>
                      <td>{t.side === "long" ? "🟢 long" : "🔴 short"}</td>
                      <td>{dt(t.entryTime)}</td>
                      <td>{dt(t.exitTime)}</td>
                      <td>{t.reason}</td>
                      <td>{t.holdHours.toFixed(1)}</td>
                      <td className={cls(t.pnl)}>{t.pnl >= 0 ? "+" : "−"}{fmtEUR.format(Math.abs(t.pnl))} ({sign(t.pnlPct)})</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="delta">Geen trades in deze periode — de strategie was streng.</p>}
          </div>
        </div>
      </section>

      <section id="regels">
        <h2><span className="hash">04</span> RISICOREGELS &amp; FASES</h2>
        <div className="grid4">
          <div className="card"><h3>Stop-loss / take-profit</h3><div className="big">−1,5% / +2,5%</div><div className="delta">per trade, beide richtingen</div></div>
          <div className="card"><h3>Risico per trade</h3><div className="big">1%</div><div className="delta">positiegrootte hiernaar berekend</div></div>
          <div className="card"><h3>Daglimiet</h3><div className="big">−3%</div><div className="delta">bot pauzeert die dag</div></div>
          <div className="card"><h3>Max. houdtijd</h3><div className="big">16 u</div><div className="delta">alles gaat dicht</div></div>
        </div>
        <div className="phases">
          <div className="phase done"><b>1 · Backtest</b><span>afgerond ✓</span></div>
          <div className="phase now"><b>2 · Paper trading</b><span>actief — 4 coins · long &amp; short · 24/7</span></div>
          <div className="phase"><b>3 · Live trading</b><span>echte orders — alleen na goed fase 2</span></div>
        </div>
      </section>

      <footer>
        AI Trading System · data: Bitvavo publieke API · orders: gesimuleerd (paper) · leerproject — niets hier is financieel advies.
        Live-check elke minuut via cron-wekker. Echt geld beweegt er niet.
      </footer>
    </main>
  );
}
