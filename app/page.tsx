"use client";

// ── MISSION CONTROL — AI Trading System dashboard ──────────────────────
// Eén overzichtspagina in HUD-stijl: live ticker, coin-status, grafieken
// met trade-markers, live activiteitenfeed en backtest-historie.
// De bot-logica (API's, strategie) is volledig onveranderd.

import { useCallback, useEffect, useRef, useState } from "react";
import { PositionsChart } from "./positionschart";

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
  candles: { t: number; o: number; h: number; l: number; c: number }[]; trades: MiniTrade[];
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
  updated_at?: string | null; // laatste bot-tick (levensbewijs van de cron)
}
interface FeedItem { id: string; time: string; text: string; kind: "info" | "tick" | "order" | "ok" | "err" }

function MiniChart({ p, live, onPick, active }: { p: MultiPair; live?: PaperState; onPick: () => void; active: boolean }) {
  const st = live?.status ?? "flat";
  return (
    <div className={"minichart" + (active ? " active" : "")} onClick={onPick}>
      <div className="mc-head">
        <b>{p.name}</b>
        <span className={"pill " + (live?.halted ? "halt" : st === "long" ? "long" : st === "short" ? "short" : "wait")}>
          {live?.halted ? "⏸ PAUZE" : st === "long" ? "🟢 LONG" : st === "short" ? "🔴 SHORT" : "⏳ SCAN"}
        </span>
      </div>
      <div className="mc-price">{fmtPrice(p.price)}</div>
      <div className="mc-stats">
        <span className={cls(p.stats.totalReturnPct)}>bot 45d {sign(p.stats.totalReturnPct, 1)}</span>
        <span>{p.stats.numTrades} trades</span>
        <span>win {p.stats.winRatePct.toFixed(0)}%</span>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [multi, setMulti] = useState<{ pairs: MultiPair[]; periodStart: number; periodEnd: number } | null>(null);
  const [paper, setPaper] = useState<{
    states: PaperState[]; orders: PaperOrder[];
    pot?: { cash: number; day_start_equity: number; halted: boolean } | null;
  blofin?: { configured: boolean; live: boolean; equityUsd: number | null; positions: { instId: string; contracts: number; entry: number; mark: number; upl: number }[]; error?: string };
  } | null>(null);
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
        setPaper({ states: j.states ?? [], orders, blofin: j.blofin });
        if (j.blofin?.live) addFeed(`Paper-live actief op Blofin demo — virtueel vermogen $${Number(j.blofin.equityUsd).toFixed(0)}`, "ok");
        else if (j.blofin?.error) addFeed(`Blofin demo: verbinding mislukt — ${j.blofin.error}`, "err");
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
  // Eén gedeelde pot: cash uit de pot-rij + waarde van alle open posities
  const potTotal = (paper?.pot?.cash ?? 0) + (paper?.states ?? []).reduce((acc, s) => {
    const px = multi?.pairs.find((m) => m.pair === s.pair)?.price ?? 0;
    if (!s.size || !s.entry_price) return acc;
    const posVal = s.status === "long" ? s.size * px : s.size * (2 * s.entry_price - px);
    return acc + posVal;
  }, 0);
  const potDayPnl = paper?.pot?.day_start_equity
    ? (potTotal / paper.pot.day_start_equity - 1) * 100 : 0;
  // Levend bewijs dat de cron de bot wakker maakt: jongste updated_at
  // van de coin-states → "X min geleden". Meer dan 15 min oud = waarschuwing,
  // want dan zijn er minstens 3 ticks van de 5-minuten-wekker overgeslagen.
  const lastTickHint = (() => {
    const stamps = (paper?.states ?? []).map((s) => s.updated_at).filter(Boolean) as string[];
    if (!stamps.length) return null;
    const ms = Date.now() - Math.max(...stamps.map((t) => Date.parse(t)));
    if (!isFinite(ms) || ms < 0) return null;
    const min = Math.round(ms / 60000);
    if (min > 15) return `⚠ ${min} min geleden`;
    return `${min} min geleden`;
  })();

  return (
    <main className="hud">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◤</span>
          <div>
            <div className="brand-name">AI TRADING <span>SYSTEM</span></div>
            <div className="brand-sub">mission control · fase 2 · paper trading · één pot van {fmtEUR0.format(potTotal)}</div>
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
        <h2><span className="hash">01</span> LIVE OVERZICHT <span className="hint">één gedeelde pot van €1000 · vandaag {sign(potDayPnl, 1)}</span></h2>
        <div className="grid4">
          {(multi?.pairs ?? []).map((p) => {
            const st = stateOf(p.pair);
            const inPos = st && st.status !== "flat" && st.size && st.entry_price;
            return (
              <div className="statcard" key={p.pair}>
                <div className="sc-top">
                  <b>{p.name}</b>
                  <span className={"pill " + (st?.halted ? "halt" : st?.status === "long" ? "long" : st?.status === "short" ? "short" : "wait")}>
                    {st?.halted ? "⏸ PAUZE" : st?.status === "long" ? "🟢 LONG" : st?.status === "short" ? "🔴 SHORT" : "⏳ SCAN"}
                  </span>
                </div>
                <div className="big">{fmtEUR.format(p.price)}</div>
                <div className="delta">
                  {inPos
                    ? `${st?.status === "long" ? "🟢" : "🔴"} ${st?.status} @ ${fmtEUR.format(st!.entry_price!)}`
                    : "geen positie — de bot scant"}
                </div>
                <div className="delta dim">
                  backtest 45d: <span className={cls(p.stats.totalReturnPct)}>{sign(p.stats.totalReturnPct, 1)}</span> · {p.stats.numTrades} trades · win {p.stats.winRatePct.toFixed(0)}%
                </div>
              </div>
            );
          })}
          {!multi && <div className="statcard"><div className="big dim">systemen analyseren{busy ? "…" : ""}</div></div>}
        </div>
      </section>

      <section id="grafieken">
        <h2><span className="hash">02</span> GRAFIEKEN <span className="hint">bot-posities rechtstreeks op de candles · ▲ koop/short · ▼ exit (groen = winst){lastTickHint ? ` · bot-tick: ${lastTickHint}` : ""}</span></h2>
        <div className="grid4">
          {(multi?.pairs ?? []).map((p) => (
            <MiniChart key={p.pair} p={p} live={stateOf(p.pair)} active={p.pair === pair} onPick={() => setPair(p.pair)} />
          ))}
        </div>
        {sel && (
          <div className="card wide">
            <div className="big-head">
              <h3>{sel.name} — candles met bot-posities (45 dagen)</h3>
              <select value={pair} onChange={(e) => setPair(e.target.value)} className="sel">
                {multi!.pairs.map((p) => <option key={p.pair} value={p.pair}>{p.name}</option>)}
              </select>
              <button className="btn" onClick={loadMulti} disabled={busy}>{busy ? "analyse draait…" : "↻ opnieuw analyseren"}</button>
            </div>
            <div className="lw-chart-wrap"><PositionsChart
              candles={sel.candles} trades={sel.trades}
              paper={paper?.orders
                .filter((o) => o.pair === pair)
                .map((o) => ({ time: o.created_at, side: o.side, price: o.price, pnl: o.pnl_eur }))
                .reverse()}
            /></div>
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
            {paper?.blofin?.live && (
              <div className="blofin-strip">
                ◆ Blofin demo (paper-live): vermogen {" "}
                {paper.blofin.equityUsd != null ? paper.blofin.equityUsd.toFixed(0) : "?"}{" "}
                · open posities: {paper.blofin.positions.length}
                {paper.blofin.positions.length > 0 && (
                  <> — {paper.blofin.positions.map((q) => `${q.instId} ×${q.contracts} (${q.upl >= 0 ? "+" : ""}${q.upl.toFixed(2)}$)`).join(", ")}</>
                )}
              </div>
            )}
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
              <div className="ordertable-wrap">
              <table>
                <thead><tr><th>Tijd</th><th>Coin</th><th>Actie</th><th>Koers</th><th>Resultaat</th></tr></thead>
                <tbody>
                  {paper.orders.map((o) => (
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
              </div>
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
          <div className="phase now"><b>2 · Paper trading</b><span>actief — 4 coins · long-only · 24/7</span></div>
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
