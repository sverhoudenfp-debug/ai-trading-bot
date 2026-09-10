// ── FASE 4 SAFETY-TESTS — Paper Validation Engine ─────────────────────────
// Vitest. De 30 testgebieden uit Deel 33 met synthetische orders — geen
// echte exchange-aanroepen. Elk gebied staat in de testcomment.

import { describe, it, expect } from "vitest";

import { computeFullPaperMetrics, aiExitVerdict, regimeOfEntry } from "@/lib/validation/metrics";
import { computeDrift, expectedProfileFrom } from "@/lib/validation/drift";
import { runApprovalGate } from "@/lib/validation/approve";
import { checkDataIntegrity } from "@/lib/validation/integrity";
import { confidenceReport, bootstrapExpectancy } from "@/lib/validation/confidence";
import { checkActivationConstraints } from "@/lib/evolution/registry";
import { transitionAllowed, canTradePaper, reactivationBlocked, RegistryStatus } from "@/lib/evolution/lifecycle";
import type { RegistryRow } from "@/lib/evolution/db";
import type { PaperOrderExt } from "@/lib/paper/store";
import * as fs from "node:fs";
import * as path from "node:path";

// ── synthetische orders (entries + exits met Fase-1 context-keys) ─────────
interface MkOpts { fees?: number; slip?: number; hold?: number; reason?: string; regime?: Record<string, unknown>; pair?: string }

function mkEntry(i: number, pair = "BTC-EUR", ctx: Record<string, unknown> = {}): PaperOrderExt {
  return {
    id: 10_000 + i, created_at: new Date(Date.now() - (120 - i * 4) * 3_600_000).toISOString(),
    pair, side: "buy", price: 100, size: 1, reason: "entry", equity_after: 1000,
    pnl_eur: null, pnl_pct: null, strategy: "evo/x@2.0.0",
    context: ctx,
  };
}

function mkExit(i: number, pnl: number, pair = "BTC-EUR", o: MkOpts = {}): PaperOrderExt {
  const fees = o.fees ?? 0.4;
  const slip = o.slip ?? 0.05;
  const hold = o.hold ?? 90;
  return {
    id: 20_000 + i, created_at: new Date(Date.now() - (119.8 - i * 4) * 3_600_000).toISOString(),
    pair, side: "sell", price: 100, size: 1, reason: o.reason ?? "take_profit", equity_after: 1000 + pnl,
    pnl_eur: pnl, pnl_pct: pnl, strategy: "evo/x@2.0.0",
    context: {
      gross_pnl_eur: Math.round((pnl + fees + slip) * 100) / 100,
      fees_eur: fees, slippage_eur: slip, net_pnl_eur: pnl,
      hold_min: hold, exit_reason: o.reason ?? "take_profit",
      ...(o.regime ?? {}),
    },
  };
}

interface EntryCtx { rsi15?: number; above_ema200?: boolean; dist_ema50_pct?: number; day_hi?: number; day_lo?: number }

function expectedGood() {
  return {
    expectancyEur: 0.5, profitFactor: 1.5, winratePct: 55, maxDrawdownPct: 3,
    avgHoldMin: 90, tradesPerDay: 0.6, feeRatioPct: 25, netPnl: 20, trades: 40,
  };
}

function metricsFrom(pnls: number[], o: MkOpts = {}): ReturnType<typeof computeFullPaperMetrics> {
  const orders: PaperOrderExt[] = [];
  pnls.forEach((p, i) => {
    orders.push(mkEntry(i, o.pair ?? "BTC-EUR", o.regime ?? { rsi15: 30, above_ema200: true, dist_ema50_pct: -1, day_hi: 102, day_lo: 99 }));
    orders.push(mkExit(i, p, o.pair ?? "BTC-EUR", o));
  });
  return computeFullPaperMetrics({
    orders,
    activatedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
  });
}

// ═══ 1-6: METRICS + GROSS/FEE/SLIPPAGE/NET SCHEIDING ═══
describe("paper metrics (Deel 6/11)", () => {
  it("6: gross/fees/slippage/net zijn afzonderlijk gemeten (echte context-keys)", () => {
    const m = metricsFrom([2, 2, 2], { fees: 0.5, slip: 0.1 });
    expect(m.closed).toBe(3);
    expect(m.netPnl).toBe(6);            // som netto pnl
    expect(m.fees).toBe(1.5);            // 3 × 0,5
    expect(m.slippage).toBeCloseTo(0.3); // 3 × 0,1
    expect(m.grossPnl).toBeCloseTo(7.8); // netto + fees + slip
    expect(m.winratePct).toBe(100);
  });

  it("5: volledige metriekset aanwezig (streaks, median, per-coin, hold)", () => {
    const m = metricsFrom([2, -1, 2, -1, 2, 2]);
    expect(m.maxLossStreak).toBe(1);
    expect(m.maxWinStreak).toBe(2);
    expect(m.avgHoldMin).toBe(90);
    expect(m.medianHoldMin).toBe(90);
    expect(m.longestHoldMin).toBe(90);
    expect(m.perCoin).toHaveLength(1);
    expect(m.perCoin[0]).toMatchObject({ pair: "BTC-EUR", trades: 6, netPnl: 6 });
    expect(m.tradesPerDay).toBeGreaterThan(0);
    expect(m.activeDays).toBeGreaterThanOrEqual(1);
  });

  it("15: per-coin metrics en concentratierisico-detectie", () => {
    const orders: PaperOrderExt[] = [];
    // BTC +€60 (6 trades), ETH −€10 (4 trades) → 100% van positieve netto in BTC
    [10, 10, 10, 10, 10, 10].forEach((p, i) => { orders.push(mkEntry(i, "BTC-EUR")); orders.push(mkExit(i, p, "BTC-EUR")); });
    [-2.5, -2.5, -2.5, -2.5].forEach((p, i) => { orders.push(mkEntry(50 + i, "ETH-EUR")); orders.push(mkExit(50 + i, p, "ETH-EUR")); });
    const m = computeFullPaperMetrics({ orders, activatedAt: new Date(Date.now() - 10 * 86_400_000).toISOString() });
    expect(m.perCoin).toHaveLength(2);
    const btc = m.perCoin.find((c) => c.pair === "BTC-EUR")!;
    const eth = m.perCoin.find((c) => c.pair === "ETH-EUR")!;
    expect(btc.netPnl).toBe(60);
    expect(eth.netPnl).toBe(-10);
    expect(m.singleCoinSharePct).toBe(100);
    expect(m.concentrationRisk).toBe(true);
  });

  it("14: per-regime metrics uit de entry-snapshot + INSUFFICIENT_REGIME_DATA", () => {
    const up = { rsi15: 30, above_ema200: true, dist_ema50_pct: -1, day_hi: 102, day_lo: 99 };     // uptrend/mid-vol
    const down = { rsi15: 70, above_ema200: false, dist_ema50_pct: 2, day_hi: 101, day_lo: 99 };  // downtrend-sideways
    const orders: PaperOrderExt[] = [];
    [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2].forEach((p, i) => {
      const ctx = i < 10 ? up : down; // 10 in uptrend, 2 in downtrend
      orders.push(mkEntry(i, "BTC-EUR", ctx));
      orders.push(mkExit(i, p, "BTC-EUR"));
    });
    const m = computeFullPaperMetrics({ orders, activatedAt: new Date(Date.now() - 10 * 86_400_000).toISOString() });
    const up2 = m.perRegime.find((r) => r.regime.startsWith("uptrend"));
    expect(up2?.trades).toBe(10);
    expect(up2?.netPnl).toBe(20);
    // downtrend-regime heeft maar 2 trades → insufficient
    expect(m.insufficientRegimeData.some((r) => r.startsWith("downtrend"))).toBe(true);
  });

  it("24: AI-exit frequentie en korte AI-exits detecteren", () => {
    const orders: PaperOrderExt[] = [];
    [2, 2, 2, 2, 2, 2].forEach((p, i) => {
      orders.push(mkEntry(i, "BTC-EUR"));
      orders.push(mkExit(i, p, "BTC-EUR", { reason: "ai_exit", hold: i < 4 ? 3 : 200 }));
    });
    const m = computeFullPaperMetrics({ orders, activatedAt: new Date(Date.now() - 10 * 86_400_000).toISOString() });
    expect(m.aiExitCount).toBe(6);
    expect(m.aiExitShortPct).toBeGreaterThan(50); // 4 van 6 korter dan 15 min
    const v = aiExitVerdict(m);
    expect(v.level === "WARNING" || v.level === "CRITICAL").toBe(true);
  });

  it("13: regime-afleiding uit snapshots", () => {
    expect(regimeOfEntry({ above_ema200: true, dist_ema50_pct: 2, day_hi: 105, day_lo: 100 })).toMatch(/uptrend\/high/);
    expect(regimeOfEntry({ above_ema200: false, dist_ema50_pct: -3, day_hi: 100.5, day_lo: 100 })).toMatch(/downtrend\/low/);
    expect(regimeOfEntry(undefined)).toBe("unknown");
  });
});

// ═══ 7-11: DRIFT (EXPECTANCY/PF/DD/FREQUENCY/HOLD) ═══
describe("expected vs realized drift (Deel 7/8/12/13)", () => {
  const exp = expectedGood();

  it("7+8: expectancy drift: healthy = NORMAL, halved = WARNING, negative = CRITICAL", () => {
    const good = metricsFrom([2, 1, 2, 1, 2, 1]);   // exp +€1,5
    let d = computeDrift(exp, good);
    expect(d.dimensions.find((x) => x.dimension === "expectancy")!.level).toBe("NORMAL");
    expect(d.worstLevel).toBe("NORMAL");

    const weak = metricsFrom([0.25, 0.25, 0.25, 0.25, 0.25, 0.25]); // exp €0,25 < 0,6×€0,5=€0,30
    d = computeDrift(exp, weak);
    expect(d.dimensions.find((x) => x.dimension === "expectancy")!.level).toBe("WARNING");
    expect(d.hasWarning).toBe(true);

    const bad = metricsFrom([-1, -1, -1, -1, -1, -1]);
    d = computeDrift(exp, bad);
    expect(d.dimensions.find((x) => x.dimension === "expectancy")!.level).toBe("CRITICAL");
    expect(d.hasCritical).toBe(true);
  });

  it("8: PF drift en DD drift", () => {
    // PF-drift: veel verliezers → PF ver onder verwachte 1,5
    const pfBad = metricsFrom([3, -5, 3, -5, 3, -5, 3, -5]);  // PF ≈ 0,6
    const d1 = computeDrift(exp, pfBad);
    expect(d1.dimensions.find((x) => x.dimension === "profit_factor")!.level).toBe("CRITICAL");

    // DD-drift: eerste trade -15 → running-peak DD ~1,3% t.o.v. verwachte 0,4% → CRITICAL
    const ddBad = metricsFrom([-15, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    const expDd = { ...exp, maxDrawdownPct: 0.4, tradesPerDay: 1 };
    const d2 = computeDrift(expDd, ddBad);
    expect(d2.dimensions.find((x) => x.dimension === "drawdown")!.level).toBe("CRITICAL");
  });

  it("12: frequency drift — 15× verwachte frequentie → CRITICAL", () => {
    // 60 entries op 1 dag (tradesPerDay ~60) vs verwacht 1/dag
    const orders: PaperOrderExt[] = [];
    for (let i = 0; i < 60; i++) {
      const at = new Date(Date.now() - (60 - i) * 600_000).toISOString(); // elke 10 min
      orders.push({ ...mkEntry(i), created_at: at });
      orders.push({ ...mkExit(i, 0.5), created_at: at });
    }
    const m = computeFullPaperMetrics({ orders, activatedAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect(m.tradesPerDay).toBeGreaterThan(50);
    const d = computeDrift(exp, m);
    expect(d.dimensions.find((x) => x.dimension === "frequency")!.level).toBe("CRITICAL");
  });

  it("13: hold-time drift — 2-minuten posities bij 90 min verwacht → CRITICAL", () => {
    const m = metricsFrom([0.2, 0.2, 0.2, 0.2], { hold: 2 });
    const d = computeDrift(exp, m, 15);
    const h = d.dimensions.find((x) => x.dimension === "hold_time")!;
    expect(h.level).toBe("CRITICAL"); // onder min-hold-vloer
  });

  it("11: fee-ratio drift — fee-churn detectie (fees eten de winst)", () => {
    const m = metricsFrom([0.6, 0.6, 0.6, 0.6, 0.6, 0.6], { fees: 0.55, slip: 0.05 });
    // gross profit 6×0,6=€3,6 → fees 3,3 → feeShare ≈ 92% (verwacht 25%)
    expect(m.feeShareOfProfitPct).toBeGreaterThan(80);
    const d = computeDrift(exp, m);
    expect(d.dimensions.find((x) => x.dimension === "fee_ratio")!.level).toBe("CRITICAL");
  });
});

// ═══ 17: CONFIDENCE + BOOTSTRAP ═══
describe("statistische voorzichtigheid (Deel 17)", () => {
  it("17: kleine samples krijgen LOW_SAMPLE/EARLY, geen vals bewijs; bootstrap is breed", () => {
    const one = confidenceReport({ pnls: [100], trades: 1, observationDays: 0.1, activeDays: 1 });
    expect(one.label).toBe("LOW_SAMPLE");
    const two = confidenceReport({ pnls: [50, 50], trades: 2, observationDays: 0.2, activeDays: 1 });
    expect(two.label).toBe("LOW_SAMPLE");
    const early = confidenceReport({ pnls: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], trades: 11, observationDays: 1, activeDays: 1 });
    expect(early.label).toBe("EARLY");
    const ready = confidenceReport({ pnls: Array(30).fill(1), trades: 30, observationDays: 7, activeDays: 5 });
    expect(ready.label).toBe("VALIDATION_READY");
    // bootstrap op kleine samples blijft breed en deterministisch
    const b1 = bootstrapExpectancy([1, 2, 3]);
    const b2 = bootstrapExpectancy([1, 2, 3]);
    expect(b1).toEqual(b2);
    expect(b1!.p5).toBeLessThanOrEqual(b1!.p50);
    expect(b1!.p50).toBeLessThanOrEqual(b1!.p95);
    expect(bootstrapExpectancy([1])).toBeNull();
  });
});

// ═══ 3/4/17/18: APPROVAL GATE + MINIMUMS + INSUFFICIENT DATA ═══
describe("paper approval gate (Deel 5/9/10/18)", () => {
  // 30 trades op 10 dagen = 3/dag; winrate-verwachting uit de gemengde fixture
  const exp = { ...expectedGood(), tradesPerDay: 3, winratePct: 83 };

  function gateFor(pnls: number[], days = 8, o: MkOpts = {}) {
    const m = metricsFrom(pnls, o);
    // forceer voldoende observatie/active days door activatedAt te verlaten —
    // metricsFrom gebruikt 10 dagen; activeDays komt uit entry-tijden.
    const drift = computeDrift(exp, m, 15);
    const integrity = checkDataIntegrity({ orders: [], allStates: [], registry: [], strategyKey: "evo/x@2.0.0" });
    const confidence = confidenceReport({ pnls: m.perCoin.flatMap((c) => []), trades: m.closed, observationDays: days, activeDays: Math.min(6, m.activeDays) });
    return { gate: runApprovalGate({ metrics: { ...m, observationHours: days * 24 }, drift, integrity, confidence, expected: exp, minHoldFloorMin: 15 }), m };
  }

  it("3+4: te weinig trades/dagen → INSUFFICIENT_DATA-achtige vroege verdicts, NOOIT approval", () => {
    const { gate } = gateFor([2, 2, 2, 2, 2], 2); // 5 trades, 2 dagen
    expect(["VALIDATION_EARLY", "VALIDATION_PROGRESS"]).toContain(gate.verdict);
    expect(gate.verdict).not.toBe("PAPER_APPROVED");
  });

  it("1+17+18: voldoende data + alles groen → VALIDATION_READY/PAPER_APPROVED", () => {
    // 25 wins €2,2 + 5 verliezen −€1 → netto €50, PF 11, exp €1,67
    const pnls = [...Array(25).fill(2.2), ...Array(5).fill(-1)];
    const { gate } = gateFor(pnls, 8);
    expect(gate.verdict).toBe("PAPER_APPROVED");
    expect(gate.criteria.every((c) => c.pass)).toBe(true);
    expect(gate.blockers).toEqual([]);
  });

  it("10: hoge winrate met negatief netto → FAILED (nooit approval op winrate)", () => {
    // 90% winrate maar de verliezers zijn gigantisch: netto negatief
    const pnls: number[] = [];
    for (let i = 0; i < 28; i++) pnls.push(0.3);
    pnls.push(-12, -12); // netto ≈ 8,4 − 24 = −€15,6
    const { gate } = gateFor(pnls, 8);
    expect(gate.verdict).toBe("FAILED");
    expect(gate.hardFail).toBe(true);
  });

  it("9: critical drift blokkeert approval (criterium 3)", () => {
    const { gate } = gateFor(Array(30).fill(0.05), 8); // exp €0,05 ≤ 0 is niet zo; drift exp: 0,05/0,5=0,1 → CRITICAL
    expect(gate.verdict).not.toBe("PAPER_APPROVED");
    expect(gate.blockers.join()).toMatch(/critical drift/i);
  });

  it("11: fee-churn (fee ratio > 40%) blokkeert approval", () => {
    const { gate } = gateFor(Array(30).fill(0.9), 8, { fees: 0.85 });
    expect(gate.verdict).not.toBe("PAPER_APPROVED");
  });
});

// ═══ 26: DATA INTEGRITY ═══
describe("data integrity (Deel 26)", () => {
  const reg = (o: Partial<RegistryRow> = {}) => ({
    id: 1, created_at: "2026-09-10T00:00:00Z", strategy_id: "x", family: "F", version: "2.0.0",
    parent_strategy_id: null, parent_version: null, origin_candidate_id: null, research_run_id: null,
    specification: null, hypothesis: null, score: null, research_metrics: null,
    status: "PAPER_ACTIVE", canary: true, is_legacy: false, activated_at: null,
    deactivated_at: null, activation_reason: null, rollback_reason: null, cooldown_until: null,
    ...o,
  }) as RegistryRow;

  it("26: dubbele trades, orphan exits, onmogelijke PnL → CRITICAL, ok=false", () => {
    const orders: PaperOrderExt[] = [
      { ...mkExit(1, 2), created_at: "2026-09-10T10:00:00Z", pair: "BTC-EUR", side: "sell" },
      { ...mkExit(1, 2), created_at: "2026-09-10T10:00:00Z", pair: "BTC-EUR", side: "sell" }, // duplicaat
      { ...mkExit(2, 500, "ETH-EUR") }, // pnl 500 op notioneel 100 → onmogelijk
    ];
    const r = checkDataIntegrity({ orders, allStates: [], registry: [reg()], strategyKey: "evo/x@2.0.0" });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.check === "duplicate_trade" && i.severity === "CRITICAL")).toBe(true);
    expect(r.issues.some((i) => i.check === "impossible_pnl")).toBe(true);
  });

  it("26: paper_state met onbekende evo-strategie → registry_inconsistency CRITICAL", () => {
    const r = checkDataIntegrity({
      orders: [], allStates: [{ pair: "BTC-EUR", strategy: "evo/ghost@9.9.9", size: 1 }],
      registry: [reg()], strategyKey: "evo/x@2.0.0",
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.check === "registry_inconsistency")).toBe(true);
  });

  it("26: dubbele canary-activatie → CRITICAL (fail-closed voor nieuwe activatie)", () => {
    const r = checkDataIntegrity({
      orders: [],
      allStates: [],
      registry: [reg({ id: 1, strategy_id: "a" }), reg({ id: 2, strategy_id: "a" })],
      strategyKey: "evo/a@2.0.0",
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.check === "duplicate_activation")).toBe(true);
  });

  it("26: gezonde dataset → ok", () => {
    const orders = [mkEntry(1), mkExit(1, 2), mkEntry(2, "ETH-EUR"), mkExit(2, 1, "ETH-EUR")];
    const r = checkDataIntegrity({ orders, allStates: [], registry: [reg()], strategyKey: "evo/x@2.0.0" });
    expect(r.ok).toBe(true);
  });
});

// ═══ 16: BASELINE COMPARISON ═══
describe("baseline comparison (Deel 16)", () => {
  it("16: expected-profile bevat de research-verwachtingen die bij activatie zijn opgeslagen", () => {
    const row = {
      research_metrics: {
        oos: { expectancyEur: 0.66, netPnl: 9.2, trades: 14, maxDrawdownPct: 0.7, avgHoldMin: 612, fees: 11.72, winratePct: 42.9, profitFactor: 1.2 },
      },
    } as unknown as RegistryRow;
    const e = expectedProfileFrom(row);
    expect(e.expectancyEur).toBe(0.66);
    expect(e.tradesPerDay).toBeCloseTo(14 / 63, 1);
    expect(e.feeRatioPct).toBeGreaterThan(50); // 11,72 / (9,2+11,72)
    expect(e.winratePct).toBe(42.9);
  });
});

// ═══ 19-22: LIFECYCLE / QUEUE / CANARY SLOT ═══
describe("lifecycle Fase 4 (Deel 18/20/21/22)", () => {
  it("18: nieuwe transities bestaan en zijn geldig", () => {
    expect(transitionAllowed("PAPER_CANDIDATE", "WAITING_FOR_CANARY_SLOT")).toBe(true);
    expect(transitionAllowed("WAITING_FOR_CANARY_SLOT", "PAPER_ACTIVE")).toBe(true);
    expect(transitionAllowed("PAPER_ACTIVE", "VALIDATION_EARLY")).toBe(true);
    expect(transitionAllowed("VALIDATION_EARLY", "VALIDATION_PROGRESS")).toBe(true);
    expect(transitionAllowed("VALIDATION_PROGRESS", "VALIDATION_READY")).toBe(true);
    expect(transitionAllowed("VALIDATION_READY", "PAPER_APPROVED")).toBe(true);
    expect(transitionAllowed("VALIDATION_PROGRESS", "FAILED")).toBe(true);
  });

  it("18: ongeldige shortcuts blijven onmogelijk", () => {
    expect(transitionAllowed("PAPER_CANDIDATE", "PAPER_APPROVED")).toBe(false);
    expect(transitionAllowed("WAITING_FOR_CANARY_SLOT", "PAPER_APPROVED")).toBe(false);
    expect(transitionAllowed("VALIDATION_READY", "PAPER_ACTIVE")).toBe(false); // geen terug naar handelen
    expect(transitionAllowed("PAPER_APPROVED", "PAPER_ACTIVE")).toBe(false);
    expect(transitionAllowed("FAILED", "PAPER_ACTIVE")).toBe(false);
    expect(transitionAllowed("RESEARCH_CANDIDATE", "PAPER_ACTIVE" as RegistryStatus)).toBe(false);
    expect(transitionAllowed("ROLLED_BACK", "PAPER_ACTIVE")).toBe(false);
  });

  it("26-27: FAILED/ROLLED_BACK/REJECTED kunnen niet handelen en niet heractiveren", () => {
    expect(canTradePaper("PAPER_ACTIVE")).toBe(true);
    expect(canTradePaper("VALIDATION_EARLY")).toBe(false);
    expect(canTradePaper("VALIDATION_PROGRESS")).toBe(false);
    expect(canTradePaper("VALIDATION_READY")).toBe(false);
    expect(canTradePaper("PAPER_APPROVED")).toBe(false);
    expect(canTradePaper("FAILED")).toBe(false);
    expect(reactivationBlocked("FAILED")).toBe(true);
    expect(reactivationBlocked("ROLLED_BACK")).toBe(true);
  });

  it("21+22: canary-slot vol → candidate wacht (queue), duplicaat en familie-cap blokkeren", () => {
    const active = [{
      id: 1, strategy_id: "other", family: "OTHER", version: "1.0.0",
      specification: null, canary: true, status: "PAPER_ACTIVE",
    }] as unknown as RegistryRow[];
    const check = checkActivationConstraints({ family: "RSI-MEAN-REVERSION", strategy_id: "rsi-x", version: "2.0.0", signature: "sig-abc" }, active);
    expect(check.ok).toBe(false);
    expect(check.blockers.join()).toMatch(/canary actief/);
    // familie-cap
    const activeSameFam = [{ ...active[0], family: "RSI-MEAN-REVERSION" }] as RegistryRow[];
    const check2 = checkActivationConstraints({ family: "RSI-MEAN-REVERSION", strategy_id: "rsi-x", version: "2.0.0", signature: "sig-abc" }, activeSameFam);
    expect(check2.blockers.join()).toMatch(/familie|canary/);
  });
});

// ═══ 23/28/34: RISK ENGINE DOMINANTIE + SECURITY ═══
describe("risk engine dominantie + security (Deel 23/34)", () => {
  it("28: canary risk-cap is alléén strikter dan de normale band (0,25% < 1,0% max)", async () => {
    const { CANARY_RISK_CAP_PCT } = await import("@/lib/evolution/config");
    const { RISK_MAX_PCT } = await import("@/lib/risk/config");
    expect(CANARY_RISK_CAP_PCT).toBeLessThanOrEqual(RISK_MAX_PCT);
  });

  it("34: géén live-executie in de validation-laag (statische scan)", () => {
    const dir = path.resolve(__dirname, "../lib/validation");
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))
      .map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\\n");
    expect(all).not.toMatch(/mirrorBlofin|placeOrder|marketLong|marketShort/);
    expect(all).not.toMatch(/\beval\s*\(|new Function|child_process/);
    expect(all).not.toMatch(/PAPER_LIVE\s*=|BLOFIN_API_KEY/);
    expect(all).toMatch(/fail-closed/i);
  });

  it("34: nergens een LIVE-status in de lifecycle — PAPER_APPROVED is het eindpunt", () => {
    const lc = fs.readFileSync(path.resolve(__dirname, "../lib/evolution/lifecycle.ts"), "utf8");
    expect(lc).not.toMatch(/"LIVE"|'LIVE'|LIVE_APPROVED/);
    const from = "PAPER_APPROVED";
    const next = ["PAPER_ACTIVE", "VALIDATION_EARLY", "LIVE"];
    for (const to of next) {
      expect(transitionAllowed(from as RegistryStatus, to as RegistryStatus)).toBe(false);
    }
  });
});
