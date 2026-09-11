// ── ADAPTIEF DAGLIMIET — safety-critical tests (master-prompt Deel 10) ────
// Doel: aantonen dat het daglimiet alléén als begrensde circuit breaker
// beweegt (band −5…−15%, max ±1pp/dag, één beslissing per dag, geen
// verruiming bij te weinig/extreme data) en dat het NOOIT andere
// risicoparameters aanraakt.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { decideDailyLimit, ensureTodayLimit, shiftDayStatsFrom, DayStats, LimitDecision } from "@/lib/risk/dailyLimit";
import {
  DAILY_LOSS_LIMIT_MIN_PCT, DAILY_LOSS_LIMIT_MAX_PCT, DAILY_LOSS_LIMIT_DEFAULT_PCT,
  DAILY_LOSS_MAX_ADJ_PP, DAILY_LOSS_POS_RETURN_PCT, DAILY_LOSS_MIN_TRADES,
} from "@/lib/risk/config";

const DEFAULTS = {
  min: DAILY_LOSS_LIMIT_MIN_PCT, max: DAILY_LOSS_LIMIT_MAX_PCT,
  maxAdjPp: DAILY_LOSS_MAX_ADJ_PP, posThreshold: DAILY_LOSS_POS_RETURN_PCT,
  negThreshold: -2.0, minTrades: DAILY_LOSS_MIN_TRADES, extremeThreshold: 8,
};

const good: DayStats = { returnPct: 2.5, closedTrades: 8, netPnlEur: 25, winratePct: 62 };
const bad: DayStats = { returnPct: -3.2, closedTrades: 7, netPnlEur: -32, winratePct: 29 };

describe("Adaptief daglimiet — basisband", () => {
  it("default is −10% (tussen −5 en −15)", () => {
    expect(DAILY_LOSS_LIMIT_DEFAULT_PCT).toBe(10);
    expect(DAILY_LOSS_LIMIT_MIN_PCT).toBe(5);
    expect(DAILY_LOSS_LIMIT_MAX_PCT).toBe(15);
  });

  it("limiet wordt binnen de band geklemd (−5…−15)", () => {
    const tooLoose = decideDailyLimit(4.2, good, DEFAULTS);   // te ruim → clamp naar max
    const tooTight = decideDailyLimit(18, bad, DEFAULTS);   // te strak gedefinieerd → clamp
    expect(tooLoose.previousLimitPct).toBe(5);
    expect(tooTight.previousLimitPct).toBe(15);
  });

  it("goede dag → maximaal +1pp verruimd", () => {
    const d = decideDailyLimit(10, good, DEFAULTS);
    expect(d.newLimitPct).toBe(11);
    expect(d.adjustmentPp).toBe(1);
    expect(d.reason).toContain("verruimd");
  });

  it("slechte dag → maximaal −1pp aangescherpt", () => {
    const d = decideDailyLimit(12, bad, DEFAULTS);
    expect(d.newLimitPct).toBe(11);
    expect(d.adjustmentPp).toBe(-1);
  });

  it("nooit meer dan 1pp per dag, ook niet bij extreme cijfers", () => {
    const blowUp = decideDailyLimit(10, { returnPct: 25, closedTrades: 12, netPnlEur: 250, winratePct: 90 }, DEFAULTS);
    expect(blowUp.newLimitPct - 10).toBeLessThanOrEqual(1);
    const crash = decideDailyLimit(10, { returnPct: -25, closedTrades: 12, netPnlEur: -250, winratePct: 8 }, DEFAULTS);
    expect(10 - crash.newLimitPct).toBeLessThanOrEqual(1);
  });

  it("verruiming stopt hard op −15% (band-max)", () => {
    const d = decideDailyLimit(15, good, DEFAULTS);
    expect(d.newLimitPct).toBe(15);
    expect(d.adjustmentPp).toBe(0);
  });

  it("aanscherpen stopt hard op −5% (band-min)", () => {
    const d = decideDailyLimit(5, bad, DEFAULTS);
    expect(d.newLimitPct).toBe(5);
    expect(d.adjustmentPp).toBe(0);
  });
});

describe("Adaptief daglimiet — geen roekeloos risico", () => {
  it("extreme dag (≥8%) blokkeert verruiming, ook bij 'goede' cijfers", () => {
    const d = decideDailyLimit(10, { returnPct: 9.5, closedTrades: 9, netPnlEur: 95, winratePct: 88 }, DEFAULTS);
    expect(d.adjustmentPp).toBe(0);
    expect(d.reason).toContain("geen automatische verruiming");
  });

  it("extreme verliesdag scherpt wél aan (bescherming gaat voor)", () => {
    const d = decideDailyLimit(12, { returnPct: -9, closedTrades: 9, netPnlEur: -90, winratePct: 11 }, DEFAULTS);
    expect(d.adjustmentPp).toBe(-1);
    expect(d.reason).toContain("aangescherpt");
  });

  it("onvoldoende data (< 5 trades, óók bij sterk rendement) → ongewijzigd", () => {
    const d = decideDailyLimit(10, { returnPct: 4, closedTrades: 2, netPnlEur: 40, winratePct: 100 }, DEFAULTS);
    expect(d.adjustmentPp).toBe(0);
    expect(d.reason).toContain("onvoldoende data");
  });

  it("null-stats (eerste dag) → default-limiet ongewijzigd", () => {
    const d = decideDailyLimit(10, null, DEFAULTS);
    expect(d.newLimitPct).toBe(10);
    expect(d.adjustmentPp).toBe(0);
  });

  it("neutrale dag (tussen −2% en +1%) → ongewijzigd", () => {
    const d = decideDailyLimit(10, { returnPct: 0.3, closedTrades: 10, netPnlEur: 3, winratePct: 50 }, DEFAULTS);
    expect(d.adjustmentPp).toBe(0);
    expect(d.reason).toContain("ongewijzigd");
  });

  it("de beslissing bevat alléén het limiet — risk-per-trade/notional/exposure worden niet geretourneerd of gewijzigd", () => {
    const d: LimitDecision = decideDailyLimit(10, good, DEFAULTS);
    expect(Object.keys(d).sort()).toEqual(["adjustmentPp", "newLimitPct", "performanceMetric", "previousLimitPct", "reason"]);
  });

  it("één toevallige winnaar (1 trade, +6%) beweegt het limiet niet", () => {
    const d = decideDailyLimit(10, { returnPct: 6, closedTrades: 1, netPnlEur: 60, winratePct: 100 }, DEFAULTS);
    expect(d.adjustmentPp).toBe(0);
  });
});

describe("Adaptief daglimiet — persistentie & restart", () => {
  const URL_ = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let rows: Record<string, unknown>[] = [];
  beforeEach(() => {
    rows = [];
    process.env.SUPABASE_URL = "http://test-supabase.local";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    (globalThis as { fetch?: unknown }).fetch = (async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : null;
      if (init?.method === "POST") {
        const date = String(body?.trading_date);
        if (rows.some((r) => r.trading_date === date)) {
          return new Response(JSON.stringify({ error: "duplicate" }), { status: 409 });
        }
        rows.push(body!);
        return new Response(JSON.stringify([body]), { status: 201 });
      }
      const q = new URL(_url).searchParams;
      const rawDate = q.get("trading_date");
      const date = rawDate?.startsWith("eq.") ? rawDate.slice(3) : rawDate; // supabase-conventie eq.<waarde>
      const hit = rows.filter((r) => !date || r.trading_date === date);
      const limit = Number(q.get("limit") ?? 10);
      return new Response(JSON.stringify(hit.slice(0, limit)), { status: 200 });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    process.env.SUPABASE_URL = URL_;
    process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it("beslissing per handelsdag is idempotent (restart → zelfde limiet)", async () => {
    const first = await ensureTodayLimit("2026-09-11", 1000, { closedTrades: 8, netPnlEur: 25, winratePct: 62 });
    // want: er is geen gisteren-rij → default −10 ongewijzigd
    expect(first.limitPct).toBe(10);
    const again = await ensureTodayLimit("2026-09-11", 1000);
    expect(again.limitPct).toBe(first.limitPct); // herstart verandert niets
    expect(rows.length).toBe(1);                 // precies één beslissing per dag
  });

  it("goede dag gisteren → vandaag max +1pp verruimd, en gelocked voor de rest van de dag", async () => {
    await ensureTodayLimit("2026-09-11", 1000, { closedTrades: 8, netPnlEur: 25, winratePct: 62 }); // dag A: −10
    // dag B start op equity 1030 → gisteren +3% met 8 trades → verruim
    const dayB = await ensureTodayLimit("2026-09-12", 1030, { closedTrades: 8, netPnlEur: 30, winratePct: 60 });
    expect(dayB.limitPct).toBe(11);
    // nog een run dezelfde dag (cron elke minuut) → geen tweede aanpassing
    const dayB2 = await ensureTodayLimit("2026-09-12", 1030);
    expect(dayB2.limitPct).toBe(11);
    expect(rows.filter((r) => r.trading_date === "2026-09-12").length).toBe(1);
  });

  it("slechte dag ketent: verruimd → aangescherpt terug binnen band", async () => {
    await ensureTodayLimit("2026-09-11", 1000);                    // −10
    await ensureTodayLimit("2026-09-12", 1030, { closedTrades: 8, netPnlEur: 30, winratePct: 60 }); // −11
    // gisteren −3,5%: equity 1030 → 994
    const dayC = await ensureTodayLimit("2026-09-13", 994, { closedTrades: 7, netPnlEur: -36, winratePct: 28 });
    expect(dayC.limitPct).toBe(10); // −11 aangescherpt met 1pp
  });

  it("gisteren-statistieken uit orders filteren op Amsterdamse dag + gesloten trades", () => {
    const stats = shiftDayStatsFrom([
      { created_at: "2026-09-11T10:00:00+02:00", pnl_eur: 5 },
      { created_at: "2026-09-11T22:00:00+02:00", pnl_eur: -3 },
      { created_at: "2026-09-12T09:00:00+02:00", pnl_eur: 10 },  // andere dag
      { created_at: "2026-09-11T12:00:00+02:00", pnl_eur: null }, // entry, geen pnl
    ], "2026-09-11");
    expect(stats).toEqual({ closedTrades: 2, netPnlEur: 2, winratePct: 50 });
  });

  it("Amsterdamse dag-grens: 22:45 UTC (= 00:45 Amsterdam) valt op de Amsterdamse volgende dag", async () => {
    const { amsterdamDay } = await import("@/lib/time");
    expect(amsterdamDay(new Date("2026-09-11T22:45:00.000Z"))).toBe("2026-09-12");
    expect(amsterdamDay(new Date("2026-09-11T13:45:00.000Z"))).toBe("2026-09-11"); // 15:45 Amsterdam
  });
});

describe("17. shiftDay DST-proof (audit 11 sep)", () => {
  it("kalenderdag-aftrek werkt op de wintertijd-terugdag (25-uurs dag)", async () => {
    const { shiftDay } = await import("@/lib/risk/dailyLimit");
    expect(shiftDay("2026-10-25", -1)).toBe("2026-10-24"); // nacht waarin de klok terug gaat
  });
  it("kalenderdag-aftrek werkt op de zomertijd-dag (23-uurs dag)", async () => {
    const { shiftDay } = await import("@/lib/risk/dailyLimit");
    expect(shiftDay("2026-03-29", -1)).toBe("2026-03-28"); // nacht waarin de klok vooruit gaat
  });
  it("gisteren-definitie in orders.ts is identiek aan die in ensureTodayLimit (geen ms-aftrek meer)", async () => {
    const src = (await import("node:fs")).readFileSync("lib/agents/orders.ts", "utf8");
    expect(src).toContain("const yesterday = shiftDay(today, -1);");
    expect(src).not.toContain("amsterdamDay(new Date(Date.now() - 24"); // ms-aftrek voor gisteren is verboden
    // NB: het rollende 24-uursvenster voor frequentie-guards (listOrdersSince)
    // is bewust ms-gebaseerd — dat is géén kalenderdag-grens.
  });
});
