// ── De marktjes die de bot volgt ─────────────────────────────────────────
// Allemaal EUR-paren op Bitvavo, allemaal voldoende liquiditeit. Elke
// coin krijgt zijn eigen virtuele potje van €1000 in de paper-modus,
// zodat de resultaten per coin eerlijk te vergelijken zijn.

export const PAIRS = ["BTC-EUR", "ETH-EUR", "SOL-EUR", "XRP-EUR"] as const;
export type Pair = (typeof PAIRS)[number];

export const PAIR_NAMES: Record<string, string> = {
  "BTC-EUR": "Bitcoin",
  "ETH-EUR": "Ethereum",
  "SOL-EUR": "Solana",
  "XRP-EUR": "XRP",
};

export function isPair(x: string): x is Pair {
  return (PAIRS as readonly string[]).includes(x);
}
