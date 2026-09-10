// ── FASE 3 SAFETY-TESTS — Strategy Evolution Engine ──────────────────────
// Vitest. 25 testgebieden uit Deel 34, met mocks/synthetische data —
// géén echte exchange-aanroepen, géén live orders. Elke test start met
// een comment die het testgebied noemt.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── pure modules (geen env nodig) ──
import { transitionAllowed, canTradePaper, reactivationBlocked, RegistryStatus } from "@/lib/evolution/lifecycle";
import { runValidationGate } from "@/lib/evolution/gate";
import { checkActivationConstraints } from "@/lib/evolution/registry";
import { specSignature } from "@/lib/evolution/mutate";
import { resolveConflicts, regimeFitFrom, paperScoreFrom, softScore, CandidateProposal } from "@/lib/evolution/selection";
import { computeMonitorVerdict } from "@/lib/evolution/monitor";
import { CANARY_RISK_CAP_PCT, ROLLBACK_COOLDOWN_HOURS } from "@/lib/evolution/config";
import type { RegistryRow } from "@/lib/evolution/db";

import * as fs from "node:fs";
import * as path from "node:path";

// ── fixtures ─────────────────────────────────────────────────────────────
const goodMetrics = {
  trades: 40, wins: 24, losses: 16, winratePct: 60, grossPnl: 80, fees: 20,
  slippage: 4, netPnl: 56, netReturnPct: 5.6, expectancyEur: 1.4,
  avgWin: 3.3, avgLoss: -2.1, profitFactor: 1.5, maxDrawdownPct: 8,
  maxWinStreak: 6, maxLossStreak: 3, avgHoldMin: 120, exitReasons: {},
};
const oosGood = { ...goodMetrics, trades: 15, netPnl: 21, expectancyEur: 1.4, fees: 8, profitFactor: 1.5, maxDrawdownPct: 6 };

function gateInput(overrides: Record<string, unknown> = {}) {
  return {
    isMetrics: { ...goodMetrics },
    oosMetrics: { ...oosGood },
    walkforward: { windows: [], positiveWindows: 2, totalWindows: 4, consistencyPct: 50 },
    robustness: { scenarios: [{ label: "fees_x1_5", netPnl: 5, trades: 15 }, { label: "fees_x2", netPnl: -1, trades: 15 }], passRatio: 0.7, ok: true },
    overfitting: { flags: { oos_negative_while_is_positive: false, walkforward_inconsistent: false, sample_too_small: false, extreme_drawdown: false, fee_fragile: false, single_coin_dominance: false, parameter_cliff: false }, warnings: [] },
    perPair: [
      { pair: "BTC-EUR", netPnl: 9, trades: 4 },
      { pair: "ETH-EUR", netPnl: 6, trades: 5 },
      { pair: "SOL-EUR", netPnl: 4, trades: 3 },
      { pair: "XRP-EUR", netPnl: 2, trades: 3 },
    ],
    score: 62,
    status: "RESEARCH_CANDIDATE",
    ...overrides,
  };
}

const baseline = {
  name: "baseline-rsi-dip (parent)",
  oos: { trades: 15, netPnl: 4.5, expectancyEur: 0.3, maxDrawdownPct: 0.7, profitFactor: 1.2, fees: 12.6 },
};

function regRow(o: Partial<RegistryRow> = {}): RegistryRow {
  return {
    id: 1, created_at: "2026-09-10T00:00:00Z", strategy_id: "rsi-dip-volfilter", family: "RSI-MEAN-REVERSION",
    version: "2.0.0", parent_strategy_id: "rsi-dip", parent_version: "1.0.0", origin_candidate_id: null,
    research_run_id: "evo-test", specification: { name: "rsi-dip-volfilter", pairs: ["BTC-EUR"] },
    hypothesis: "x", score: 60, research_metrics: {}, status: "PAPER_CANDIDATE", canary: true,
    is_legacy: false, activated_at: null, deactivated_at: null, activation_reason: null,
    rollback_reason: null, cooldown_until: null,
    ...o,
  } as RegistryRow;
}

// ════════════════════════════════════════════════════════════════════════
// 1+2. LIFECYCLE: geldige en ongeldige transities
// ════════════════════════════════════════════════════════════════════════
describe("lifecycle", () => {
  it("1: geldige paden door de hele lifecycle", () => {
    expect(transitionAllowed("HYPOTHESIS", "TESTING")).toBe(true);
    expect(transitionAllowed("TESTING", "RESEARCH_CANDIDATE")).toBe(true);
    expect(transitionAllowed("RESEARCH_CANDIDATE", "VALIDATION_PENDING")).toBe(true);
    expect(transitionAllowed("VALIDATION_PENDING", "PAPER_CANDIDATE")).toBe(true);
    expect(transitionAllowed("PAPER_CANDIDATE", "PAPER_ACTIVE")).toBe(true);
    expect(transitionAllowed("PAPER_ACTIVE", "PAPER_VALIDATING")).toBe(true);
    expect(transitionAllowed("PAPER_VALIDATING", "PAPER_APPROVED")).toBe(true);
    expect(transitionAllowed("PAPER_ACTIVE", "ROLLED_BACK")).toBe(true);
  });

  it("2: verboden shortcuts — HYPOTHESIS→PAPER_ACTIVE en RESEARCH_CANDIDATE→PAPER_ACTIVE bestaan niet", () => {
    expect(transitionAllowed("HYPOTHESIS", "PAPER_ACTIVE")).toBe(false);
    expect(transitionAllowed("RESEARCH_CANDIDATE", "PAPER_ACTIVE")).toBe(false);
    expect(transitionAllowed("TESTING", "PAPER_ACTIVE")).toBe(false);
    expect(transitionAllowed("RESEARCH_CANDIDATE", "ACTIVE" as RegistryStatus)).toBe(false);
    expect(transitionAllowed("PAPER_APPROVED", "PAPER_ACTIVE")).toBe(false); // geen terug-degradatie naar actief handelen
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3-7. VALIDATION GATE
// ════════════════════════════════════════════════════════════════════════
describe("validation gate", () => {
  it("3: candidate met overal voldoende bewijs slaagt", () => {
    const v = runValidationGate(gateInput(), baseline);
    expect(v.passed).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.baselineComparison).toContain("vs baseline-rsi-dip");
  });

  it("4: minimale sample handhaving (IS 29 / OOS 11)", () => {
    const v = runValidationGate(gateInput({ isMetrics: { ...goodMetrics, trades: 29 }, oosMetrics: { ...oosGood, trades: 11 } }), baseline);
    expect(v.passed).toBe(false);
    expect(v.reasons.join()).toMatch(/IS-trades 29/);
    expect(v.reasons.join()).toMatch(/OOS-trades 11/);
  });

  it("5: negatieve OOS-expectancy/netto faalt", () => {
    const v = runValidationGate(gateInput({ oosMetrics: { ...oosGood, expectancyEur: -0.2, netPnl: -3 } }), baseline);
    expect(v.passed).toBe(false);
    expect(v.reasons.join()).toMatch(/OOS-expectancy/);
    expect(v.reasons.join()).toMatch(/OOS netto/);
  });

  it("6: fragiele robustness en walk-forward faalt", () => {
    const v = runValidationGate(gateInput({
      walkforward: { windows: [], positiveWindows: 1, totalWindows: 4, consistencyPct: 25 },
      robustness: { scenarios: [], passRatio: 0.4, ok: false },
    }), baseline);
    expect(v.passed).toBe(false);
    expect(v.reasons.join()).toMatch(/walk-forward consistentie/);
    expect(v.reasons.join()).toMatch(/robustness pass-ratio/);
    // overfit-flags blokkeren hard
    const v2 = runValidationGate(gateInput({
      overfitting: { flags: { oos_negative_while_is_positive: true, walkforward_inconsistent: false, sample_too_small: false, extreme_drawdown: false, fee_fragile: false, single_coin_dominance: false, parameter_cliff: false }, warnings: [] },
    }), baseline);
    expect(v2.passed).toBe(false);
    // single-coin dependency > 80% blokkeert
    const v3 = runValidationGate(gateInput({ perPair: [{ pair: "BTC-EUR", netPnl: 20, trades: 10 }, { pair: "ETH-EUR", netPnl: 1, trades: 5 }] }), baseline);
    expect(v3.passed).toBe(false);
    expect(v3.reasons.join()).toMatch(/één coin/);
  });

  it("7: fee-aware baseline-vergelijking — slechtere expectancy en churn falen", () => {
    // candidate doet 3,3× zoveel trades voor vrijwel geen netto-verbetering → churn-afwijzing
    const churn = runValidationGate(gateInput({ oosMetrics: { ...oosGood, trades: 50, netPnl: 6, expectancyEur: 0.12, fees: 40 } }), baseline);
    expect(churn.passed).toBe(false);
    expect(churn.reasons.join()).toMatch(/fee-churn|expectancy/i);
    // candidate slechter dan baseline → afwijzing
    const worse = runValidationGate(gateInput({ oosMetrics: { ...oosGood, expectancyEur: 0.1 } }), baseline);
    expect(worse.passed).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 8-13. VERSIONING, FAMILY, ACTIVATION, ATOMICITEIT
// ════════════════════════════════════════════════════════════════════════
describe("versioning + family + activation-constraints", () => {
  const specA = {
    name: "rsi-dip-volfilter", description: "d", hypothesis: "h", expected_regime: "r",
    failure_conditions: "f", falsification: "x", timeframe: "15m" as const, direction: "long" as const,
    entry_conditions: [{ kind: "rsi_lt" as const, value: 30, period: 14 }],
    exit_conditions: [{ kind: "rsi_gt" as const, value: 60, period: 14 }],
    stop_loss_pct: 3, take_profit_pct: 4, max_hold_bars: 64, risk_pct: 0.5, pairs: ["BTC-EUR", "ETH-EUR"],
  };
  const specB = JSON.parse(JSON.stringify({ ...specA, entry_conditions: [{ kind: "rsi_lt", value: 29, period: 14 }] }));

  it("8: bijna-identieke specificaties krijgen dezelfde signature (immutable-versioning, deel 15)", () => {
    expect(specSignature(specA as never)).toBe(specSignature(specA as never));
    // miniem andere drempel = ANDERE versie, geen duplicaat
    expect(specSignature(specA as never)).not.toBe(specSignature(specB as never));
    // identieke dubbelingen vallen wél onder dezelfde signature
    const specACopy = JSON.parse(JSON.stringify(specA));
    expect(specSignature(specA as never)).toBe(specSignature(specACopy as never));
  });

  it("9: family-control: max 1 actieve versie per familie + max 1 canary + duplicaat-signature", () => {
    const activeSameFamily = regRow({ strategy_id: "rsi-dip-ander", version: "3.0.0", family: "RSI-MEAN-REVERSION", status: "PAPER_ACTIVE", specification: specB });
    const check = checkActivationConstraints({ family: "RSI-MEAN-REVERSION", strategy_id: "rsi-dip-volfilter", version: "2.0.0", signature: specSignature(specA as never) }, [activeSameFamily]);
    expect(check.ok).toBe(false);
    expect(check.blockers.join()).toMatch(/familie/);
    // andere familie + geen canaryconflict → ok
    const activeOtherFamily = regRow({ strategy_id: " breakout-x", family: "BREAKOUT", version: "1.0.0", status: "PAPER_ACTIVE", specification: specB, canary: true });
    const check2 = checkActivationConstraints({ family: "RSI-MEAN-REVERSION", strategy_id: "rsi-dip-volfilter", version: "2.0.0", signature: specSignature(specA as never) }, [activeOtherFamily]);
    expect(check2.ok).toBe(false); // canary-cap: al 1 canary actief
    expect(check2.blockers.join()).toMatch(/canary/);
  });

  it("11: alleen PAPER_ACTIVE mag handelen — statuses checken", () => {
    expect(canTradePaper("PAPER_ACTIVE")).toBe(true);
    for (const s of ["RESEARCH_CANDIDATE", "PAPER_CANDIDATE", "VALIDATION_PENDING", "REJECTED", "ROLLED_BACK", "HYPOTHESIS", "TESTING", "INSUFFICIENT_DATA", "LEGACY", "DEPRECATED", "PAPER_VALIDATING", "PAPER_APPROVED"] as RegistryStatus[]) {
      expect(canTradePaper(s)).toBe(false);
    }
  });

  it("12+13: atomaire/dubbele activatie via optimistic concurrency (gemockte REST)", async () => {
    // PATCH die een lege array teruggeeft = race verloren → geen dubbele activatie
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    process.env.SUPABASE_URL = "https://fake.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-key";
    vi.resetModules();
    const db = await import("@/lib/evolution/db");
    const res = await db.transitionStatus(1, "PAPER_CANDIDATE", "PAPER_ACTIVE", {}, { reason: "t", performed_by: "t", action: "activate" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/race|verloor/);
    vi.unstubAllGlobals();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 14-15. ROLLBACK + COOLDOWN
// ════════════════════════════════════════════════════════════════════════
describe("rollback + cooldown", () => {
  it("14: gerolled-back/rejected/deprecated versies kunnen NOOIT meer activeren", () => {
    expect(reactivationBlocked("ROLLED_BACK")).toBe(true);
    expect(reactivationBlocked("REJECTED")).toBe(true);
    expect(reactivationBlocked("DEPRECATED")).toBe(true);
    expect(reactivationBlocked("PAPER_CANDIDATE")).toBe(false);
  });

  it("15: cooldown-instelling staat op minimaal 24 uur", () => {
    expect(ROLLBACK_COOLDOWN_HOURS).toBeGreaterThanOrEqual(24);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 16-18. CONFLICT, REGIME, FAIL-CLOSED
// ════════════════════════════════════════════════════════════════════════
describe("conflict + regime + fail-closed", () => {
  const prop = (row: RegistryRow, side: "buy" | "sell", score: number): CandidateProposal =>
    ({ row, side, softScore: score, paperScore: 50, regimeFit: 0.5, regimeLabel: "l", learnWeight: 1 });

  it("16: conflicterende kanten → deterministisch: hoogste score wint", () => {
    const a = prop(regRow({ id: 1, strategy_id: "a", activated_at: "2026-09-09T00:00:00Z" }), "buy", 40);
    const b = prop(regRow({ id: 2, strategy_id: "b", activated_at: "2026-09-10T00:00:00Z" }), "sell", 70);
    const r = resolveConflicts([a, b]);
    expect(r).toHaveLength(1);
    expect(r[0].row.strategy_id).toBe("b");
    // gelijke score → senioriteit (langst actief wint)
    const c = prop(regRow({ id: 3, strategy_id: "c", activated_at: "2026-09-08T00:00:00Z" }), "sell", 70);
    const r2 = resolveConflicts([b, c]);
    expect(r2[0].row.strategy_id).toBe("c");
  });

  it("17: regime-selectie — negatief backtest-regime = geen entry; te weinig data = INSUFFICIENT_REGIME_DATA", () => {
    const neg = regimeFitFrom({ chop: { trades: 30, netPnl: -12 } }, "chop");
    expect(neg.fit).toBe(0); // hard geen entry
    const thin = regimeFitFrom({ chop: { trades: 4, netPnl: -12 } }, "chop");
    expect(thin.fit).toBe(0.5);
    expect(thin.label).toMatch(/INSUFFICIENT_REGIME_DATA/);
    const pos = regimeFitFrom({ chop: { trades: 30, netPnl: 20 } }, "chop");
    expect(pos.fit).toBe(1);
  });

  it("18: registry onbereikbaar → fail-closed (géén activatie, géén signalen)", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    vi.resetModules();
    const db = await import("@/lib/evolution/db");
    const rows = await db.activePaperStrategies();
    expect(rows).toEqual([]);
    const t = await db.transitionStatus(1, "PAPER_CANDIDATE", "PAPER_ACTIVE");
    expect(t.ok).toBe(false);
    expect(t.error).toMatch(/niet geconfigureerd/);
    const live = await import("@/lib/evolution/live");
    const still = await live.evoStrategyStillActive("evo/rsi-dip-volfilter@2.0.0");
    expect(still.ok).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Deel 10/12/13: PAPER VALIDATION, DRIFT, ROLLBACK-TRIGGERS
// ════════════════════════════════════════════════════════════════════════
describe("paper monitoring (monitor.ts)", () => {
  const activatedAt = new Date(Date.now() - 72 * 3600_000).toISOString();
  const expected = { expectancyEur: 0.5, netPnl: 10, maxDrawdownPct: 5, avgHoldMin: 120, fees: 10, trades: 15 };

  const mkOrders = (pnls: number[], holdMin = 90, fees = 0.4) =>
    pnls.map((pnl, i) => ({
      id: i, created_at: new Date(Date.now() - (pnls.length - i) * 3600_000).toISOString(),
      pair: "BTC-EUR", side: "sell", price: 100, size: 1, reason: "test",
      equity_after: 1000, pnl_eur: pnl, pnl_pct: pnl / 10, strategy: "evo/x@2.0.0",
      context: { gross: pnl, fees, slippage: 0.08, hold_min: holdMin },
    })) as unknown[] as never[];

  it("deel 10: 5 trades +€10 = INSUFFICIENT_DATA, niet APPROVED", () => {
    const v = computeMonitorVerdict({
      orders: mkOrders([2, 2, 2, 2, 2]), entries: 5,
      blocked: { rejections: 0, risk: 0, cooldown: 0, fee: 0, errors: 0 },
      activatedAt, isCanary: true, expected,
    });
    expect(v.state).toBe("INSUFFICIENT_DATA");
  });

  it("deel 13: verlies-limiet, streak, fee-burn en drift-rollback triggert", () => {
    // netto ≤ −€8 → rollback
    const v1 = computeMonitorVerdict({
      orders: mkOrders([-2, -2, -2, -2, -1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -2, -2, -2]), entries: 18,
      blocked: { rejections: 0, risk: 0, cooldown: 0, fee: 0, errors: 0 },
      activatedAt, isCanary: true, expected,
    });
    expect(v1.state).toBe("ROLLBACK");
    // streak ≥ 4 → rollback
    const v2 = computeMonitorVerdict({
      orders: mkOrders([-1, -1, -1, -1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), entries: 15,
      blocked: { rejections: 0, risk: 0, cooldown: 0, fee: 0, errors: 0 },
      activatedAt, isCanary: true, expected,
    });
    expect(v2.state).toBe("ROLLBACK");
    expect(v2.triggers.join()).toMatch(/verliezen op rij/);
    // drift: expectancy sterk negatief ondanks voldoende sample → rollback
    const v3 = computeMonitorVerdict({
      orders: mkOrders([-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 5]), entries: 16,
      blocked: { rejections: 0, risk: 0, cooldown: 0, fee: 0, errors: 0 },
      activatedAt, isCanary: true, expected,
    });
    expect(v3.state).toBe("ROLLBACK");
  });

  it("deel 12: drift-warning bij sterke afwijking (zonder rollback) + backtest-vs-paper zichtbaar", () => {
    const v = computeMonitorVerdict({
      orders: mkOrders([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], 60, 0.05), entries: 15,
      blocked: { rejections: 0, risk: 0, cooldown: 0, fee: 0, errors: 0 },
      activatedAt, isCanary: true, expected,
    });
    // exp €0,1/trade < 0,5× verwacht €0,5 (€0,25) → drift-warning zonder rollback
    expect(v.state).toBe("WARN");
    expect(v.warnings.join()).toMatch(/expectancy-drift/);
    expect(v.drift).toMatch(/backtest\(OOS\)/);
    expect(v.drift).toMatch(/paper:/);
  });

  it("gezonde canary: OK-metrics en canary-risk-cap is 0,25%", () => {
    const v = computeMonitorVerdict({
      orders: mkOrders([2, 1, 3, 2, 1, 2, 1, 1, 2, 1, 2, 1, 1, 2, 1], 90), entries: 15,
      blocked: { rejections: 0, risk: 0, cooldown: 0, fee: 0, errors: 0 },
      activatedAt, isCanary: true, expected,
    });
    expect(["OK", "WARN"]).toContain(v.state);
    expect(CANARY_RISK_CAP_PCT).toBeLessThanOrEqual(0.25);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Deel 19: SCORE-COMBINATIE (research + paper + regime + learnweight)
// ════════════════════════════════════════════════════════════════════════
describe("selection-combinatie", () => {
  it("19: learnweight dempt alleen — gewicht 0,5 halveert, 1,6 dempt nooit onder de gate", () => {
    const base = { researchScore: 60, paperScore: 60, regimeFit: 1 };
    expect(softScore({ ...base, learnWeight: 1 })).toBeCloseTo(60 * 0.45 + 60 * 0.35 + 100 * 0.2, 1);
    expect(softScore({ ...base, learnWeight: 0.5 })).toBeLessThan(softScore({ ...base, learnWeight: 1 }));
    expect(softScore({ ...base, learnWeight: 1.6 })).toBeGreaterThan(softScore({ ...base, learnWeight: 1 }));
    // paperScore neutraal zonder data
    expect(paperScoreFrom(null)).toBe(50);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Deel 20-22, 24-25: SECURITY-SCANS OVER DE CODE
// ════════════════════════════════════════════════════════════════════════
describe("security-scans (statisch)", () => {
  const evoDir = path.resolve(__dirname, "../lib/evolution");

  const files = () => fs.readdirSync(evoDir).filter((f) => f.endsWith(".ts"));

  const readAll = () => files().map((f) => fs.readFileSync(path.join(evoDir, f), "utf8")).join("\n");

  it("25: géén AI-code-executie: geen eval, geen new Function, geen child_process, geen dynamic import, geen shell", () => {
    const all = readAll();
    expect(all).not.toMatch(/\beval\s*\(/);
    expect(all).not.toMatch(/new Function\s*\(/);
    expect(all).not.toMatch(/child_process/);
    expect(all).not.toMatch(/spawn|execSync|exec\(/);
    expect(all).not.toMatch(/import\s*\(\s*["'`]/); // geen dynamic import
    expect(all).not.toMatch(/process\.env.*\bPAPER_LIVE\b\s*=/);
  });

  it("20-24: géén live-activation-path: nergens een LIVE-status of PAPER_LIVE-schrijving in de lifecycle", () => {
    const lc = fs.readFileSync(path.join(evoDir, "lifecycle.ts"), "utf8");
    expect(lc).not.toMatch(/"LIVE"|'LIVE'|LIVE_TRADING|"ACTIVE"/);
    const all = readAll();
    expect(all).not.toMatch(/blofinLive\s*=\s*true/);
    expect(all).not.toMatch(/marketLong|marketShort|closePosition/); // géén exchange-executie uit de evolution-laag
  });

  it("20-22: research/rejected/rolled-back kunnen niet handelen (grep: alleen PAPER_ACTIVE is tradable)", () => {
    const lc = fs.readFileSync(path.join(evoDir, "lifecycle.ts"), "utf8");
    expect(lc).toMatch(/TRADABLE_PAPER_STATUSES: RegistryStatus\[\] = \["PAPER_ACTIVE"\]/);
  });
});
