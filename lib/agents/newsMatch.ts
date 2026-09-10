// ── Nieuws-matching: tokens i.p.v. substring ───────────────────────────
// Fase 1-fix: de oude radar gebruikte t.includes("war") en matchte daardoor
// "Payward" → onterechte high-alerts. Nu: titel → lowercase tokens (woord-
// grenzen) → phrase-match. "war" matcht alleen het losse woord "war".

export type NewsCategory =
  | "macro"      // Fed, CPI, rente, recessie
  | "incident"   // hack, crash, depeg, faillissement
  | "regulatory" // ETF, lawsuit, onderzoek, ban
  | "coin"       // specifiek over een van onze coins
  | "none";

// multi-word phrases zijn mogelijk: tokens worden onderling vergeleken
export const HIGH_KEYWORDS: string[] = [
  "fed", "fomc", "cpi", "inflation", "interest rate", "rate cut",
  "rate hike", "hike", "recession", "war", "sanction", "liquidation",
  "flash crash", "crash", "hack", "hacked", "exploit", "breach",
  "billion stolen", "sec sues", "sues", "indicted", "ban", "banned",
  "depeg", "stablecoin collapse", "bankrupt", "insolvent", "emergency",
  "executive order",
];

export const CAUTION_KEYWORDS: string[] = [
  "etf", "regulation", "lawsuit", "probe", "investigation", "delist",
  "listing", "upgrade", "fork", "outflow", "inflow", "treasury",
  "approval", "delay", "veto", "tariff", "downgrade",
];

export const COIN_WORDS: Record<string, string[]> = {
  "BTC-EUR": ["bitcoin", "btc"],
  "ETH-EUR": ["ethereum", "eth"],
  "SOL-EUR": ["solana", "sol"],
  "XRP-EUR": ["xrp", "ripple"],
  "WLD-EUR": ["worldcoin", "wld"],
  "NEAR-EUR": ["near"],
  "ALGO-EUR": ["algorand", "algo"],
  "ICP-EUR": ["internet computer", "icp"],
};

/** Titel → lijst kleine alfanum token (woordscheiding op alles niet-alfanum). */
export function tokenize(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Komt de phrase (spatie-gescheiden tokens) voor in de tokenlijst? */
export function matchesPhrase(tokens: string[], phrase: string): boolean {
  const p = phrase.split(/\s+/).filter(Boolean);
  if (!p.length) return false;
  for (let i = 0; i <= tokens.length - p.length; i++) {
    let ok = true;
    for (let j = 0; j < p.length; j++) {
      if (tokens[i + j] !== p[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

export interface ClassifiedTitle {
  level: "high" | "caution" | "ok";
  category: NewsCategory;
  affectedPairs: string[]; // onze coins die genoemd worden
}

/** Beoordeel één titel (pure functie, testbaar). */
export function classifyTitle(title: string): ClassifiedTitle {
  const tokens = tokenize(title);
  const affectedPairs: string[] = [];
  for (const [pair, words] of Object.entries(COIN_WORDS)) {
    if (words.some((w) => matchesPhrase(tokens, w))) affectedPairs.push(pair);
  }

  const highHit = HIGH_KEYWORDS.find((k) => matchesPhrase(tokens, k));
  if (highHit) {
    return {
      level: "high",
      category: categoryOf(highHit),
      affectedPairs,
    };
  }
  const cautionHit = CAUTION_KEYWORDS.find((k) => matchesPhrase(tokens, k));
  if (cautionHit) {
    return {
      level: "caution",
      category: categoryOf(cautionHit),
      affectedPairs,
    };
  }
  return { level: "ok", category: "none", affectedPairs };
}

function categoryOf(keyword: string): NewsCategory {
  if (["fed", "fomc", "cpi", "inflation", "interest rate", "rate cut", "rate hike", "hike", "recession", "tariff"].includes(keyword)) return "macro";
  if (["hack", "hacked", "exploit", "breach", "billion stolen", "liquidation", "flash crash", "crash", "depeg", "stablecoin collapse", "bankrupt", "insolvent", "emergency", "war", "sanction"].includes(keyword)) return "incident";
  if (["sec sues", "sues", "indicted", "ban", "banned", "executive order", "etf", "regulation", "lawsuit", "probe", "investigation", "delist", "approval", "downgrade"].includes(keyword)) return "regulatory";
  return "none";
}
