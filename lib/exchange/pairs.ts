// ── De marktjes die de bot volgt ─────────────────────────────────────────
// Allemaal EUR-paren op Bitvavo, allemaal voldoende liquiditeit. Elke
// coin krijgt zijn eigen virtuele potje van €1000 in de paper-modus,
// zodat de resultaten per coin eerlijk te vergelijken zijn.

// 9 sep 2026: WLD/NEAR/ALGO/ICP toegevoegd na backtest — samen met de
// oorspronkelijke 4 verbeterden ze de pot op élk venster (90d: 68% wr
// +4,1%; 180d: 62% wr +5,1%; was zonder hen -3,0% op 180d).
export const PAIRS = ["BTC-EUR", "ETH-EUR", "SOL-EUR", "XRP-EUR", "WLD-EUR", "NEAR-EUR", "ALGO-EUR", "ICP-EUR"] as const;
export type Pair = (typeof PAIRS)[number];

export const PAIR_NAMES: Record<string, string> = {
  "BTC-EUR": "Bitcoin",
  "ETH-EUR": "Ethereum",
  "SOL-EUR": "Solana",
  "XRP-EUR": "XRP",
  "WLD-EUR": "Worldcoin",
  "NEAR-EUR": "NEAR",
  "ALGO-EUR": "Algorand",
  "ICP-EUR": "Internet Computer",
};

export function isPair(x: string): x is Pair {
  return (PAIRS as readonly string[]).includes(x);
}
