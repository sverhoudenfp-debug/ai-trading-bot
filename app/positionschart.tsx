"use client";

// ── Echte TradingView-candlestick-chart MET de bot-posities erop ───────
// Gebouwd met TradingView's officiële open-source "Lightweight Charts"™
// bibliotheek (dezelfde makers als tradingview.com). In tegenstelling tot
// de gratis inline TradingView-widget kunnen we hierin wél zelf tekenen:
// elke koop/verkoop van de bot komt als pijl-marker precies op de candle
// van dat moment te staan, met de reden en het resultaat als label.

import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";

export interface OhlcPoint { t: number; o: number; h: number; l: number; c: number }
export interface TradeMarker {
  side: "long" | "short"; entryTime: number; exitTime: number;
  entryPrice: number; exitPrice: number; pnl: number; pnlPct: number; reason: string;
}

const REASON_NL: Record<string, string> = {
  "stop-loss": "stop-loss", "take-profit": "take-profit", signaal: "signaal",
  "max-hold": "max. houdtijd", daglimiet: "daglimiet", slot: "einde periode",
};

const fmtEUR = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
const localDayTime = (sec: number) =>
  new Date(sec * 1000).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export interface PaperTick {
  time: string; side: "buy" | "sell"; price: number; pnl: number | null;
  strategy?: string | null;
}

export function PositionsChart({ candles, trades, paper, pair }: {
  candles: OhlcPoint[]; trades: TradeMarker[]; paper?: PaperTick[];
  pair?: string;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  // Chart eenmalig opzetten — bewust GEEN autoSize: die bleek in deze
  // layout (flex/grid-kaarten) soms een hoogte van 0 te berekenen, waardoor
  // de grafiek onzichtbaar was. Expliciete breedte/hoogte + eigen resize-
  // listener is betrouwbaarder.
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const chart = createChart(el, {
      width: el.clientWidth || 800,
      height: 460,
      layout: {
        background: { color: "transparent" },
        textColor: "#9fb4c9",
        fontFamily: "inherit",
      },
      grid: {
        vertLines: { color: "rgba(56, 225, 255, 0.06)" },
        horzLines: { color: "rgba(56, 225, 255, 0.06)" },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: "rgba(56, 225, 255, 0.15)",
        tickMarkFormatter: (time: Time) => localDayTime(time as number),
      },
      rightPriceScale: { borderColor: "rgba(56, 225, 255, 0.15)" },
      crosshair: { mode: 0 },
      localization: {
        locale: "nl-NL",
        timeFormatter: (time: Time) => localDayTime(time as number),
        priceFormatter: (p: number) => fmtEUR.format(p),
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#3ddc84", downColor: "#ff5470", borderVisible: false,
      wickUpColor: "#3ddc84", wickDownColor: "#ff5470",
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const onResize = () => {
      if (el.clientWidth > 0) chart.applyOptions({ width: el.clientWidth, height: 460 });
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    window.addEventListener("resize", onResize);
    // eerste keer direct ook forceren (na layout van kaarten/knoppen)
    setTimeout(onResize, 0);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // LIVE candles: elke 30 seconden de laatste candles ophalen en de
  // lopende candle in de serie bijwerken (series.update) — de chart
  // beweegt nu zonder refresh. Alleen bij een geselecteerde coin.
  const lastApplied = useRef(0);
  useEffect(() => {
    if (!pair) return;
    const tick = async () => {
      const series = seriesRef.current;
      if (!series) return;
      try {
        const r = await fetch(`/api/paper/candles?pair=${pair}&interval=15`);
        const j = await r.json();
        if (!j.candles?.length) return;
        const lastT = lastApplied.current;
        for (const c of j.candles as OhlcPoint[]) {
          if (c.t < lastT) continue; // oude candle al definitief in de serie
          series.update({ time: c.t as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c });
          lastApplied.current = c.t;
        }
      } catch { /* netwerkhik: volgende tick probeert opnieuw */ }
    };
    tick();
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, [pair]);

  // Candles + markers vullen zodra data binnenkomt of wijzigt
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart || !candles.length) return;

    series.setData(
      candles.map((c) => ({ time: c.t as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c }))
    );
    lastApplied.current = candles.length ? candles[candles.length - 1].t : 0;

    // Candles zijn 15-min; een trade op 13:16 valt ertussen en een marker
    // op een niet-bestaande candle-tijd wordt stilletjes niet getekend.
    // Oplossing: elke marker naar de dichtstbijzijnde échte candle snappen.
    const times = candles.map((c) => c.t).sort((a, b) => a - b);
    const snap = (tSec: number) => {
      if (!times.length) return tSec;
      let best = times[0]; let bestDiff = Math.abs(times[0] - tSec);
      for (const t of times) {
        const d = Math.abs(t - tSec);
        if (d < bestDiff) { best = t; bestDiff = d; }
      }
      return best;
    };

    const markers: SeriesMarker<Time>[] = [];
    for (const t of trades) {
      markers.push({
        time: snap(t.entryTime) as UTCTimestamp,
        position: "belowBar",
        shape: "arrowUp",
        color: "#d9b45f",
        text: t.side === "long" ? "KOOP" : "SHORT",
      });
      markers.push({
        time: snap(t.exitTime) as UTCTimestamp,
        position: "aboveBar",
        shape: "arrowDown",
        color: t.pnl >= 0 ? "#3ddc84" : "#ff5470",
        text: `${t.pnl >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}% · ${REASON_NL[t.reason] ?? t.reason}`,
      });
    }
    // Echte paper-trades van het account: cirkels i.p.v. pijlen, met een
    // ● erin zodat je ze direct van de backtest-historie onderscheidt.
    for (const pt of paper ?? []) {
      const ts = snap(Math.floor(Date.parse(pt.time + "Z") / 1000)) as UTCTimestamp;
      const strat = pt.strategy ? ` · ${pt.strategy}` : "";
      markers.push(
        pt.side === "buy"
          ? { time: ts, position: "belowBar", shape: "circle", color: "#38e1ff", text: `● KOOP${strat}` }
          : { time: ts, position: "aboveBar", shape: "circle",
              color: pt.pnl == null ? "#38e1ff" : pt.pnl >= 0 ? "#3ddc84" : "#ff5470",
              text: pt.pnl == null ? `● VERKOOP${strat}` : `● EXIT ${pt.pnl >= 0 ? "+" : ""}${pt.pnl.toFixed(2)} EUR${strat}` }
      );
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    createSeriesMarkers(series, markers);

    chart.timeScale().fitContent();
  }, [candles, trades, paper]);

  return <div ref={container} className="lw-chart" />;
}
