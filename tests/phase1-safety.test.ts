// ── Fase 1-tests deel 2: AI-output, nieuws-matching, tijdzone, BloFin-safety
import { describe, it, expect, vi } from "vitest";
import { validateAiOutput, capProposals } from "@/lib/agents/schema";
import { classifyTitle, tokenize, matchesPhrase } from "@/lib/agents/newsMatch";
import { amsterdamDay, amsterdamMidnightUtc } from "@/lib/time";
import { compareRecon } from "@/lib/exchange/reconcile";
import { blofinLive, blofinConfigured } from "@/lib/exchange/blofin";

const validProposal = {
  pair: "BTC-EUR", side: "buy", kind: "entry", strategy: "pullback",
  timeframe: "15m", sl_pct: 2.5, tp_pct: 4, risk_pct: 0.5, confidence: "high",
  expected_move_pct: 4, expected_duration_min: 240, setup_quality: "A",
  thesis: "vervolg van de uptrend na pullback naar EMA50",
  invalidation: "koers verliest EMA200 op 15m",
  explanation: "Pullback in uptrend 15m, nieuws ok",
};

describe("7/8/9. AI-output: cap, strikt schema, ongeldige JSON", () => {
  it("accepteert een exact geldige output", () => {
    const r = validateAiOutput({
      news_assessment: { level: "ok", reason: "rustig" },
      proposals: [validProposal],
    });
    expect(r.ok).toBe(true);
  });

  it("wijst de HELE run af bij één ongeldig veld (hard fail)", () => {
    const r = validateAiOutput({
      news_assessment: { level: "ok", reason: "rustig" },
      proposals: [validProposal, { ...validProposal, pair: "DOGE-EUR" }],
    });
    expect(r.ok).toBe(false);
  });

  it("wijst af bij een onbekend veld (strikt schema)", () => {
    const r = validateAiOutput({
      proposals: [{ ...validProposal, gut_feeling: 10 }],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("onbekend veld");
  });

  it("wijst risico buiten de band 0,25–1,0% hard af", () => {
    const r = validateAiOutput({
      proposals: [{ ...validProposal, risk_pct: 5 }],
    });
    expect(r.ok).toBe(false);
  });

  it("wijst af bij verwachte duur < 15 min (anti-scalp)", () => {
    const r = validateAiOutput({
      proposals: [{ ...validProposal, expected_duration_min: 3 }],
    });
    expect(r.ok).toBe(false);
  });

  it("cap: max 2 voorstellen, overtollige worden apart geretourneerd (gelogd)", () => {
    const proposals = [
      { ...validProposal }, { ...validProposal, pair: "ETH-EUR" }, { ...validProposal, pair: "SOL-EUR" },
    ] as never[];
    const { keep, rejected } = capProposals(proposals);
    expect(keep.length).toBe(2);
    expect(rejected.length).toBe(1);
  });

  it("exits hebben een lichtere veldeneis", () => {
    const r = validateAiOutput({
      proposals: [{
        pair: "BTC-EUR", side: "sell", kind: "exit", strategy: "pullback",
        timeframe: "15m", explanation: "thesis gebroken",
      }],
    });
    expect(r.ok).toBe(true);
  });
});

describe("nieuws-matching: tokens i.p.v. substring", () => {
  it("matcht NIET 'war' in 'Payward' (de oude false positive)", () => {
    const r = classifyTitle("Nasdaq invests $100 million in Kraken parent company Payward at $21 billion valuation");
    expect(r.level).toBe("ok");
  });
  it("matcht wél echte risico-koppen", () => {
    expect(classifyTitle("Exchange hacked for 1.5 billion in user funds").level).toBe("high");
    expect(classifyTitle("Fed signals emergency rate cut").level).toBe("high");
    expect(classifyTitle("New Bitcoin ETF approval expected").level).toBe("caution");
  });
  it("detecteert geraakte coins", () => {
    const r = classifyTitle("Solana network outage under investigation");
    expect(r.affectedPairs).toContain("SOL-EUR");
  });
  it("multi-word phrases matchen alleen als volledige woordgroep", () => {
    expect(matchesPhrase(tokenize("the fed cut rates"), "rate cut")).toBe(false);
    expect(matchesPhrase(tokenize("a surprise rate cut today"), "rate cut")).toBe(true);
  });
});

describe("13. tijdzone: handelsdag Europe/Amsterdam", () => {
  it("01:30 Amsterdam = nieuwe dag (UTC 23:30 vorige dag, zomer)", () => {
    // 15 jul 2026 23:30 UTC = 16 jul 01:30 CEST
    expect(amsterdamDay(new Date("2026-07-15T23:30:00Z"))).toBe("2026-07-16");
  });
  it("middernacht-resets vallen op Amsterdamse middernacht, niet op 02:00 lokale tijd", () => {
    const mid = amsterdamMidnightUtc(new Date("2026-01-15T12:00:00Z")); // winter (CET)
    expect(mid.toISOString()).toBe("2026-01-14T23:00:00.000Z"); // 15 jan 00:00 CET
    const midSummer = amsterdamMidnightUtc(new Date("2026-07-15T12:00:00Z")); // zomer (CEST)
    expect(midSummer.toISOString()).toBe("2026-07-14T22:00:00.000Z"); // 15 jul 00:00 CEST
  });
});

describe("14. BloFin reconciliation (pure vergelijking)", () => {
  it("match = ok", () => {
    const r = compareRecon({ "BTC-USDT": { side: "long", contracts: 10 } }, { "BTC-USDT": 10 });
    expect(r.ok).toBe(true);
  });
  it("extra demo-positie (paper flat) = mismatch met actie-sluiten", () => {
    const r = compareRecon({}, { "ETH-USDT": 5 });
    expect(r.ok).toBe(false);
    expect(r.mismatches[0].severity).toBe("extra");
  });
  it("ontbrekende demo-positie = 'missing', nooit auto-open", () => {
    const r = compareRecon({ "SOL-USDT": { side: "long", contracts: 8 } }, {});
    expect(r.mismatches[0].severity).toBe("missing");
    expect(r.mismatches[0].action).toContain("NOOIT");
  });
  it("size-verschil > 20% = mismatch", () => {
    const r = compareRecon({ "BTC-USDT": { side: "long", contracts: 10 } }, { "BTC-USDT": 4 });
    expect(r.mismatches[0].severity).toBe("size_mismatch");
  });
});

describe("17. BloFin safety-guard: demo-only", () => {
  it("is zonder credentials nooit 'live' (paper-only)", async () => {
    vi.resetModules();
    vi.stubEnv("BLOFIN_API_KEY", "");
    vi.stubEnv("BLOFIN_SECRET_KEY", "");
    vi.stubEnv("BLOFIN_PASSPHRASE", "");
    vi.stubEnv("PAPER_LIVE", "");
    const mod = await import("@/lib/exchange/blofin");
    expect(mod.blofinConfigured).toBe(false);
    expect(mod.blofinLive).toBe(false);
    vi.unstubAllEnvs();
  });

  it("weigert een host zonder 'demo' — live-activering is onmogelijk (safety-guard)", async () => {
    vi.resetModules();
    vi.stubEnv("BLOFIN_API_KEY", "x");
    vi.stubEnv("BLOFIN_SECRET_KEY", "x");
    vi.stubEnv("BLOFIN_PASSPHRASE", "x");
    vi.stubEnv("PAPER_LIVE", "blofin");
    vi.stubEnv("BLOFIN_DEMO_HOST", "https://openapi.blofin.com"); // LIVE-host
    const mod = await import("@/lib/exchange/blofin");
    expect(mod.blofinConfigured).toBe(true);   // credentials zijn er...
    expect(mod.blofinLive).toBe(false);        // ...maar de mirror weigert hard
    vi.unstubAllEnvs();
  });
});
