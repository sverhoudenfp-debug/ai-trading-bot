"use client";

// ── TradingView-widgets (ingebed, geen account nodig) ───────────────────
// Live interactieve charts per coin. Symboolvorm: BITVAVO:BTCEUR.

import { useEffect, useRef } from "react";

function useTradingView(
  ref: React.RefObject<HTMLDivElement | null>,
  src: string,
  config: Record<string, unknown>
) {
  const key = JSON.stringify(config);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = "";
    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.height = "100%";
    widget.style.width = "100%";
    el.appendChild(widget);
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = src;
    script.async = true;
    script.innerHTML = key;
    el.appendChild(script);
    return () => {
      el.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, key]);
}

export const TV_SYMBOLS: Record<string, string> = {
  "BTC-EUR": "BITVAVO:BTCEUR",
  "ETH-EUR": "BITVAVO:ETHEUR",
  "SOL-EUR": "BITVAVO:SOLEUR",
  "XRP-EUR": "BITVAVO:XRPEUR",
};

/** Compacte live chart voor de coin-kaartjes */
export function TVMini({ symbol }: { symbol: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useTradingView(ref, "https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js", {
    symbol,
    locale: "nl",
    dateRange: "1M",
    colorTheme: "dark",
    isTransparent: true,
    autosize: true,
    chartOnly: false,
  });
  return <div className="tv-mini" ref={ref} />;
}

/** Grote interactieve chart (alle technische tools van TradingView) */
export function TVAdvanced({ symbol }: { symbol: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useTradingView(ref, "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js", {
    symbol,
    interval: "60",
    locale: "nl",
    theme: "dark",
    style: "1",
    autosize: true,
    hide_side_toolbar: false,
    allow_symbol_change: false,
    save_image: false,
    calendar: false,
  });
  return <div className="tv-big" ref={ref} />;
}
