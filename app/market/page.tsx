"use client";

// ── MARKET — marktdata zoals de bot die gebruikt + nieuws-alerts ───────
// Data: GET /api/paper/candles?market=1 (indicatoren via bestaande libs)
// en /api/paper/status (newsList). Read-only publiek — geen websocket-infra.

import { useStatus } from "../status-store";
import { Panel, Badge, Sparkline, pct, ago, dt, price, Loading, ErrorState, EmptyState, useJson } from "../ui";

interface MarketCoin {
  pair: string; name: string; price: number; change_24h_pct: number | null;
  rsi14: number; ema50: number; ema200: number; above_ema200: boolean;
  momentum_8: number; volatility_pct: number; regime: string;
  sparkline: number[]; updated_at: string; error?: string;
}

function rsiTone(v: number): string {
  if (v >= 70) return "neg";
  if (v <= 30) return "pos";
  return "dim";
}

export default function MarketPage() {
  const q = useJson<{ market: MarketCoin[] }>("/api/paper/candles?market=1", 60_000);
  const status = useStatus();
  const news = status?.agents?.newsList ?? [];
  const latest = status?.agents?.news;

  if (q.loading && !q.data) return <Loading h={300} />;
  if (q.error) return <ErrorState retry={q.retry} />;

  const coins = q.data?.market ?? [];

  return (
    <>
      <div className="grid cols-2">
        {coins.map((c) => c.error ? (
          <Panel key={c.pair} title={c.name || c.pair}><EmptyState title="Data onbeschikbaar" hint={c.error} /></Panel>
        ) : (
          <Panel key={c.pair} title={`${c.name} · ${c.pair}`} note={`upd ${ago(c.updated_at)} geleden`}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10 }}>
              <span className="kpi-value mono" style={{ fontSize: 20 }}>€{price(c.price)}</span>
              <span className={(c.change_24h_pct ?? 0) >= 0 ? "pos mono" : "neg mono"} style={{ fontSize: 14 }}>{pct(c.change_24h_pct)} 24u</span>
              <div style={{ marginLeft: "auto" }}>
                <Sparkline values={c.sparkline} w={140} h={36} />
              </div>
            </div>
            <dl className="kv" style={{ gridTemplateColumns: "auto auto auto auto", gap: "3px 34px", fontSize: 12.5 }}>
              <dt>RSI 15m</dt><dd className={rsiTone(c.rsi14)}>{c.rsi14}</dd>
              <dt>EMA 50</dt><dd>€{price(c.ema50)}</dd>
              <dt>EMA 200</dt><dd>€{price(c.ema200)}</dd>
              <dt>Boven EMA200</dt><dd>{c.above_ema200 ? "ja" : "nee"}</dd>
              <dt>Momentum 8</dt><dd className={c.momentum_8 >= 0 ? "pos" : "neg"}>{c.momentum_8 >= 0 ? "+" : ""}{c.momentum_8}%</dd>
              <dt>Volatiliteit 20</dt><dd>{c.volatility_pct}%</dd>
              <dt>Regime</dt><dd>{c.regime ?? "unknown"}</dd>
            </dl>
          </Panel>
        ))}
      </div>

      <Panel title="Nieuws-alerts" note={latest ? `actueel: ${latest.level}` : "geen actieve alert"}>
        {news.length === 0 ? <EmptyState title="Geen nieuws-alerts" hint="De nieuws-agent (Cointelegraph/CoinDesk RSS) heeft nog geen alerts opgeslagen." /> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Tijd</th><th>Level</th><th>Reden</th><th>Bron</th><th>Geldig t/m</th></tr></thead>
              <tbody>
                {news.map((n) => (
                  <tr key={n.id}>
                    <td className="dim mono">{dt(n.created_at)}</td>
                    <td>
                      <Badge tone={n.level === "high" ? "red" : n.level === "caution" ? "amber" : n.level === "ok" ? "green" : "neutral"} dot={false}>
                        {n.level.toUpperCase()}
                      </Badge>
                    </td>
                    <td className="dim" style={{ whiteSpace: "normal", maxWidth: 480 }}>{n.reason}</td>
                    <td className="dim">{n.source}</td>
                    <td className="dim mono">{dt(n.valid_until)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
