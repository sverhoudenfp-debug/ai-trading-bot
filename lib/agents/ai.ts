// ── GECOMBINEERDE AI-AGENT (nieuws + koersanalyse) — FASE 1-VERSI ────────
// Slim interval (open positie/volatiliteit → elke minuut; rust → 15 min).
//
// Fase 1-wijzigingen t.o.v. de vorige versie:
//   • AI-BUDGET: max aanroepen per uur/dag + max kosten/dag (risk-config);
//     budget op → AI zwijgt, risicobeheer van de order-agent loopt door.
//   • STRIKTE OUTPUT-VALIDATIE (lib/agents/schema.ts): veldenuem, ranges,
//     onbekende velden → gehele run afgewezen (hard fail, geen gedeeltelijke
//     uitvoering). Cap: max 2 voorstellen per run, code-level afgedwongen;
//     overtollige voorstellen worden gelogd als 'rejected_cap'.
//   • FEE-AWARE: de prompt zegt expliciet dat ~0,6% round-trip-kosten elke
//     kleine trade vermoorden; de risk-engine keurt te kleine TP's hard af.
//   • CONTEXT: de AI ziet nu z'n EIGEN recente trades (pair, pnl, duur,
//     exit-reden) + cooldown/frequentie-status per pair, zodat een net
//     gefaalde setup niet blind opnieuw wordt genomen.
//   • NIEUWS = EÉN SOURCE OF TRUTH: de AI beoordeelt nieuws nog wel, maar
//     schrijft NIET meer naar news_alerts (dat doet alleen de RSS-agent).
//   • RISICO-BANDEN: 0,25–1,0% van de pot (was 5–10%).
//
// De AI kan NOOIT zelf uitvoeren: voorstellen gaan naar trade_signals en
// worden door de order-agent + risk-engine gekeurd voordat er iets gebeurt.

import { fetchCandles } from "@/lib/exchange/marketdata";
import { PAIRS, isPair } from "@/lib/exchange/pairs";
import { rsiSeries, emaSeries, momentumSeries } from "@/lib/indicators";
import { getStates, POT_PAIR, listOrdersSince } from "@/lib/paper/store";
import {
  insertSignal, listSignals, lastAgentRun, TradeSignal, NewSignal, aiUsageSince,
} from "./db";
import { callClaude, logAiRun, parseJsonLoose } from "./anthropic";
import { RSS_FEEDS, fetchFeed } from "./news";
import { AI_QUIET_INTERVAL_MIN, AI_VOLATILITY_PCT, aiExecuteEnabled } from "./config";
import { getActiveWeights, StrategyWeights } from "./learn";
import { validateAiOutput, capProposals } from "./schema";
import {
  RISK_MIN_PCT, RISK_MAX_PCT,
  AI_MAX_CALLS_PER_HOUR, AI_MAX_CALLS_PER_DAY, AI_MAX_COST_USD_PER_DAY,
  ROUND_TRIP_COST_PCT, COOLDOWN_MIN,
} from "@/lib/risk/config";
import { cooldownGuard } from "@/lib/risk/engine";

// ── systeem-instructie (statisch → cachebaar via prompt caching) ────────
const SYSTEM_PROMPT = `You are the risk-conscious analysis engine of a crypto day-trading bot (paper trading, EUR pairs on Bitvavo prices).
You receive: per-coin indicator snapshots on 3 timeframes (5m/15m/1h), fresh news headlines, recent strategy performance, self-learning weights, YOUR OWN recent trades, per-pair cooldown/frequency status, open positions and pot status.
Every coin: ${PAIRS.join(", ")}.

FEES ARE THE ENEMY: every trade costs ~${ROUND_TRIP_COST_PCT.toFixed(2)}% round-trip (fees+slippage). A trade whose expected move does not clearly exceed that is a LOSING trade. The risk engine hard-rejects: tp_pct < 1.5%, or net reward/risk after costs < 1.0. Do not waste proposals on marginal or scalping setups.

STRATEGIES (only these are allowed):
1. "rsi-dip": RSI drops under 30 while price is above EMA-200 (uptrend) — buy the fresh dip.
2. "pullback": clear uptrend (price above EMA-200 on 15m AND 1h), price pulls back to/near EMA-50 and momentum stabilizes — buy the continuation.
3. "breakout": price breaks above its 24h high with positive momentum and above EMA-200 — buy the breakout.
4. "news-momentum": a fresh headline is a direct positive catalyst for one of our coins — ride the momentum. Use sparingly.
5. "rsi-fade-short": clear DOWNTREND (price below EMA-200 on 15m and 1h), RSI bounces above 70 — short the overbought bounce. Use sparingly.
SELF-LEARNING LAYER: "strategy_weights" holds a daily-updated multiplier per strategy: >1.0 = performing (may enter more readily), <1.0 = underperforming (only A-grade setups).

WHEN NOT TO TRADE — "no trade" is a full and often the BEST answer. Wait when:
- the edge is small or unclear, or the setup is below A/B quality;
- the market is choppy with no trend;
- the same pair just had a losing trade (see recent_trades) — wait for a genuinely different situation, do not re-enter the same failed setup;
- cooldown is active on the pair (see pair_status);
- risk/reward after fees is unattractive.

RULES:
- Default answer is NO trade. At most 2 proposals per run, A-grade setups only.
- risk_pct: 0.25-1.0 percent of the pot risked if SL hits (hard band). Prefer 0.5.
- sl_pct: 1-10. tp_pct: 0.5-15 (realistically ≥1.5% to clear fees).
- Positions have a HARD minimum hold of 15 minutes — do not plan sub-15-minute scalps; expected_duration_min must be ≥15. Early exits you propose are ignored unless news turns high; SL/TP/max-hold protect the position meanwhile.
- Long entries (side "buy") are the bread-and-butter. Short entries (side "sell") only in a convincing downtrend confirmed on 1h. Exits: kind "exit" closes the open position.
- Consider ALL timeframes; state which timeframe you based the call on.
- If a macro shock or major negative event affects our coins → news_assessment "high" and propose NO entries.

OUTPUT — JSON only, EXACT schema, no extra fields, no markdown fences. Any invalid field rejects the whole run:
{"news_assessment":{"level":"ok|caution|high","reason":"short dutch reason"},
 "proposals":[{"pair":"BTC-EUR","side":"buy","kind":"entry","strategy":"rsi-dip","timeframe":"15m","sl_pct":2.5,"tp_pct":4,"risk_pct":0.5,"confidence":"high","expected_move_pct":4,"expected_duration_min":240,"setup_quality":"A","thesis":"korte NL verwachting","invalidation":"korte NL wanneer de these faalt","explanation":"korte NL-onderbouwing incl. timeframe"}]}
- Entries REQUIRE every field above. Exits require only: pair, side, kind, strategy, timeframe, explanation.
- "explanation" max 25 words, in DUTCH.`;

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
        fetchCandles(pair, 5, 2),    // 2 dagen 5m
        fetchCandles(pair, 15, 45),  // 45 dagen 15m
        fetchCandles(pair, 60, 15),  // 15 dagen 1h
      ]);
      const closes = (cs: typeof c5) => cs.map((c) => c.c);
      const last = c15[c15.length - 1].c;
      const dayCandles = c15.slice(-96); // 24 uur
      const hi = Math.max(...dayCandles.map((c) => c.h));
      const lo = Math.min(...dayCandles.map((c) => c.l));
      const dayOpen = dayCandles[0].o;
      const vol24h = Math.round(dayCandles.reduce((a, c) => a + c.v, 0));
      data.push({
        pair,
        price: last,
        tf: {
          "5m": snapshot(closes(c5)),
          "15m": snapshot(closes(c15)),
          "1h": snapshot(closes(c60)),
        },
        day: { hi, lo, retPct: Math.round(((last - dayOpen) / dayOpen) * 1000) / 10, vol24h },
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

// ── strategie-prestaties (laatste 7 dagen, VOLLEDIG venster) ────────────
interface PerfStat { strategy: string; trades: number; winrate: number; avgPnlEur: number }

async function strategyPerformance(): Promise<PerfStat[]> {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const orders = await listOrdersSince(since);
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

// ── eigen recente trades + pair-status voor de AI-context ────────────────
interface RecentTrade {
  pair: string; direction: string; strategy: string | null;
  pnl_eur: number; hold_min: number; exit_reason: string; closed_at: string;
}

async function recentTradesAndPairStatus(): Promise<{
  recentTrades: RecentTrade[];
  pairStatus: Record<string, unknown>[];
}> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const orders = await listOrdersSince(since);
  // FIFO-koppeling entry→exit per pair (hold-tijd schatten)
  const openQ = new Map<string, { created_at: string; strategy: string | null; side: string }[]>();
  const recentTrades: RecentTrade[] = [];
  for (const o of orders) {
    if (o.pnl_eur === null) {
      openQ.set(o.pair, [...(openQ.get(o.pair) ?? []), { created_at: o.created_at!, strategy: o.strategy ?? null, side: o.side }]);
    } else {
      const q = openQ.get(o.pair);
      const entry = q?.shift();
      const holdMin = entry
        ? Math.max(0, Math.round((Date.parse(o.created_at!) - Date.parse(entry.created_at)) / 60_000))
        : -1;
      recentTrades.push({
        pair: o.pair,
        direction: entry ? (entry.side === "buy" ? "long" : "short") : (o.side === "sell" ? "long" : "short"),
        strategy: entry?.strategy ?? o.strategy ?? null,
        pnl_eur: o.pnl_eur,
        hold_min: holdMin,
        exit_reason: o.reason,
        closed_at: o.created_at!,
      });
    }
  }
  recentTrades.sort((a, b) => Date.parse(b.closed_at) - Date.parse(a.closed_at));

  const now = new Date();
  const pairStatus: Record<string, unknown>[] = [];
  for (const pair of PAIRS) {
    const cd = cooldownGuard(orders, pair, now);
    pairStatus.push({
      pair,
      cooldown_remaining_min: cd.ok ? 0 : cd.remainingMin,
      entries_last_hour: orders.filter((o) => o.pnl_eur === null && o.pair === pair && Date.parse(o.created_at!) >= now.getTime() - 3600_000).length,
      closed_trades_24h: recentTrades.filter((t) => t.pair === pair).length,
    });
  }
  return { recentTrades: recentTrades.slice(0, 10), pairStatus };
}

// ── slim interval (onveranderd in Fase 1) ───────────────────────────────
async function smartInterval(): Promise<{ min: number; reason: string }> {
  try {
    const states = await getStates();
    if (states.some((s) => s.pair !== POT_PAIR && s.status !== "flat")) {
      return { min: 0, reason: "open positie — elke minuut scannen" };
    }
  } catch { /* states onbereikbaar → volatiliteitscheck geldt nog steeds */ }
  try {
    let vol = 0; let volPair = "";
    for (const p of PAIRS) {
      const c = await fetchCandles(p, 5, 1);
      const recent = c.slice(-3); // laatste 15 minuten
      if (recent.length < 3) continue;
      const hi = Math.max(...recent.map((x) => x.h));
      const lo = Math.min(...recent.map((x) => x.l));
      const pct = ((hi - lo) / recent[recent.length - 1].c) * 100;
      if (pct > vol) { vol = pct; volPair = p; }
    }
    if (vol >= AI_VOLATILITY_PCT) {
      return { min: 0, reason: `volatiliteit ${volPair.replace("-EUR", "")} ${vol.toFixed(1)}% in 15 min — elke minuut scannen` };
    }
  } catch { /* candle-data onbereikbaar → rustig-interval geldt */ }
  return { min: AI_QUIET_INTERVAL_MIN, reason: `rustige markt — max elke ${AI_QUIET_INTERVAL_MIN} min` };
}

export interface AiAgentResult {
  ran: boolean;
  proposals: number;
  level: string;
  skipped?: string;
  error?: string;
}

// ── AI-budgetcheck (Fase 1) ─────────────────────────────────────────────
async function aiBudgetOk(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  const [uH, uD] = await Promise.all([aiUsageSince(hourAgo), aiUsageSince(dayAgo)]);
  if (uH.calls >= AI_MAX_CALLS_PER_HOUR) {
    return { ok: false, reason: `AI-budget: ${uH.calls}/${AI_MAX_CALLS_PER_HOUR} aanroepen dit uur` };
  }
  if (uD.calls >= AI_MAX_CALLS_PER_DAY) {
    return { ok: false, reason: `AI-budget: ${uD.calls}/${AI_MAX_CALLS_PER_DAY} aanroepen vandaag` };
  }
  if (uD.costUsd >= AI_MAX_COST_USD_PER_DAY) {
    return { ok: false, reason: `AI-budget: $${uD.costUsd.toFixed(2)}/$${AI_MAX_COST_USD_PER_DAY} kosten vandaag` };
  }
  return { ok: true };
}

export async function aiAgent(): Promise<AiAgentResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ran: false, proposals: 0, level: "unknown", skipped: "geen ANTHROPIC_API_KEY" };
  }

  // throttle: slim interval
  let last: Awaited<ReturnType<typeof lastAgentRun>> = null;
  try {
    last = await lastAgentRun();
  } catch { /* tabel er nog niet → gewoon draaien */ }
  const smart = await smartInterval();
  if (last && Date.now() - Date.parse(last.created_at) < smart.min * 60_000) {
    return { ran: false, proposals: 0, level: "unknown", skipped: `throttle (slim interval — ${smart.reason})` };
  }

  // AI-budget — op → AI zwijgt; risicobeheer (order-agent) loopt gewoon door
  const budget = await aiBudgetOk().catch(() => ({ ok: true }) as { ok: true });
  if (!budget.ok) {
    return { ran: false, proposals: 0, level: "unknown", skipped: budget.reason };
  }

  // data verzamelen (elk stuk mag falen zonder de run te breken)
  let coins: Awaited<ReturnType<typeof coinSnapshots>> = { data: [], unavailable: [] };
  try { coins = await coinSnapshots(); } catch { /* hieronder merkbaar als unavailable */ }
  const [news, perf, states, recent, learned, tradeCtx] = await Promise.all([
    newsHeadlines().catch(() => ({ headlines: [], source: "onbekend" }) as Awaited<ReturnType<typeof newsHeadlines>>),
    strategyPerformance().catch(() => [] as PerfStat[]),
    getStates().catch(() => []),
    listSignals(30).catch(() => [] as TradeSignal[]),
    getActiveWeights().catch(() => null),
    recentTradesAndPairStatus().catch(() => ({ recentTrades: [] as RecentTrade[], pairStatus: [] as Record<string, unknown>[] })),
  ]);
  const weights: StrategyWeights = learned?.weights ?? {};
  const weightLine = Object.entries(weights).length
    ? Object.entries(weights).map(([s, w]) => `${s} x${w.toFixed(2)}`).join(", ")
    : "none yet (all neutral 1.0)";
  const potRow = states.find((s) => s.pair === POT_PAIR);
  const positions = states
    .filter((s) => s.status !== "flat" && s.pair !== POT_PAIR)
    .map((s) => ({ pair: s.pair, side: s.status, entry: s.entry_price, since: s.entry_time, age_min: s.entry_time ? Math.round((Date.now() - Date.parse(s.entry_time)) / 60_000) : null, strategy: (s as { strategy?: string | null }).strategy ?? "v1.0" }));

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
    strategy_weights: weights,
    strategy_weights_note: `self-learning layer ${learned?.version ?? "uninitialized"}: ${weightLine}`,
    recent_trades: tradeCtx.recentTrades,   // eigen trades: pair/pnl/duur/exit-reden
    pair_status: tradeCtx.pairStatus,       // cooldown + frequentie per pair
    risk_band_pct: [RISK_MIN_PCT, RISK_MAX_PCT],
    round_trip_cost_pct: ROUND_TRIP_COST_PCT,
    execute_mode: aiExecuteEnabled ? "LIVE — proposals are checked by the risk engine and executed" : "TEST — proposals are only logged, nothing is executed",
  });

  // ── de daadwerkelijke Haiku-aanroep ───────────────────────────────────
  try {
    const res = await callClaude(SYSTEM_PROMPT, userDynamic);
    const parsed = parseJsonLoose(res.text);

    // STRIKTE validatie: één ongeldig veld ⇒ gehele run afgewezen
    const validated = validateAiOutput(parsed);
    if (!validated.ok) {
      await logAiRun({ usage: res.usage, costUsd: res.costUsd, proposals: 0, error: `schema-validatie: ${validated.error}` });
      return { ran: false, proposals: 0, level: "unknown", error: `schema-validatie: ${validated.error}` };
    }
    const { news: aiNews, proposals } = validated.value;

    // CAP: max 2 voorstellen per run, code-level; overtollige loggen
    const { keep, rejected } = capProposals(proposals);

    for (const r of rejected) {
      await insertSignal({
        pair: r.pair, side: r.side, kind: r.kind,
        reason: `AI-voorstel geweigerd (cap >2): ${r.strategy}`,
        strategy_version: r.strategy, proposed_by: "ai",
        ai_explanation: r.explanation, timeframe: r.timeframe,
        consumed: true, outcome: "rejected_cap",
      }).catch(() => undefined); // logging mag niet breken
    }

    // voorstellen valideren op pair/dedup en wegschrijven
    const valid: NewSignal[] = [];
    for (const pr of keep) {
      if (!isPair(pr.pair)) continue; // al gecheckt in schema, dubbel voor TS
      const age10 = Date.now() - 10 * 60_000;
      const dupe = recent.some(
        (s) => s.pair === pr.pair && s.kind === pr.kind && s.side === pr.side && Date.parse(s.created_at) >= age10
      );
      if (dupe) continue; // geen dubbele voorstellen binnen 10 min

      const base: NewSignal = {
        pair: pr.pair,
        side: pr.side,
        kind: pr.kind,
        reason: pr.strategy ? `AI-voorstel (${pr.strategy})` : "AI-voorstel",
        strategy_version: pr.strategy,
        proposed_by: "ai",
        ai_explanation: pr.explanation,
        timeframe: pr.timeframe,
        confidence: pr.confidence,
        expected_move_pct: pr.expected_move_pct,
        expected_duration_min: pr.expected_duration_min,
        setup_quality: pr.setup_quality,
        thesis: pr.thesis,
        invalidation: pr.invalidation,
      };
      if (pr.kind === "entry") {
        base.sl_pct = pr.sl_pct;
        base.tp_pct = pr.tp_pct;
        base.risk_pct = pr.risk_pct;
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
    return {
      ran: true,
      proposals: valid.length,
      level: aiNews.level,
      // nieuws-beoordeling van de AI: alleen in het antwoord, NIET in
      // news_alerts (source of truth = RSS-nieuws-agent)
      error: undefined,
    };
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    await logAiRun({ usage: null, costUsd: 0, proposals: 0, error: msg });
    return { ran: false, proposals: 0, level: "unknown", error: msg };
  }
}
