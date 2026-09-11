// ── ADAPTIEF DAGLIMIET (circuit breaker) ────────────────────────────────
// Master-prompt "Adaptive Daily Loss": het vaste daglimiet wordt een
// begrensd adaptief circuit breaker. Doel: de beschikbare drawdown-ruimte
// voorzichtig afstemmen op recente BEWEZEN performance — NOOIT meer risico
// per trade, notional of exposure nemen (die limits staan in config.ts en
// worden door deze module niet aangeraakt).
//
// REGELS (hard, code-level afgedwongen):
//  • band: [DAILY_LOSS_LIMIT_MIN_PCT, DAILY_LOSS_LIMIT_MAX_PCT] (−5%…−15%)
//  • max ±1 percentagepunt aanpassing per Amsterdamse handelsdag
//  • max één beslissing per handelsdag (unique trading_date in de DB)
//  • verruiming (ruimere grens) alléén bij duidelijke positieve dag met
//    voldoende sample (≥ MIN_TRADES gesloten trades) — één toevallige trade
//    kan het limiet nooit bewegen; aanscherpen mag bij duidelijk slechte dag
//  • extreme/verdachte omstandigheden (|rendement| ≥ EXTREME of daglimiet
//    geraakt) → géén verruiming (alleen gelijk of aanscherpen)
//  • onvoldoende data → limiet blijft gelijk
//
// PERSISTENTIE: elke beslissing wordt opgeslagen in daily_limit_adjustments
// (supabase-daily-limit-setup.sql). Bij restart herleest de bot het limiet
// van vandaag uit de DB (idempotent). Is de tabel onbereikbaar → fail-closed
// naar het default limiet (−10%) — de circuit breaker valt NOOIT uit.

import { amsterdamDay } from "@/lib/time";
import {
  DAILY_LOSS_LIMIT_MIN_PCT, DAILY_LOSS_LIMIT_MAX_PCT, DAILY_LOSS_LIMIT_DEFAULT_PCT,
  DAILY_LOSS_MAX_ADJ_PP, DAILY_LOSS_POS_RETURN_PCT, DAILY_LOSS_NEG_RETURN_PCT,
  DAILY_LOSS_MIN_TRADES, DAILY_LOSS_EXTREME_RETURN_PCT,
} from "./config";

const URL_ = process.env.SUPABASE_URL ?? "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function h(): Record<string, string> {
  return { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
}

export interface DayStats {
  /** gerealiseerd dagrendement van de afgesloten handelsdag (in %) */
  returnPct: number;
  /** aantal gesloten trades die dag */
  closedTrades: number;
  /** netto PnL in EUR die dag */
  netPnlEur: number;
  /** winrate die dag in % */
  winratePct: number;
}

export interface LimitDecision {
  previousLimitPct: number;
  newLimitPct: number;
  adjustmentPp: number;                 // + = verruimd, − = aangescherpt, 0 = gelijk
  reason: string;                      // exact vastgelegd waarom
  performanceMetric: string;            // leesbare metric-regel
}

/** Pure beslislogica — deterministisch, geen I/O, geen toevalinvloed. */
export function decideDailyLimit(
  previousLimitPct: number,
  stats: DayStats | null,              // null = géén data (eerste dag / tabel leeg)
  cfg = {
    min: DAILY_LOSS_LIMIT_MIN_PCT, max: DAILY_LOSS_LIMIT_MAX_PCT,
    maxAdjPp: DAILY_LOSS_MAX_ADJ_PP, posThreshold: DAILY_LOSS_POS_RETURN_PCT,
    negThreshold: DAILY_LOSS_NEG_RETURN_PCT, minTrades: DAILY_LOSS_MIN_TRADES,
    extremeThreshold: DAILY_LOSS_EXTREME_RETURN_PCT,
  },
): LimitDecision {
  const clampedPrev = clamp(previousLimitPct, cfg.min, cfg.max);
  const base: LimitDecision = {
    previousLimitPct: clampedPrev, newLimitPct: clampedPrev, adjustmentPp: 0,
    reason: "onvoldoende data — limiet ongewijzigd",
    performanceMetric: stats ? fmtStats(stats) : "geen dagstatistieken beschikbaar",
  };

  if (!stats) return base;

  const perf = fmtStats(stats);
  const extreme = Math.abs(stats.returnPct) >= cfg.extremeThreshold;
  const insufficient = stats.closedTrades < cfg.minTrades;

  if (insufficient) {
    return { ...base, performanceMetric: perf,
      reason: `onvoldoende data (${stats.closedTrades} < ${cfg.minTrades} gesloten trades) — limiet ongewijzigd` };
  }
  if (extreme) {
    // extreme/verdachte dag: alleen aanscherpen toegestaan, nooit verruimen
    if (stats.returnPct <= cfg.negThreshold) {
      return tighten(base, cfg, perf, `extreme dag (${stats.returnPct.toFixed(2)}% rendement) — limiet aangescherpt`);
    }
    return { ...base, performanceMetric: perf,
      reason: `extreme/verdachte dag (${stats.returnPct.toFixed(2)}%) — geen automatische verruiming` };
  }

  if (stats.returnPct >= cfg.posThreshold) {
    return loosen(base, cfg, perf, `duidelijk positieve dag (+${stats.returnPct.toFixed(2)}% over ${stats.closedTrades} trades) — limiet voorzichtig verruimd`);
  }
  if (stats.returnPct <= cfg.negThreshold) {
    return tighten(base, cfg, perf, `slechte dag (${stats.returnPct.toFixed(2)}% over ${stats.closedTrades} trades) — limiet aangescherpt`);
  }
  return { ...base, performanceMetric: perf,
    reason: `neutrale dag (${stats.returnPct.toFixed(2)}%) — geen duidelijke performance, limiet ongewijzigd` };
}

function loosen(base: LimitDecision, cfg: { maxAdjPp: number; max: number }, perf: string, why: string): LimitDecision {
  const target = Math.min(base.previousLimitPct + cfg.maxAdjPp, cfg.max); // −11 = ruimer dan −10
  return { ...base, newLimitPct: target, adjustmentPp: r2(target - base.previousLimitPct),
    reason: why, performanceMetric: perf };
}
function tighten(base: LimitDecision, cfg: { maxAdjPp: number; min: number }, perf: string, why: string): LimitDecision {
  const target = Math.max(base.previousLimitPct - cfg.maxAdjPp, cfg.min); // −9 = strakker dan −10
  return { ...base, newLimitPct: target, adjustmentPp: r2(target - base.previousLimitPct),
    reason: why, performanceMetric: perf };
}

export interface DailyLimitRow {
  trading_date: string;
  day_start_equity: number;
  previous_limit_pct: number;
  new_limit_pct: number;
  adjustment_pp: number;
  realized_return_pct: number | null;
  closed_trades: number | null;
  winrate_pct: number | null;
  daily_pnl_eur: number | null;
  performance_metric: string | null;
  adjustment_reason: string;
  created_at: string;
}

/** Vandaag-init: idempotent — één beslissing per handelsdag (unique date). */
export async function ensureTodayLimit(
  today: string,
  dayStartEquity: number,
  yesterdayStats?: { closedTrades: number; netPnlEur: number; winratePct: number } | null,
): Promise<{ limitPct: number; decision: LimitDecision; today: string; dayStartEquity: number }> {
  const existing = await getRow(today).catch(() => null);
  if (existing) {
    return {
      limitPct: Number(existing.new_limit_pct),
      decision: {
        previousLimitPct: Number(existing.previous_limit_pct), newLimitPct: Number(existing.new_limit_pct),
        adjustmentPp: Number(existing.adjustment_pp), reason: existing.adjustment_reason,
        performanceMetric: existing.performance_metric ?? "",
      },
      today, dayStartEquity: Number(existing.day_start_equity),
    };
  }

  // gisteren: limiet + dagstart-equity → gerealiseerd dagrendement
  const yesterday = await getRow(shiftDay(today, -1)).catch(() => null);
  let stats: DayStats | null = null;
  let prevLimit = DAILY_LOSS_LIMIT_DEFAULT_PCT;

  if (yesterday) {
    prevLimit = Number(yesterday.new_limit_pct);
    const ys = Number(yesterday.day_start_equity);
    if (ys > 0 && yesterdayStats) {
      const returnPct = (dayStartEquity / ys - 1) * 100; // equity-tot-equity, incl. overnight moves
      stats = { returnPct, closedTrades: yesterdayStats.closedTrades, netPnlEur: yesterdayStats.netPnlEur, winratePct: yesterdayStats.winratePct };
    }
  }

  const decision = decideDailyLimit(prevLimit, stats);
  const row: Record<string, unknown> = {
    trading_date: today, day_start_equity: dayStartEquity,
    previous_limit_pct: decision.previousLimitPct, new_limit_pct: decision.newLimitPct,
    adjustment_pp: decision.adjustmentPp,
    realized_return_pct: stats ? r2(stats.returnPct) : null,
    closed_trades: stats?.closedTrades ?? null, winrate_pct: stats ? r2(stats.winratePct) : null,
    daily_pnl_eur: stats ? r2(stats.netPnlEur) : null,
    performance_metric: decision.performanceMetric, adjustment_reason: decision.reason,
  };

  if (URL_ && KEY) {
    try {
      const res = await fetch(`${URL_}/rest/v1/daily_limit_adjustments`, {
        method: "POST", headers: { ...h(), Prefer: "return=representation, ignore-duplicates=false" },
        body: JSON.stringify(row),
      });
      if (res.status === 409 || res.ok === false) {
        // race met een parallelle run → herlees de rij van vandaag
        const again = await getRow(today);
        if (again) return { limitPct: Number(again.new_limit_pct), decision: {
          previousLimitPct: Number(again.previous_limit_pct), newLimitPct: Number(again.new_limit_pct),
          adjustmentPp: Number(again.adjustment_pp), reason: again.adjustment_reason, performanceMetric: again.performance_metric ?? "",
        }, today, dayStartEquity: Number(again.day_start_equity) };
      }
    } catch { /* fail-closed: val terug op de beslissing in-memory */ }
  }

  return { limitPct: decision.newLimitPct, decision, today, dayStartEquity };
}

async function getRow(tradingDate: string): Promise<DailyLimitRow | null> {
  if (!URL_ || !KEY) return null;
  const res = await fetch(`${URL_}/rest/v1/daily_limit_adjustments?trading_date=eq.${encodeURIComponent(tradingDate)}&limit=1`, { headers: h() });
  if (!res.ok) return null;
  const rows = await res.json() as DailyLimitRow[];
  return rows[0] ?? null;
}

/** Actueel limiet voor een handelsdag (read-only; default bij geen rij/DB-fout). */
export async function currentLimitPct(tradingDate: string): Promise<number> {
  const row = await getRow(tradingDate).catch(() => null);
  return row ? Number(row.new_limit_pct) : DAILY_LOSS_LIMIT_DEFAULT_PCT;
}

/** Laatste N beslissingen (read-only, voor het Risk Center). */
export async function listLimitHistory(limit = 7): Promise<DailyLimitRow[]> {
  if (!URL_ || !KEY) return [];
  try {
    const res = await fetch(`${URL_}/rest/v1/daily_limit_adjustments?order=trading_date.desc&limit=${limit}`, { headers: h() });
    if (!res.ok) return [];
    return await res.json() as DailyLimitRow[];
  } catch { return []; }
}

/** Gisteren-statistieken uit gesloten orders (Amsterdamse handelsdag). */
export function shiftDayStatsFrom(
  orders: { created_at?: string | null; pnl_eur?: number | null }[],
  day: string,
): { closedTrades: number; netPnlEur: number; winratePct: number } | null {
  const closed = orders.filter(
    (o) => o.pnl_eur !== null && o.pnl_eur !== undefined && o.created_at && amsterdamDay(new Date(o.created_at)) === day,
  );
  if (!closed.length) return null;
  const wins = closed.filter((o) => (o.pnl_eur ?? 0) > 0).length;
  return {
    closedTrades: closed.length,
    netPnlEur: closed.reduce((a, o) => a + (o.pnl_eur ?? 0), 0),
    winratePct: (wins / closed.length) * 100,
  };
}

/** Amsterdamse datum ± n dagen (YYYY-MM-DD). */
/** Kalenderdag-verschuiving op YYYY-MM-DD (DST-proof: géén ms-aftrek —
 *  AUDIT 11 sep: `now − 24h` geeft op de laatste uren van een 25-uurs
 *  wintertijdstijd dag de zélfde kalenderdag terug. */
export function shiftDay(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function r2(x: number): number {
  return Math.round(x * 100) / 100;
}
function fmtStats(s: DayStats): string {
  return `rendement ${s.returnPct.toFixed(2)}% · ${s.closedTrades} trades · winrate ${s.winratePct.toFixed(0)}% · netto €${s.netPnlEur.toFixed(2)}`;
}
