// ── NIEUWS-AGENT ────────────────────────────────────────────────────────
// Monitort crypto-nieuws via gratis RSS-feeds (geen API-key nodig) en
// beoordeelt of aankomend nieuws volatiliteitsrisico geeft voor de munten
// die de bot verhandelt. Schrijft zijn oordeel weg als risico-status in
// de Supabase-tabel news_alerts — de order-agent leest die bij elke tick.
//
// Bronnen: Cointelegraph RSS (primair), CoinDesk RSS (fallback).
// Aanpak: sleutelwoord-radar op titels van het laatste uur.
//   high    → macro-schok of incident dat onze munten raakt → entries geblokkeerd
//   caution → mogelijk relevant, maar geen blokkade
//   ok      → rustig nieuwsbeeld
// Elke alert heeft een geldigheidsduur; daarna geldt weer de laatste status.
// Als het nieuws ophalen mislukt: niets wegschrijven (fail-open) — de bot
// handelt dan door op de laatste bekende status, net als vóór deze agent.

import { insertNewsAlert, latestNewsAlert } from "./db";

const COIN_WORDS = [
  "bitcoin", "btc", "ethereum", "eth", "solana", "sol", "xrp", "ripple",
  "worldcoin", "wld", "near", "algorand", "algo", "internet computer", "icp",
];

// Macro-schokken die de hele markt raken (hoge volatiliteit verwacht)
const HIGH_KEYWORDS = [
  "fed ", "fomc", "cpi", "inflation", "interest rate", "rate cut", "rate hike",
  "hike", "recession", "war", "sanction", "liquidation", "flash crash", "crash",
  "hack", "hacked", "exploit", "breach", "billion stolen", "sec sues", "sues",
  "indicted", "ban", "banned", "depeg", "stablecoin collapse", "bankrupt",
  "insolvent", "emergency", "executive order",
];

// Minder heftig maar wel relevant — alert blijven, geen blokkade
const CAUTION_KEYWORDS = [
  "etf", "regulation", "lawsuit", "probe", "investigation", "delist",
  "listing", "upgrade", "fork", "hack alert", "outflow", "inflow",
  "treasury", "approval", "delay", "veto", "tariff", "downgrade",
];

export interface NewsItem {
  title: string;
  publishedOn: number; // unix sec
}

export const RSS_FEEDS = [
  "https://cointelegraph.com/rss",
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
];

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&\w+;/g, " ").trim();
}

function parseRss(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? [];
  for (const b of blocks) {
    const t = b.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const d = b.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    if (!t) continue;
    const ts = d ? Date.parse(d[1].trim()) : NaN;
    items.push({
      title: stripTags(t[1]),
      publishedOn: isNaN(ts) ? 0 : Math.floor(ts / 1000),
    });
  }
  return items;
}

export async function fetchFeed(url: string): Promise<NewsItem[]> {
  const res = await fetch(url, {
    headers: { "User-Agent": "ai-trading-bot/2.0 (news-agent)" },
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status} (${url})`);
  return parseRss(await res.text());
}

/** Haalt nieuws op en beoordeelt het risico (de eigenlijke agent-run). */
export async function assessNews(): Promise<{
  level: "ok" | "caution" | "high";
  reason: string;
  headlines: string[];
}> {
  // 1. items van het laatste uur verzamelen (fallback-feed als de eerste faalt)
  const windowStart = Math.floor(Date.now() / 1000) - 3600;
  let items: NewsItem[] = [];
  let source = "rss:cointelegraph";
  try {
    items = (await fetchFeed(RSS_FEEDS[0])).filter((i) => i.publishedOn >= windowStart);
  } catch {
    // primaire feed faalt → fallback proberen
  }
  if (items.length === 0) {
    try {
      items = (await fetchFeed(RSS_FEEDS[1])).filter((i) => i.publishedOn >= windowStart);
      source = "rss:coindesk";
    } catch {
      items = [];
    }
  }

  if (items.length === 0) {
    // Geen nieuws of feeds onbereikbaar → geen nieuwe status, fail-open
    return { level: "ok", reason: "geen nieuws-items gevonden in het laatste uur", headlines: [] };
  }

  // 2. sleutelwoord-radar
  const highHits: string[] = [];
  const cautionHits: string[] = [];
  for (const it of items) {
    const t = ` ${it.title.toLowerCase()} `;
    if (HIGH_KEYWORDS.some((k) => t.includes(k))) highHits.push(it.title);
    else if (CAUTION_KEYWORDS.some((k) => t.includes(k))) cautionHits.push(it.title);
  }
  // coin-specifiek: onze munten in een negatief verhaal?
  const coinAlert = items.filter((it) => {
    const t = ` ${it.title.toLowerCase()} `;
    return COIN_WORDS.some((c) => t.includes(c)) &&
      (HIGH_KEYWORDS.some((k) => t.includes(k)) || CAUTION_KEYWORDS.some((k) => t.includes(k)));
  });

  const source_ = source; // voor de return
  if (highHits.length > 0) {
    return {
      level: "high",
      reason: `${highHits.length} hoogrisico-kop(pen) in het laatste uur${coinAlert.length ? " — raakt mogelijk onze munten" : ""}`,
      headlines: highHits.slice(0, 2),
    };
  }
  if (cautionHits.length > 0 || coinAlert.length > 0) {
    return {
      level: "caution",
      reason: `${cautionHits.length + coinAlert.length} relevante kop(pen) in het laatste uur — geen blokkade`,
      headlines: [...cautionHits, ...coinAlert.map((c) => c.title)].slice(0, 2),
    };
  }
  return { level: "ok", reason: `rustig nieuwsbeeld (${items.length} items gecontroleerd)`, headlines: [] };
}

/**
 * De nieuws-agent zélf. Throttled: haalt maximaal 1x per 10 minuten nieuws op
 * (de rest van de ticks hergebruikt de bestaande status). Elke beoordeling
 * wordt weggeschreven naar news_alerts met een geldigheidsduur.
 */
export async function newsAgent(): Promise<{ ran: boolean; level: string; reason: string; headlines: string[]; error?: string }> {
  // 1. throttle: recentste alert ophalen
  let last: Awaited<ReturnType<typeof latestNewsAlert>> = null;
  try {
    last = await latestNewsAlert();
  } catch (e) {
    return { ran: false, level: "unknown", reason: "news_alerts-tabel niet beschikbaar", headlines: [], error: String(e instanceof Error ? e.message : e) };
  }
  if (last && Date.now() - Date.parse(last.created_at) < 10 * 60_000) {
    return { ran: false, level: last.level, reason: last.reason, headlines: [] };
  }

  // 2. nieuws beoordelen en wegschrijven
  try {
    const a = await assessNews();
    const validMin = a.level === "high" ? 120 : a.level === "caution" ? 60 : 20;
    await insertNewsAlert({
      level: a.level,
      reason: a.headlines.length ? `${a.reason} · "${a.headlines[0].slice(0, 90)}"` : a.reason,
      source: "rss:cointelegraph+coindesk",
      valid_until: new Date(Date.now() + validMin * 60_000).toISOString(),
    });
    return { ran: true, level: a.level, reason: a.reason, headlines: a.headlines };
  } catch (e) {
    return { ran: false, level: "unknown", reason: "nieuws ophalen mislukt — laatste status blijft gelden", headlines: [], error: String(e instanceof Error ? e.message : e) };
  }
}

/** Leest de laatst geldige nieuws-status voor de order-agent (fail-open). */
export async function currentNewsStatus(): Promise<{
  level: "ok" | "caution" | "high" | "unknown";
  reason: string;
  fresh: boolean;
}> {
  try {
    const last = await latestNewsAlert();
    if (!last) return { level: "unknown", reason: "nog geen nieuws-status", fresh: false };
    const fresh = Date.parse(last.valid_until) > Date.now();
    return { level: last.level, reason: last.reason, fresh };
  } catch {
    return { level: "unknown", reason: "news_alerts niet leesbaar", fresh: false };
  }
}
