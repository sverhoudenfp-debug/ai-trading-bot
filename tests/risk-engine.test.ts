// ── Fase 1-tests: safety-critical guards (pure functions, geen externe API's)
import { describe, it, expect } from "vitest";
import {
  clampRiskPct, feeGuard, sizePosition, minHoldGuard,
  cooldownGuard, frequencyGuard, lossVelocityGuard, pnlBreakdown,
  type OrderLite,
} from "@/lib/risk/engine";

describe("1. risk clamping (hard 0,25–1,0%)", () => {
  it("clampt AI-voorstellen boven de band terug naar het maximum", () => {
    expect(clampRiskPct(5)).toBe(1.0);      // vroeger mocht 5-10%; nu hard 1,0
    expect(clampRiskPct(100)).toBe(1.0);
  });
  it("clampt onder de band naar het minimum", () => {
    expect(clampRiskPct(0.01)).toBe(0.25);
  });
  it("hanteert de default bij onzin-input", () => {
    expect(clampRiskPct(null)).toBe(0.5);
    expect(clampRiskPct(NaN)).toBe(0.5);
  });
  it("laat geldige waarden (0,35/0,5/0,7/0,9) intact", () => {
    for (const v of [0.35, 0.5, 0.7, 0.9]) expect(clampRiskPct(v)).toBe(v);
  });
});

describe("2. maximum notional + exposure", () => {
  const base = { equity: 1000, cash: 900, openNotional: 0, openPositions: 0, entry: 100, slPct: 3, riskPct: 0.5 };
  it("begrenst het notioneel op 25% van equity (i.p.v. 95% van de kas)", () => {
    // risico 1% met SL 0,5% zou 200% willen — de cap moet 25% geven
    const r = sizePosition({ ...base, slPct: 0.5, riskPct: 1 });
    expect(r.ok).toBe(true);
    expect(r.notional).toBeLessThanOrEqual(250.01); // 25% van 1000
  });
  it("weigert als de totaal-exposure (50%) al vol zit", () => {
    const r = sizePosition({ ...base, openNotional: 500, openPositions: 1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("exposure");
  });
  it("weigert boven het max aantal posities", () => {
    const r = sizePosition({ ...base, openNotional: 200, openPositions: 4 });
    expect(r.ok).toBe(false);
  });
  it("beperkt de positie tot de beschikbare kas minus de 2%-buffer", () => {
    const r = sizePosition({ ...base, cash: 5 });
    expect(r.ok).toBe(true);
    expect(r.notional).toBeLessThanOrEqual(5 * 0.98 + 0.01); // kasbuffer gerespecteerd
    expect(r.notional).toBeLessThanOrEqual(250); // én de notional-cap
  });
});

describe("3. fee-aware trade rejection", () => {
  it("keurt scalp-TP's af die de kosten niet dekken", () => {
    const r = feeGuard(3, 0.5); // TP 0,5% bij 0,6% round-trip
    expect(r.ok).toBe(false);
  });
  it("veregt gezonde RR's na kosten", () => {
    expect(feeGuard(2, 4).ok).toBe(true);   // netRR = (4−0,6)/(2+0,6) = 1,31
    expect(feeGuard(3, 4).ok).toBe(false); // netRR = 0,94 < 1,0 (de oude regel-SL3/TP4!)
  });
  it("geeft de formule terug voor logging", () => {
    const r = feeGuard(2, 2);
    expect(r.roundTripCostPct).toBeCloseTo(0.6, 5);
  });
});

describe("4. minimum hold (15 min)", () => {
  const now = new Date("2026-09-10T14:00:00Z");
  it("blokkeert AI-exits binnen 15 min", () => {
    const r = minHoldGuard("2026-09-10T13:58:00Z", now);
    expect(r.ok).toBe(false);
    expect(r.remainingMin).toBe(13);
  });
  it("staat exits ná 15 min toe", () => {
    expect(minHoldGuard("2026-09-10T13:44:00Z", now).ok).toBe(true);
  });
  it("maakt uitzondering bij nieuws-high", () => {
    expect(minHoldGuard("2026-09-10T13:58:00Z", now, { newsHigh: true }).ok).toBe(true);
  });
});

describe("5. cooldown na exit (10 min per pair)", () => {
  const now = new Date("2026-09-10T14:00:00Z");
  const o: OrderLite[] = [{ created_at: "2026-09-10T13:55:00Z", pair: "NEAR-EUR", side: "sell", pnl_eur: -3 }];
  it("blokkeert her-entry binnen de cooldown", () => {
    const r = cooldownGuard(o, "NEAR-EUR", now);
    expect(r.ok).toBe(false);
    expect(r.remainingMin).toBe(5);
  });
  it("staat her-entry ná de cooldown toe", () => {
    expect(cooldownGuard(o, "NEAR-EUR", new Date("2026-09-10T14:06:00Z")).ok).toBe(true);
  });
  it("raakt andere pairs niet", () => {
    expect(cooldownGuard(o, "BTC-EUR", now).ok).toBe(true);
  });
});

describe("6. frequency limits", () => {
  const now = new Date("2026-09-10T14:00:00Z");
  const mk = (min: number, pair: string): OrderLite =>
    ({ created_at: new Date(now.getTime() - min * 60_000).toISOString(), pair, side: "buy", pnl_eur: null });
  it("blokkeert het 3e entry per pair binnen een uur", () => {
    const orders = [mk(50, "NEAR-EUR"), mk(40, "NEAR-EUR")];
    const r = frequencyGuard(orders, "NEAR-EUR", now);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("in het laatste uur");
  });
  it("telt totalen mee (8/uur, 20/dag)", () => {
    const orders = [...Array(8)].map((_, i) => mk(30 - i, `P${i}-EUR` as string));
    expect(frequencyGuard(orders, "NEAR-EUR", now).ok).toBe(false);
  });
  it("accepteert rustige markten", () => {
    const orders = [mk(60, "BTC-EUR")];
    expect(frequencyGuard(orders, "NEAR-EUR", now).ok).toBe(true);
  });
});

describe("12. loss velocity + 10. pnl-uitsplitsing", () => {
  const now = new Date("2026-09-10T14:00:00Z");
  const loss = (min: number): OrderLite =>
    ({ created_at: new Date(now.getTime() - min * 60_000).toISOString(), pair: "NEAR-EUR", side: "sell", pnl_eur: -2 });
  it("pauzeert bij 3 verliezen binnen 60 min", () => {
    const r = lossVelocityGuard([loss(50), loss(30), loss(10)], now);
    expect(r.paused).toBe(true);
    expect(r.untilIso).toBeTruthy();
  });
  it("doet niks bij 2 verliezen", () => {
    expect(lossVelocityGuard([loss(50), loss(30)], now).paused).toBe(false);
  });

  it("splitst koersbijdrage, fees en slippage exact", () => {
    // long: 100 → 104 op 1 unit; fee 0,25%, slip 0,05%
    const bd = pnlBreakdown(100, 104, 1, true);
    expect(bd.grossPnlEur).toBeGreaterThan(3.5); // koerswinst minus slip
    expect(bd.feesEur).toBeCloseTo(0.51, 1);     // (100+104)*0,0025
    expect(bd.netPnlEur).toBeLessThan(bd.grossPnlEur);
    expect(bd.netPnlEur).toBeCloseTo(bd.grossPnlEur - bd.feesEur - bd.slippageEur, 2);
  });
});
