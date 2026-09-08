"use client";

// ── TradingView-charts als eenvoudige, stevige iframes ─────────────────
// Bewust GEEN losse <script>-widget meer: die kon buiten zijn kaartje
// "lekken" omdat TradingView's eigen script de hoogte niet altijd goed
// aan onze container koppelde. Een gewone <iframe> met vaste breedte/
// hoogte kan dat niet — hij blijft altijd precies in zijn eigen vak.

export const TV_SYMBOLS: Record<string, string> = {
  "BTC-EUR": "BITVAVO:BTCEUR",
  "ETH-EUR": "BITVAVO:ETHEUR",
  "SOL-EUR": "BITVAVO:SOLEUR",
  "XRP-EUR": "BITVAVO:XRPEUR",
};

function embedUrl(symbol: string, opts: { toolbars: boolean; interval: string }) {
  const params = new URLSearchParams({
    symbol,
    interval: opts.interval,
    hidesidetoolbar: opts.toolbars ? "0" : "1",
    hidetoptoolbar: opts.toolbars ? "0" : "1",
    hidelegend: opts.toolbars ? "0" : "1",
    symboledit: "0",
    saveimage: "0",
    toolbarbg: "0a1222",
    studies: "[]",
    theme: "dark",
    style: "1",
    timezone: "Etc/UTC",
    hideideas: "1",
    withdateranges: opts.toolbars ? "1" : "0",
    locale: "nl",
  });
  return `https://www.tradingview.com/widgetembed/?${params.toString()}`;
}

/** Compacte live chart voor de coin-kaartjes — geen balken, alleen de koers */
export function TVMini({ symbol }: { symbol: string }) {
  return (
    <iframe
      className="tv-mini"
      src={embedUrl(symbol, { toolbars: false, interval: "15" })}
      loading="lazy"
      title={`Live koers ${symbol}`}
      referrerPolicy="no-referrer-when-downgrade"
    />
  );
}

/** Grote interactieve chart — alle TradingView-tools beschikbaar */
export function TVAdvanced({ symbol }: { symbol: string }) {
  return (
    <iframe
      className="tv-big"
      src={embedUrl(symbol, { toolbars: true, interval: "60" })}
      loading="lazy"
      title={`TradingView ${symbol}`}
      referrerPolicy="no-referrer-when-downgrade"
    />
  );
}
