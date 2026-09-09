"use client";

// ── MISSION CONTROL — AI Trading System dashboard ──────────────────────
// Eén overzichtspagina in HUD-stijl: live ticker, coin-status, grafieken
// met trade-markers, live activiteitenfeed en backtest-historie.
// De bot-logica (API's, strategie) is volledig onveranderd.

import { useCallback, useEffect, useRef, useState } from "react";
import { PositionsChart } from "./positionschart";
import { useStatus, useMulti, useLivePrices, type PaperOrder, type PaperState, type MultiPair } from "./status-store";

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
interface FeedItem { id: string; time: string; text: string; kind: "info" | "tick" | "order" | "ok" | "err" }

function MiniChart({ p, live, onPick, active, livePrice }: { p: MultiPair; live?: PaperState; onPick: () => void; active: boolean; livePrice?: number }) {
  const st = live?.status ?? "flat";
  return (
    <div className={"minichart" + (active ? " active" : "")} onClick={onPick}>
      <div className="mc-head">
        <b>{p.name}</b>
        <span className={"pill " + (live?.halted ? "halt" : st === "long" ? "long" : st === "short" ? "short" : "wait")}>
          {live?.halted ? "⏸ PAUZE" : st === "long" ? "🟢 LONG" : st === "short" ? "🔴 SHORT" : "⏳ SCAN"}
        </span>
      </div>
      <div className="mc-price">{fmtPrice(livePrice ?? p.price)}</div>
      <div className="mc-stats">
        <span className={cls(p.stats.totalReturnPct)}>bot 45d {sign(p.stats.totalReturnPct, 1)}</span>
        <span>{p.stats.numTrades} trades</span>
        <span>win {p.stats.winRatePct.toFixed(0)}%</span>
      </div>
    </div>
  );
}

export default function Dashboard() {
  // Gedeelde, gecachte data: één statuspoll voor alle pagina's — paginawissel
  // kost dus géén nieuwe laadtijd (de data zit al in het geheugen).
  const paper = useStatus();
  const { multi, reload: loadMulti } = useMulti();
  const prices = useLivePrices();
  const [pair, setPair] = useState("BTC-EUR");
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [clock, setClock] = useState("");
  const seen = useRef<Set<number>>(new Set());
  const tickNo = useRef(0);

  const addFeed = useCallback((text: string, kind: FeedItem["kind"]) => {
    setFeed((f) =>
      [{ id: `${Date.now()}-${Math.random()}`, time: new Date().toLocaleTimeString("nl-NL"), text, kind }, ...f].slice(0, 40)
    );
  }, []);

  // Feed vullen bij elke statuspoll: nieuwe orders direct als feed-item,
  // anders een "geen nieuwe signalen"-tik.
  useEffect(() => {
    if (!paper) return;
    const orders: PaperOrder[] = paper.orders ?? [];
    const fresh = orders.filter((o) => !seen.current.has(o.id));
    if (seen.current.size === 0) {
      orders.forEach((o) => seen.current.add(o.id));
      addFeed("Verbonden met Supabase — orderhistorie gesynchroniseerd", "info");
      if (paper.blofin?.live) addFeed(`Paper-live actief op Blofin demo — virtueel vermogen $${Number(paper.blofin.equityUsd).toFixed(0)}`, "ok");
      else if (paper.blofin?.error) addFeed(`Blofin demo: verbinding mislukt — ${paper.blofin.error}`, "err");
    } else if (fresh.length) {
      fresh.forEach((o) => {
        seen.current.add(o.id);
        const nm = o.pair.split("-")[0];
        addFeed(
          o.pnl_eur == null
            ? `${nm} — ${o.side === "buy" ? "LONG GEOPEND" : "SHORT GEOPEND"} @ ${fmtEUR.format(o.price)} (${o.ai_explanation ? `AI: ${o.ai_explanation.slice(0, 70)}` : o.reason})`
            : `${nm} — POSITIE GESLOTEN (${o.reason}): ${o.pnl_eur >= 0 ? "+" : "−"}${fmtEUR.format(Math.abs(o.pnl_eur))}`,
          "order"
        );
      });
    } else {
      tickNo.current++;
      addFeed(`Marktscan #${tickNo.current} voltooid — 8 coins · geen nieuwe signalen`, "tick");
    }
  }, [paper, addFeed]);

  useEffect(() => {
    setClock(new Date().toLocaleTimeString("nl-NL"));
    addFeed("SYSTEEM ONLINE — AI Trading System initialiseren…", "info");
    const c = setInterval(() => setClock(new Date().toLocaleTimeString("nl-NL")), 1000);
    return () => clearInterval(c);
  }, []);

  const sel = multi?.pairs.find((p) => p.pair === pair) ?? null;
  const stateOf = (pair_: string) => paper?.states.find((s) => s.pair === pair_);
  // Eén gedeelde pot: cash uit de pot-rij + waarde van alle open posities
  const potTotal = (paper?.pot?.cash ?? 0) + (paper?.states ?? []).reduce((acc, s) => {
    const px = prices?.[s.pair] ?? multi?.pairs.find((m) => m.pair === s.pair)?.price ?? 0;
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

      <div className="ticker">
        {(multi?.pairs ?? []).map((p) => {
          const st = stateOf(p.pair);
          return (
            <span key={p.pair} className="tick-item">
              <b>{p.pair.replace("-EUR", "")}</b>
              <span>{fmtPrice(prices?.[p.pair] ?? p.price)}</span>
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
                <div className="big">{fmtEUR.format(prices?.[p.pair] ?? p.price)}</div>
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
          {!multi && <div className="statcard"><div className="big dim">systemen analyseren…</div></div>}
        </div>
      </section>

      <section id="grafieken">
        <h2><span className="hash">02</span> GRAFIEKEN <span className="hint">bot-posities rechtstreeks op de candles · ▲ koop · ▼ exit (groen = winst){lastTickHint ? ` · bot-tick: ${lastTickHint}` : ""}</span></h2>
        <div className="grid4">
          {(multi?.pairs ?? []).map((p) => (
            <MiniChart key={p.pair} p={p} live={stateOf(p.pair)} active={p.pair === pair} onPick={() => setPair(p.pair)} livePrice={prices?.[p.pair]} />
          ))}
        </div>
        {sel && (
          <div className="card wide">
            <div className="big-head">
              <h3>{sel.name} — candles met bot-posities (45 dagen)</h3>
              <select value={pair} onChange={(e) => setPair(e.target.value)} className="sel">
                {multi!.pairs.map((p) => <option key={p.pair} value={p.pair}>{p.name}</option>)}
              </select>
              <button className="btn" onClick={() => loadMulti()} disabled={!multi}>{multi ? "↻ opnieuw analyseren" : "analyse draait…"}</button>
            </div>
            <div className="lw-chart-wrap"><PositionsChart
              candles={sel.candles} trades={sel.trades} pair={pair}
              paper={paper?.orders
                .filter((o) => o.pair === pair)
                .map((o) => ({ time: o.created_at, side: o.side, price: o.price, pnl: o.pnl_eur, strategy: o.strategy }))
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
        <h2><span className="hash">03</span> LIVE ACTIVITEIT <span className="hint">systeemfeed · wat de bot en de AI doen</span></h2>
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
            {paper?.agents?.aiStats ? (
              <div className="blofin-strip ai-strip" style={{ marginBottom: 10 }}>
                🤖 AI-agent {paper.agents.executeMode ? "STUURT LIVE" : "TESTMODUS"} (24u):{" "}
                {paper.agents.aiStats.calls} scans · {paper.agents.aiStats.proposals} voorstellen · kosten ≈ ${paper.agents.aiStats.costUsd.toFixed(3)}
                {" "}<a href="/ai" className="ai-link">→ naar de AI-zoektocht</a>
              </div>
            ) : null}
            <div className="feed">
              {feed.map((f) => (
                <div key={f.id} className={"feed-item " + f.kind}>
                  <span className="fi-time">{f.time}</span>
                  <span className="fi-text">{f.text}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="card feedcard">
            <h3>◆ Nieuws-radar <span className="hint">de AI beoordeelt het nieuwsbeeld mee</span></h3>
            {(() => {
              const nw = paper?.agents?.news;
              if (!nw) return <p className="delta">Nog geen nieuws-status — de AI-agent schrijft die bij zijn eerste scan.</p>;
              const lvl = nw.level === "high" ? "halt" : nw.level === "caution" ? "wait" : "long";
              const verlopen = Date.parse(nw.valid_until) < Date.now();
              const label = nw.level === "high" ? "HOOG RISICO — geen entries" : nw.level === "caution" ? "WAAKZAAM" : "RUSTIG NIEUWSBEELD";
              return (
                <>
                  <span className={"pill " + lvl}>{verlopen ? label + " (oude status)" : label}</span>
                  <p className="delta" style={{ marginTop: 8 }}>{nw.reason}</p>
                  <p className="delta dim" style={{ marginTop: 6 }}>
                    Laatste beoordeling: {dt(nw.created_at)} · bron: {nw.reason.startsWith("AI:") ? "AI-agent" : "trefwoord-radar"}
                  </p>
                </>
              );
            })()}
          </div>
        </div>
      </section>

      <section id="regels">
        <h2><span className="hash">04</span> RISICOREGELS &amp; FASES</h2>
        <div className="grid4">
          <div className="card"><h3>Stop-loss / take-profit</h3><div className="big">AI per trade</div><div className="delta">SL 1-10% · TP 0,5-15% — risicocheck keurt elk voorstel</div></div>
          <div className="card"><h3>Risico per trade</h3><div className="big">5-10%</div><div className="delta">van de pot — AI kiest, code keurt</div></div>
          <div className="card"><h3>Daglimiet</h3><div className="big">−15%</div><div className="delta">bot pauzeert die dag</div></div>
          <div className="card"><h3>Houdtijd</h3><div className="big">uren</div><div className="delta">day-trading — AI stuit ook zelf af</div></div>
        </div>
        <div className="phases">
          <div className="phase done"><b>1 · Backtest</b><span>afgerond ✓</span></div>
          <div className="phase now"><b>2 · Paper trading</b><span>actief — 8 coins · één pot · AI stuurt (longs + shorts) · 24/7</span></div>
          <div className="phase"><b>3 · Live trading</b><span>echte orders — alleen na goed fase 2</span></div>
        </div>
      </section>

      <footer>
        AI Trading System · data: Bitvavo publieke API · orders: paper + Blofin demo-spiegel · leerproject — niets hier is financieel advies.
        Cron-tick elke minuut · AI: Claude Haiku · echt geld beweegt er niet.
      </footer>
    </main>
  );
}
