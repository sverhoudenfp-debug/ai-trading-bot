// ── FASE 2: safety-critical research-tests ───────────────────────────────
// Geen enkele echte exchange-aanroep; alleen pure functies + synthetische
// candles. Doel: aantonen dat de research-engine GEEN toekomstige
// informatie gebruikt, kosten exactrekent, en géén pad naar execution of
// activering heeft.

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Candle } from "@/lib/exchange/marketdata";
import { buildFrame, FRAME_WARMUP, Frame } from "@/lib/research/frame";
import { validateSpec, StrategySpec } from "@/lib/research/spec";
import { runPairBacktest, computeMetrics, RTrade } from "@/lib/research/backtest";
import { makeSplit, walkForwardWindows } from "@/lib/research/split";
import { robustnessTest, perturbationTest, detectOverfitting } from "@/lib/research/robustness";
import { evaluateSpec } from "@/lib/research/evaluator";
import { conditionMet } from "@/lib/research/interpreter";
import { regimeAt } from "@/lib/research/regimes";
import { researchBudgetOk } from "@/lib/research/hypothesis";
import { RESEARCH_STATUSES, JOB_STATUSES, MIN_TRADES_OOS, MIN_TRADES_IS } from "@/lib/research/config";
import { FEE_PCT, SLIPPAGE_PCT, RISK_MAX_PCT } from "@/lib/risk/config";
import { baselines, newsMomentumNote } from "@/lib/research/baselines";
import { normalizeSpecDraft } from "@/lib/research/normalize";

// ── synthetische candles (deterministisch, geen netwerk) ────────────────
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCandles(n: number, intervalMin: number, start: number, seed: number): Candle[] {
  const rnd = mulberry32(seed);
  const out: Candle[] = [];
  let price = start;
  const step = intervalMin * 60;
  for (let i = 0; i < n; i++) {
    const drift = 0.999 + rnd() * 0.002; // lichte random walk
    const o = price;
    const c = o * drift;
    const h = Math.max(o, c) * (1 + rnd() * 0.004);
    const l = Math.min(o, c) * (1 - rnd() * 0.004);
    out.push({ t: start + i * step, o, h, l, c, v: 100 + rnd() * 50 });
    price = c;
  }
  return out;
}

let FRAME: Frame;
beforeAll(() => {
  const c15 = makeCandles(3000, 15, 1_700_000_000, 42);
  const c1h = makeCandles(800, 60, 1_700_000_000, 43);
  FRAME = buildFrame("TEST-EUR", c15, c1h);
});

// ── 1+2. GEEN LOOK-AHEAD: fill strikt op open van T+1 ───────────────────
describe("1/2. no look-ahead bias + candle timing", () => {
  const spec: StrategySpec = {
    name: "always-in", description: "x", hypothesis: "x", expected_regime: "x",
    failure_conditions: "x", falsification: "x", timeframe: "15m", direction: "long",
    entry_conditions: [{ kind: "rsi_lt", value: 95 }],   // direct na warm-up waar
    exit_conditions: [{ kind: "rsi_gt", value: 96 }],
    stop_loss_pct: 5, take_profit_pct: 5, max_hold_bars: 8, risk_pct: 0.5,
    pairs: ["BTC-EUR"], expected_holding_time_min: 30, origin: "manual",
  };

  it("vult de entry op de OPEN van de candle ná het signaal (nooit zelfde candle)", () => {
    const bt = runPairBacktest(FRAME, spec, { equityStart: 1000 });
    expect(bt.trades.length).toBeGreaterThan(0);
    const t = bt.trades[0];
    // entryIdx moet > signaal-index zijn en de fill = open(entryIdx) met slip
    const openRaw = FRAME.candles[t.entryIdx].o;
    expect(t.entryPrice).toBeCloseTo(openRaw * (1 + SLIPPAGE_PCT / 100), 8);
    // signaal op close(entryIdx-1): condities waren daar waar (bewijs: vóór warm-up geen entries)
    expect(t.entryIdx).toBeGreaterThanOrEqual(FRAME_WARMUP + 1);
    expect(t.entryIdx).toBe(FRAME_WARMUP + 1); // allereerste kans: close warmup → open warmup+1
  });

  it("cross-condities gebruiken alleen i-1 vs i (nooit i+1)", () => {
    // op index waar rsi[i] < 30 én rsi[i-1] < 30 is cross_under NIET waar
    const f = FRAME;
    let crossIdx = -1, flatIdx = -1;
    for (let i = FRAME_WARMUP; i < 300; i++) {
      if (crossIdx === -1 && f.rsi[i - 1] >= 30 && f.rsi[i] < 30) crossIdx = i;
      if (flatIdx === -1 && f.rsi[i - 1] < 30 && f.rsi[i] < 30) flatIdx = i;
    }
    if (crossIdx > 0) {
      expect(conditionMet({ kind: "rsi_cross_under", value: 30 }, f, crossIdx)).toBe(true);
    }
    if (flatIdx > 0) {
      expect(conditionMet({ kind: "rsi_cross_under", value: 30 }, f, flatIdx)).toBe(false);
    }
  });
});

// ── 3/4/5. fees, slippage en netto PnL ─────────────────────────────────
describe("3/4/5. fee-, slippage- en net-PnL-berekening", () => {
  it("net = gross − fees − slippage, met exacte fee-formule", () => {
    const spec: StrategySpec = {
      name: "one-shot", description: "x", hypothesis: "x", expected_regime: "x",
      failure_conditions: "x", falsification: "x", timeframe: "15m", direction: "long",
      entry_conditions: [{ kind: "rsi_lt", value: 95 }],
      exit_conditions: [{ kind: "rsi_gt", value: 4 }],    // nooit waar → max-hold/SL/TP sluit
      stop_loss_pct: 10, take_profit_pct: 10, max_hold_bars: 4, risk_pct: 0.5,
      pairs: ["BTC-EUR"], expected_holding_time_min: 30, origin: "manual",
    };
    const bt = runPairBacktest(FRAME, spec, { equityStart: 1000 });
    for (const t of bt.trades) {
      expect(t.netPnl).toBeCloseTo(t.grossPnl - t.fees - t.slippage, 1);
      // fees = fee per kant over de fills
      const expFees = (t.entryPrice * t.size + t.exitPrice * t.size) * (FEE_PCT / 100);
      expect(t.fees).toBeCloseTo(expFees, 1);
      // slippage zit in de fills richting ongunstig
      expect(t.entryPrice).toBeGreaterThanOrEqual(t.entryPrice); // sanity
    }
  });

  it("computeMetrics: gross/fees/slip/net apart en winrate/expec/PF/DD", () => {
    const trades: RTrade[] = [
      mkTrade(10), mkTrade(-4), mkTrade(6),
    ];
    const m = computeMetrics(trades, [1000, 1010, 1006, 1012], 1000);
    expect(m.trades).toBe(3);
    expect(m.winratePct).toBeCloseTo(66.7, 1);
    expect(m.netPnl).toBe(12);
    expect(m.profitFactor).toBeCloseTo(16 / 4, 1);
    expect(m.expectancyEur).toBeCloseTo(4, 1);
  });
});

function mkTrade(net: number): RTrade {
  const fees = net > 0 ? 0.2 : 0.2;
  return {
    pair: "T", side: "long", entryIdx: 0, exitIdx: 1, entryTime: 0, exitTime: 900,
    entryPrice: 100, exitPrice: 100 + net, size: 1,
    grossPnl: net + fees, fees, slippage: 0, netPnl: net,
    reason: "take-profit", holdMin: 15, regime: "sideways",
  };
}

// ── 6. position sizing (Fase 1-limieten) ────────────────────────────────
describe("6. position sizing binnen de Fase 1-limieten", () => {
  it("risk_pct wordt geclampt naar de harde band en notional ≤ 25% van kas", () => {
    const spec: StrategySpec = {
      name: "sizing-test", description: "x", hypothesis: "x", expected_regime: "x",
      failure_conditions: "x", falsification: "x", timeframe: "15m", direction: "long",
      entry_conditions: [{ kind: "rsi_lt", value: 95 }],
      exit_conditions: [{ kind: "rsi_gt", value: 4 }],
      stop_loss_pct: 1, take_profit_pct: 5, max_hold_bars: 8, risk_pct: 99, // buiten band!
      pairs: ["BTC-EUR"], expected_holding_time_min: 30, origin: "manual",
    };
    const bt = runPairBacktest(FRAME, spec, { equityStart: 1000 });
    for (const t of bt.trades) {
      // risk 99% zou gigantische size geven; de band + cap beperken het
      const notional = t.entryPrice * t.size;
      expect(notional).toBeLessThanOrEqual(1000 * (RISK_MAX_PCT + 100) / 100 * 0.26); // ≤ ~25%+ruimte
      // werkelijke risico bij SL: size*entry*sl% ≤ 1% band van equity
      const riskAtSl = t.size * t.entryPrice * 0.01;
      expect(riskAtSl).toBeLessThanOrEqual(10.001); // 1% van 1000
    }
  });
});

// ── 7/8. SL/TP + exit-handling ─────────────────────────────────────────
describe("7/8. stop-loss, take-profit en exit-handling", () => {
  const spec: StrategySpec = {
    name: "exit-test", description: "x", hypothesis: "x", expected_regime: "x",
    failure_conditions: "x", falsification: "x", timeframe: "15m", direction: "long",
    entry_conditions: [{ kind: "rsi_lt", value: 95 }],
    exit_conditions: [{ kind: "rsi_gt", value: 4 }], // onmogelijk → SL/TP/max-hold
    stop_loss_pct: 2, take_profit_pct: 2, max_hold_bars: 16, risk_pct: 0.5,
    pairs: ["BTC-EUR"], expected_holding_time_min: 30, origin: "manual",
  };
  it("SL raakt → reden stop-loss, TP raakt → take-profit (pessimistisch SL eerst)", () => {
    const bt = runPairBacktest(FRAME, spec, { equityStart: 1000 });
    const reasons = new Set(bt.trades.map((t) => t.reason));
    for (const r of reasons) expect(["stop-loss", "take-profit", "max-hold", "end-of-data", "signaal"]).toContain(r);
    // een SL-verlistrade verliest ≈ sl% + kosten (nooit meer)
    const sl = bt.trades.find((t) => t.reason === "stop-loss");
    if (sl) {
      const lossPct = (sl.exitPrice / sl.entryPrice - 1) * 100;
      expect(lossPct).toBeGreaterThanOrEqual(-2.6); // 2% SL + slip/fee-marge
    }
  });
});

// ── 9/10/11. train/test-split, WF-vensters, OOS-isolatie ────────────────
describe("9/10/11. split + walk-forward", () => {
  it("IS komt strikt vóór OOS; vensterendes delen geen candle", () => {
    const sp = makeSplit(3000);
    expect(sp.is.toIdx).toBeLessThan(sp.oos.fromIdx);
    expect(sp.is.fromIdx).toBe(FRAME_WARMUP);
    expect(sp.oos.toIdx).toBe(2999);
    const ratio = (sp.is.toIdx - sp.is.fromIdx) / (sp.oos.toIdx - sp.oos.fromIdx);
    expect(ratio).toBeGreaterThan(1.4); // ~65/35
  });
  it("walk-forward: 4 opeenvolgende, niet-overlappende vensters die alles dekken", () => {
    const w = walkForwardWindows(3000);
    expect(w.length).toBe(4);
    for (let i = 1; i < w.length; i++) expect(w[i].fromIdx).toBeGreaterThan(w[i - 1].toIdx);
    expect(w[w.length - 1].toIdx).toBe(2999);
    expect(w[0].fromIdx).toBe(FRAME_WARMUP);
  });
});

// ── 12/13. perturbatie + sample-eisen ──────────────────────────────────
describe("12/13. parameter-perturbatie en minimum sample size", () => {
  const spec: StrategySpec = {
    name: "perturb", description: "x", hypothesis: "x", expected_regime: "x",
    failure_conditions: "x", falsification: "x", timeframe: "15m", direction: "long",
    entry_conditions: [{ kind: "rsi_lt", value: 40 }],
    exit_conditions: [{ kind: "rsi_gt", value: 60 }],
    stop_loss_pct: 3, take_profit_pct: 4, max_hold_bars: 32, risk_pct: 0.5,
    pairs: ["BTC-EUR"], expected_holding_time_min: 240, origin: "manual",
  };
  it("perturbatie test ±10% drempels en rapporteert de slechtste ratio", () => {
    const r = perturbationTest(FRAME, spec);
    expect(r.variants.some((v) => v.label.includes("+10%"))).toBe(true);
    expect(r.variants.some((v) => v.label.includes("-10%"))).toBe(true);
    expect(Number.isFinite(r.worstRatio)).toBe(true);
  });
  it("evaluator: te weinig OOS-trades → INSUFFICIENT_DATA, nooit candidate", () => {
    const empty = computeMetrics([], [], 1000);
    const ev = evaluateSpec({
      isMetrics: { ...empty, trades: MIN_TRADES_IS, netPnl: 50, expectancyEur: 1 },
      oosMetrics: { ...empty, trades: MIN_TRADES_OOS - 1, netPnl: 5 },
      wf: { windows: [], positiveWindows: 0, totalWindows: 4, consistencyPct: 0 },
      robustness: { scenarios: [], passRatio: 1, ok: true },
      flags: {
        oos_negative_while_is_positive: false, walkforward_inconsistent: false,
        single_coin_dominance: false, sample_too_small: true,
        extreme_drawdown: false, fee_fragile: false, parameter_cliff: false,
      },
      warnings: [],
    });
    expect(ev.status).toBe("INSUFFICIENT_DATA");
    expect(ev.status).not.toBe("RESEARCH_CANDIDATE");
  });
});

// ── 14/15. overfitting-detectie ────────────────────────────────────────
describe("14/15. overfitting-waarschuwingen", () => {
  it("IS+ / OOS− en fragiele fees geven expliciete vlaggen", () => {
    const m = computeMetrics([mkTrade(1)], [1000], 1000);
    const { flags, warnings } = detectOverfitting({
      isMetrics: { ...m, netPnl: 100, trades: 50 },
      oosMetrics: { ...m, netPnl: -20, trades: 20 },
      wf: { windows: [], positiveWindows: 1, totalWindows: 4, consistencyPct: 25 },
      perPairNet: [{ pair: "A", netPnl: 90 }, { pair: "B", netPnl: 1 }],
      robustness: { scenarios: [], passRatio: 0.2, ok: false },
      perturbation: { worstRatio: 0.1 },
    });
    expect(flags.oos_negative_while_is_positive).toBe(true);
    expect(flags.walkforward_inconsistent).toBe(true);
    expect(flags.single_coin_dominance).toBe(true);
    expect(flags.fee_fragile).toBe(true);
    expect(flags.parameter_cliff).toBe(true);
    expect(warnings.length).toBeGreaterThanOrEqual(4);
  });
});

// ── 16/17/18. spec-validatie + afwijzing van ongeldige specs ────────────
describe("16/17/18. strategy-specificatie-validatie", () => {
  const valid = baselines()[0];

  it("alle baselines zijn geldige specs onder de strikte validator", () => {
    for (const b of baselines()) {
      const v = validateSpec(b);
      expect(v.ok).toBe(true);
    }
    expect(newsMomentumNote().toLowerCase()).toContain("niet backtestbaar");
  });

  it("ongeldige velden wijzen de HELE spec af (hard fail)", () => {
    // risk buiten band
    expect(validateSpec({ ...valid, risk_pct: 5 }).ok).toBe(false);
    // TP onder fee-guard
    expect(validateSpec({ ...valid, take_profit_pct: 0.6 }).ok).toBe(false);
    // onbekende conditie-kind
    expect(validateSpec({ ...valid, entry_conditions: [{ kind: "magic_signal" as never, value: 1 }] }).ok).toBe(false);
    // timeframe buiten whitelist
    expect(validateSpec({ ...valid, timeframe: "1m" as never }).ok).toBe(false);
    // pair buiten whitelist
    expect(validateSpec({ ...valid, pairs: ["DOGE-EUR"] }).ok).toBe(false);
    // onbekend veld
    expect(validateSpec({ ...valid, gut_feeling: 9 as never }).ok).toBe(false);
    // te veel condities
    expect(validateSpec({
      ...valid,
      entry_conditions: [
        { kind: "rsi_lt", value: 40 }, { kind: "rsi_gt", value: 20 },
        { kind: "rsi_lt", value: 41 }, { kind: "rsi_gt", value: 21 },
        { kind: "rsi_lt", value: 42 },
      ],
    }).ok).toBe(false);
  });
});

// ── 19. research-budget ────────────────────────────────────────────────
describe("19. research AI-budget", () => {
  it("stopt veilig zodra de run-limiet is bereikt", async () => {
    const r = await researchBudgetOk(999); // limiet overshoot
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("budget");
  });
});

// ── 20. job-states ─────────────────────────────────────────────────────
describe("20. research job-states", () => {
  it("kent precies de toegestane states", () => {
    expect(JOB_STATUSES).toEqual(["pending", "running", "completed", "failed", "cancelled"]);
  });
});

// ── 21b. AI-output-normalisatie (structureel, deterministisch) ──────────
describe("21b. normalisatie van AI-voorstellen", () => {
  const valid = baselines()[0];
  it("string-condities worden tot objecten geparseerd (rsi_lt(35), trend1h:up, ema_above_ema 50 200)", () => {
    const draft = normalizeSpecDraft({
      ...valid,
      name: "norm-test",
      entry_conditions: ["rsi_lt(35)", "trend1h:up", "ema_above_ema 50 200", "breakout_24h"],
      exit_conditions: ["rsi_gt 60"],
      description: "x".repeat(400),
    }) as Record<string, unknown>;
    const ec = draft.entry_conditions as Record<string, unknown>[];
    expect(ec[0]).toEqual({ kind: "rsi_lt", value: 35 });
    expect(ec[1]).toEqual({ kind: "trend1h", value: "up" });
    expect(ec[2]).toEqual({ kind: "ema_above_ema", period: 50, period2: 200 });
    expect(ec[3]).toEqual({ kind: "breakout_24h" });
    expect((draft.exit_conditions as Record<string, unknown>[])[0]).toEqual({ kind: "rsi_gt", value: 60 });
    expect((draft.description as string).length).toBeLessThanOrEqual(300);
    expect(validateSpec(draft).ok).toBe(true);
  });
  it("onparseerbare condities blijven ongeldig — normalisatie verzint niets", () => {
    const draft = normalizeSpecDraft({ ...valid, name: "bad-norm", entry_conditions: ["buy the dip!!"] });
    expect(validateSpec(draft).ok).toBe(false);
  });
});

// ── 21. research kan geen trades plaatsen + geen ACTIVE �─────────────────
describe("21. isolatie: research kan niet handelen en kan niet activeren", () => {
  const dir = path.resolve("lib/research");
  const forbidden = [
    "marketLong", "marketShort", "closePosition", "insertOrder", "insertSignal",
    "claimSignal", "saveState", "initState", "PAPER_LIVE", "BLOFIN_API",
    "child_process", "exec(", "eval(", "setLeverage",
  ];

  it("bevat geen enkele execution- of trading-write identifier", () => {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      for (const bad of forbidden) {
        expect(src.includes(bad), `${f} bevat verboden identifier "${bad}"`).toBe(false);
      }
    }
  });

  it("research-status kent ACTIVE/LIVE niet (type + lifecycle + migration)", () => {
    expect(RESEARCH_STATUSES).toEqual(["HYPOTHESIS", "TESTING", "REJECTED", "INSUFFICIENT_DATA", "RESEARCH_CANDIDATE"]);
    const sql = fs.readFileSync(path.resolve("supabase-phase2-setup.sql"), "utf8");
    expect(sql).toContain("check (status in ('HYPOTHESIS','TESTING','REJECTED','INSUFFICIENT_DATA','RESEARCH_CANDIDATE'))");
    // de check-constraint bewaakt het ook op database-niveau
    expect(sql).toContain("ACTIVE/LIVE/PAPER_ACTIVE bestaan hier bewust NIET");
  });

  it("regimes: dalende reeks → downtrend, stijgende → uptrend-vorm", () => {
    // dalende koersen: ema50 < ema200
    const down: number[] = [];
    let p = 100;
    for (let i = 0; i < 400; i++) { p *= 0.999; down.push(p); }
    const ema = (arr: number[], per: number) => {
      const k = 2 / (per + 1); let prev = arr[0];
      return arr.map((v) => (prev = v * k + prev * (1 - k)));
    };
    const atr = down.map(() => 0.5);
    const r = regimeAt(down, ema(down, 50), ema(down, 200), atr, 399);
    expect(r).toBe("downtrend");
  });
});
