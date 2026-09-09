// ── GECOMBINEERDE AI-AGENT (nieuws + koersanalyse) ────────────────────────
// Vervangt de losse nieuws-agent en analyse-agent door één Claude Haiku-
// aanroep per interval (standaard elke minuut, AI_INTERVAL_MIN).
//
// Wat de AI per aanroep krijgt:
//   • indicatoren-snapshots van alle coins op 3 timeframes (5m / 15m / 1h)
//     — de AI kiest zelf welk tijdframe het meest relevant is
//   • de nieuwskoppen van het laatste uur (RSS Cointelegraph/CoinDesk)
//   • hoe elke strategie recent presteerde (winrate per strategie) — de AI
//     weegt de recentst winnende strategie zwaarder
//   • de open posities en de pot-status
// Output: gestructureerde JSON-voorstellen (trade-kans + strategie + SL/TP
// + risico + onderbouwing), weggeschreven naar trade_signals met
// proposed_by='ai' en een AI-uitleg. De order-agent voert voorstellen pas
// uit nadat het vaste veiligheids-laagje ze heeft gekeurd.
//
// Testmodus (AI_PROPOSALS_EXECUTE ≠ "on"): voorstellen worden alleen
// gelogd (outcome 'logged_test') en de oude regel-strategie blijft
// handelen — zo kunnen we de AI eerst rustig beoordelen.

import { fetchCandles } from "@/lib/exchange/marketdata";
import { PAIRS, isPair } from "@/lib/exchange/pairs";
import { rsiSeries, emaSeries, momentumSeries } from "@/lib/indicators";
import { getStates, POT_PAIR, listOrders } from "@/lib/paper/store";
import {
  insertSignal, insertNewsAlert, latestNewsAlert, listSignals,
  lastAgentRun, TradeSignal, NewSignal,
} from "./db";
import { callClaude, logAiRun, parseJsonLoose } from "./anthropic";
import { RSS_FEEDS, fetchFeed } from "./news";
import { AI_INTERVAL_MIN, aiExecuteEnabled } from "./config";

// ── systeem-instructie (statisch → cachebaar via prompt caching) ────────
const SYSTEM_PROMPT = `You are the combined analysis engine of a crypto day-trading bot (paper trading, EUR pairs on Bitvavo prices).
You receive: per-coin indicator snapshots on 3 timeframes (5m/15m/1h), fresh news headlines, recent strategy performance, open positions and pot status.
Every coin: ${PAIRS.join(", ")}.

STRATEGIES (pick per situation; weight strategies with better recent performance more heavily):
1. "rsi-dip": RSI drops under 30 while price is above EMA-200 (uptrend) — buy the fresh dip. Exit when RSI recovers.
2. "pullback": clear uptrend (price above EMA-200 on 15m and 1h), price pulls back to/near EMA-50 and momentum stabilizes — buy the continuation.
3. "breakout": price breaks above its 24h high with positive momentum and above EMA-200 — buy the breakout.
4. "news-momentum": a fresh headline is a direct positive catalyst for one of our coins (major listing, ETF approval, big adoption) — ride the momentum. Use sparingly, only with a clear catalyst.

RULES:
- Long-only policy: NEVER propose short entries. You MAY propose exits (kind "exit", side "sell") for open long positions.
- Default answer is NO trade. Only propose when the edge is clear. At most 2 proposals per run.
- This is day-trading: positions are meant to last hours, not days. Propose exits when the thesis is broken or momentum fades.
- risk_pct: percent of the pot to risk on this trade (SL hit = that loss). Choose 5-10.
- sl_pct: stop-loss distance from entry (1-10). tp_pct: take-profit distance (0.5-15). Both are required.
- Consider ALL timeframes; state which timeframe (5m/15m/1h) you based the call on.
- News: if a macro shock or major negative event (Fed surprise, big hack, crash, ban) affects our coins → set news_assessment "high" and propose NO entries. Relevant-but-mild news → "caution" and factor it into sizing/entries. Otherwise "ok".
- "explanation": short (max 25 words), in DUTCH, mentioning strategy, timeframe and whether news played a role.

OUTPUT: JSON only, no markdown fences:
{"news_assessment":{"level":"ok|caution|high","reason":"short dutch reason"},
 "proposals":[{"pair":"BTC-EUR","side":"buy","kind":"entry","strategy":"rsi-dip","timeframe":"15m","sl_pct":3,"tp_pct":4,"risk_pct":5,"confidence":"medium","explanation":"korte NL-onderbouwing"}]}`;

// ── indicatoren-snapshot per coin per timeframe ──────────────────────────
interface TfSnapshot { rsi: number; aboveEma200: boolean; aboveEma50: boolean; mom8: number }

function snapshot(closes: number[]): TfSnapshot {
  const rsi = rsiSeries(closes, 14);
  const ema200 = emaSeries(closes, 200);
  const ema50 = emaSeries(closes, 50);
  const mom = momentumSeries(closes, 8);
  const i = closes.length - 1;
  return {
    rsi: Math.round((rsi[i] ?? 50) * 10) / 10,
    aboveEma200: closes[i] > (ema200[i] ?? closes[i]),
    aboveEma50: closes[i] > (ema50[i] ?? closes[i]),
    mom8: mom[i] ?? 0,
  };
}

async function coinSnapshots(): Promise<{
  data: Record<string, unknown>[];
  unavailable: string[];
}> {
  const data: Record<string, unknown>[] = [];
  const unavailable: string[] = [];
  for (const pair of PAIRS) {
    try {
      const [c5, c15, c60] = await Promise.all([
        fetchCandles(pair, 5, 2),    // 2 dagen 5m (EMA200 = ~17u)
        fetchCandles(pair, 15, 45),  // 45 dagen 15m (EMA200 = ~2 dagen)
        fetchCandles(pair, 60, 15),  // 15 dagen 1u
      ]);
      const closes = (cs: typeof c5) => cs.map((c) => c.c);
      const last = c15[c15.length - 1].c;
      const dayCandles = c15.slice(-96); // 24 uur
      const hi = Math.max(...dayCandles.map((c) => c.h));
      const lo = Math.min(...dayCandles.map((c) => c.l));
      const dayOpen = dayCandles[0].o;
      data.push({
        pair,
        price: last,
        tf: {
          "5m": snapshot(closes(c5)),
          "15m": snapshot(closes(c15)),
          "1h": snapshot(closes(c60)),
        },
        day: { hi, lo, retPct: Math.round(((last - dayOpen) / dayOpen) * 1000) / 10 },
      });
    } catch {
      unavailable.push(pair);
    }
  }
  return { data, unavailable };
}

// ── nieuwskoppen van het laatste uur ─────────────────────────────────────
async function newsHeadlines(): Promise<{ headlines: string[]; source: string }> {
  const windowStart = Math.floor(Date.now() / 1000) - 3600;
  for (const feed of RSS_FEEDS) {
    try {
      const items = await fetchFeed(feed);
      const titles = items.filter((i) => i.publishedOn >= windowStart).map((i) => i.title).slice(0, 10);
      return { headlines: titles, source: feed.includes("coindesk") ? "coindesk" : "cointelegraph" };
    } catch { /* volgende feed */ }
  }
  return { headlines: [], source: "geen (feeds onbereikbaar)" };
}

// ── strategie-prestaties (laatste 7 dagen) ──────────────────────────────
interface PerfStat { strategy: string; trades: number; winrate: number; avgPnlEur: number }

async function strategyPerformance(): Promise<PerfStat[]> {
  const orders = await listOrders(100);
  const weekAgo = Date.now() - 7 * 86400_000;
  const closed = orders.filter(
    (o) => o.pnl_eur !== null && Date.parse(o.created_at ?? "") >= weekAgo && !!o.strategy
  );
  const by = new Map<string, { n: number; wins: number; pnl: number }>();
  for (const o of closed) {
    const st = String(o.strategy);
    const cur = by.get(st) ?? { n: 0, wins: 0, pnl: 0 };
    cur.n += 1;
    if ((o.pnl_eur ?? 0) > 0) cur.wins += 1;
    cur.pnl += o.pnl_eur ?? 0;
    by.set(st, cur);
  }
  return [...by.entries()].map(([strategy, v]) => ({
    strategy,
    trades: v.n,
    winrate: Math.round((v.wins / v.n) * 100),
    avgPnlEur: Math.round((v.pnl / v.n) * 100) / 100,
  }));
}

// ── de agent-run ─────────────────────────────────────────────────────────
export async function aiAgent(): Promise<{
  ran: boolean;
  proposals: number;
  level: string;
  skipped?: string;
  error?: string;
}> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ran: false, proposals: 0, level: "unknown", skipped: "geen ANTHROPIC_API_KEY" };
  }

  // throttle: hoogstens 1 AI-run per AI_INTERVAL_MIN
  let last: Awaited<ReturnType<typeof lastAgentRun>> = null;
  try {
    last = await lastAgentRun();
  } catch { /* tabel er nog niet → gewoon draaien */ }
  if (last && Date.now() - Date.parse(last.created_at) < AI_INTERVAL_MIN * 60_000) {
    return { ran: false, proposals: 0, level: "unknown", skipped: `throttle (${AI_INTERVAL_MIN} min interval)` };
  }

  // data verzamelen (elk stuk mag falen zonder de run te breken)
  let coins: Awaited<ReturnType<typeof coinSnapshots>> = { data: [], unavailable: [] };
  try { coins = await coinSnapshots(); } catch { /* hieronder merkbaar als unavailable */ }
  const [news, perf, states, recent] = await Promise.all([
    newsHeadlines().catch(() => ({ headlines: [], source: "onbekend" }) as Awaited<ReturnType<typeof newsHeadlines>>),
    strategyPerformance().catch(() => [] as PerfStat[]),
    getStates().catch(() => []),
    listSignals(30).catch(() => [] as TradeSignal[]),
  ]);
  const potRow = states.find((s) => s.pair === POT_PAIR);
  const positions = states
    .filter((s) => s.status !== "flat" && s.pair !== POT_PAIR)
    .map((s) => ({ pair: s.pair, side: s.status, entry: s.entry_price, since: s.entry_time, strategy: (s as { strategy?: string | null }).strategy ?? "v1.0" }));

  const userDynamic = JSON.stringify({
    pot: {
      cash: potRow?.cash ?? null,
      day_start_equity: potRow?.day_start_equity ?? null,
      halted: potRow?.halted ?? false,
    },
    positions,
    coins: coins.data,
    coins_unavailable: coins.unavailable,
    news_last_hour: { source: news.source, headlines: news.headlines },
    strategy_performance_7d: perf,
    execute_mode: aiExecuteEnabled ? "LIVE — proposals are checked by the safety layer and executed" : "TEST — proposals are only logged, nothing is executed",
  });

  // ── de daadwerkelijke Haiku-aanroep ───────────────────────────────────
  try {
    const res = await callClaude(SYSTEM_PROMPT, userDynamic);
    const parsed = parseJsonLoose(res.text) as {
      news_assessment?: { level?: string; reason?: string };
      proposals?: {
        pair?: string; side?: string; kind?: string; strategy?: string;
        timeframe?: string; sl_pct?: number; tp_pct?: number; risk_pct?: number;
        confidence?: string; explanation?: string;
      }[];
    };

    // ── nieuws-status wegschrijven (alleen bij level-wijziging) ────────
    const level = (["ok", "caution", "high"].includes(parsed.news_assessment?.level ?? "")
      ? parsed.news_assessment!.level
      : "ok") as "ok" | "caution" | "high";
    const reason = parsed.news_assessment?.reason ?? "geen opmerking";
    let storedLevel: string | null = null;
    try {
      const latest = await latestNewsAlert();
      storedLevel = latest && Date.now() - Date.parse(latest.created_at) < 60 * 60_000 ? latest.level : null;
    } catch { /* tabel er nog niet */ }
    if (storedLevel !== level) {
      try {
        await insertNewsAlert({
          level,
          reason: `AI: ${reason}`,
          source: "ai-agent",
          valid_until: new Date(Date.now() + (level === "high" ? 120 : level === "caution" ? 60 : 30) * 60_000).toISOString(),
        });
      } catch { /* never break */ }
    }

    // ── voorstellen valideren, deduppen en wegschrijven ─────────────────
    const valid: NewSignal[] = [];
    for (const pr of parsed.proposals ?? []) {
      const pair = String(pr.pair ?? "");
      if (!isPair(pair)) continue;
      if (pr.side !== "buy" && pr.side !== "sell") continue;
      if (pr.kind !== "entry" && pr.kind !== "exit") continue;
      // long-only: short-entries van de AI structuurmatig weren
      if (pr.kind === "entry" && pr.side === "sell") {
        await insertSignal({
          pair, side: "sell", kind: "entry", reason: "AI stelde short voor (geblokkeerd: long-only)",
          strategy_version: "ai-short", proposed_by: "ai", ai_explanation: pr.explanation ?? null,
          consumed: true, outcome: "blocked_long_only",
        } as NewSignal);
        continue;
      }
      const age10 = Date.now() - 10 * 60_000;
      const dupe = recent.some(
        (s) => s.pair === pair && s.kind === pr.kind && s.side === pr.side && Date.parse(s.created_at) >= age10
      );
      if (dupe) continue; // geen dubbele voorstellen binnen 10 min

      const base: NewSignal = {
        pair,
        side: pr.side as "buy" | "sell",
        kind: pr.kind as "entry" | "exit",
        reason: pr.strategy ? `AI-voorstel (${pr.strategy})` : "AI-voorstel",
        strategy_version: pr.strategy ?? "ai",
        proposed_by: "ai",
        ai_explanation: pr.explanation ?? null,
        timeframe: pr.timeframe ?? null,
        confidence: pr.confidence ?? null,
      };
      if (pr.kind === "entry") {
        base.sl_pct = Number(pr.sl_pct) || null;
        base.tp_pct = Number(pr.tp_pct) || null;
        base.risk_pct = Number(pr.risk_pct) || null;
      }
      // testmodus: alleen loggen, niet uitvoeren
      if (!aiExecuteEnabled) {
        base.consumed = true;
        base.outcome = "logged_test";
      }
      valid.push(base);
    }
    for (const v of valid) await insertSignal(v);

    await logAiRun({ usage: res.usage, costUsd: res.costUsd, proposals: valid.length });
    return { ran: true, proposals: valid.length, level };
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    await logAiRun({ usage: null, costUsd: 0, proposals: 0, error: msg });
    return { ran: false, proposals: 0, level: "unknown", error: msg };
  }
}
