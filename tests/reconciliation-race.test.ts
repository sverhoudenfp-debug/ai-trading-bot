// ── Regressietests: BloFin-reconciliation race (11 sep 2026) ────────────
// Bug: runReconciliation draaide vóór saveState. Een market-order vult bij
// BloFin vrijwel direct, maar de DB kende de nieuwe paper-state nog niet →
// de verse demo-positie werd als "extra" geclassificeerd en binnen ~2 sec
// door de reconciliatie zelf gesloten (order 728584, ICP-USDT, 11 sep).
// Fix: (1) reconciliation ná persistence, (2) opens van de lopende run
// zijn protected en worden NOOIT gesloten, (3) echte stale posities worden
// nog steeds veilig gesloten.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/exchange/blofin", () => ({
  blofinLive: true,
  BLOFIN_INST: { "ICP-EUR": "ICP-USDT", "NEAR-EUR": "NEAR-USDT" },
  getPositions: vi.fn(),
  closePosition: vi.fn(),
  contractsFor: vi.fn(async () => 5382),
}));

vi.mock("@/lib/paper/store", () => ({
  getStates: vi.fn(),
  POT_PAIR: "__POT__",
}));

import { runReconciliation } from "@/lib/exchange/reconcile";
import { getPositions, closePosition } from "@/lib/exchange/blofin";
import { getStates } from "@/lib/paper/store";

const mockGetStates = vi.mocked(getStates);
const mockGetPositions = vi.mocked(getPositions);
const mockClose = vi.mocked(closePosition);

const flatIcp = { pair: "ICP-EUR", status: "flat", size: null } as never;
const longIcp = { pair: "ICP-EUR", status: "long", size: 53.82 } as never;

function demoPos(instId: string, contracts: number) {
  return { instId, positions: String(contracts), averagePrice: "2.74", markPrice: "2.74", unrealizedPnl: "0" };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SUPABASE_URL", ""); // geen DB-schrijving vanuit tests
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("15. Reconciliation race-safety (mirror-open ≠ extra)", () => {
  it("RACE (de bug van 11 sep): paper-state nog flat, BloFin-entry net gevuld, reconciliation draait vóór persistence → verse positie mag NIET gesloten worden", async () => {
    // exact het productiescenario: state nog niet opgeslagen (flat),
    // mirror-order al gevuld (5382 contracts), protected = deze run geopend
    mockGetStates.mockResolvedValue([flatIcp]);
    mockGetPositions.mockResolvedValue([demoPos("ICP-USDT", 5382)]);

    const actions: string[] = [];
    const r = await runReconciliation(actions, new Set(["ICP-USDT"]));

    // mismatch wordt wél gezien én gelogd (nooit stilletjes verdwijnen),
    // maar de verse demo-positie is NIET gesloten
    expect(closePosition).not.toHaveBeenCalled();
    expect(r?.ok).toBe(false);
    const m = r?.mismatches.find((x) => x.instId === "ICP-USDT");
    expect(m?.severity).toBe("extra");
    expect(m?.action).toContain("race-safe");
    expect(m?.action).toContain("NIET gesloten");
    expect(actions.some((a) => a.includes("race-safe"))).toBe(true);
  });

  it("geen mismatch: paper long + BloFin long bestaat → reconciliation doet niets", async () => {
    mockGetStates.mockResolvedValue([longIcp]);
    mockGetPositions.mockResolvedValue([demoPos("ICP-USDT", 5382)]);

    const actions: string[] = [];
    const r = await runReconciliation(actions, new Set(["ICP-USDT"]));

    expect(r?.ok).toBe(true);
    expect(r?.mismatches.length).toBe(0);
    expect(closePosition).not.toHaveBeenCalled();
    expect(actions.length).toBe(0);
  });

  it("stale extra positie (NET door deze run geopend) → bestaande veiligheidslogica sluit wél", async () => {
    // verweesde demo-positie: paper kent hem niet en de run heeft hem niet
    // zojuist geopend — dit is precies waar reconciliation voor bestaat
    mockGetStates.mockResolvedValue([flatIcp]);
    mockGetPositions.mockResolvedValue([demoPos("ICP-USDT", 5382)]);
    mockClose.mockResolvedValue("1000136728584");

    const actions: string[] = [];
    const r = await runReconciliation(actions); // géén protection

    expect(closePosition).toHaveBeenCalledTimes(1);
    expect(closePosition).toHaveBeenCalledWith("ICP-USDT");
    const m = r?.mismatches.find((x) => x.instId === "ICP-USDT");
    expect(m?.action).toContain("veilig gesloten");
  });

  it("idempotent: herhaalde reconciliation-runs met dezelfde protection sluiten nooit — en de eerstvolgende onbeschermde run mag corrigeren", async () => {
    mockGetStates.mockResolvedValue([longIcp]); // ná saveState: state is long
    mockGetPositions.mockResolvedValue([demoPos("ICP-USDT", 5382)]);

    // run 1 en 2 (zelfde run-herstart, protection actief): geen correctie
    for (let i = 0; i < 2; i++) {
      const r = await runReconciliation([], new Set(["ICP-USDT"]));
      expect(r?.ok).toBe(true); // match nu paper=long ↔ demo=long
      expect(closePosition).not.toHaveBeenCalled();
    }

    // paper onverhoopt toch flat geraakt (save faalde) → demo is verweesd;
    // eerstvolgende run zonder protection sluit hem veilig
    mockGetStates.mockResolvedValue([flatIcp]);
    mockClose.mockResolvedValue("1000136729000");
    const r3 = await runReconciliation([]);
    expect(closePosition).toHaveBeenCalledTimes(1);
    expect(r3?.ok).toBe(false);
  });

  it("missing-mismatch blijft log-only: paper long, BloFin leeg → NOOIT her-openen (ongewijzigd fase-1-gedrag)", async () => {
    mockGetStates.mockResolvedValue([longIcp]);
    mockGetPositions.mockResolvedValue([]);

    const actions: string[] = [];
    const r = await runReconciliation(actions);

    expect(closePosition).not.toHaveBeenCalled();
    const m = r?.mismatches.find((x) => x.instId === "ICP-USDT");
    expect(m?.severity).toBe("missing");
    expect(m?.action).toContain("NOOIT automatisch her-openen");
  });
});

describe("16. Reconciliation adversarial (audit 11 sep — Deel 3 aanvullend)", () => {
  const shortIcp = { pair: "ICP-EUR", status: "short", size: 53.82 } as never;

  it("paper SHORT + BloFin SHORT → match, geen actie", async () => {
    mockGetStates.mockResolvedValue([shortIcp]);
    mockGetPositions.mockResolvedValue([demoPos("ICP-USDT", -5382)]);
    const r = await runReconciliation([]);
    expect(r?.ok).toBe(true);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it("paper LONG + BloFin SHORT → side_mismatch: log-only, NOOIT sluiten (auto-correctie zou de paper-kant kunnen verdubbelen)", async () => {
    mockGetStates.mockResolvedValue([longIcp]);
    mockGetPositions.mockResolvedValue([demoPos("ICP-USDT", -5382)]);
    const r = await runReconciliation([]);
    expect(mockClose).not.toHaveBeenCalled();
    const m = r?.mismatches.find((x) => x.instId === "ICP-USDT");
    expect(m?.severity).toBe("side_mismatch");
    expect(m?.action).toContain("geen auto-correctie");
  });

  it("size-grens exact op de 20%-tolerantie: geen mismatch; één contract erboven wél size_mismatch (log-only)", async () => {
    mockGetStates.mockResolvedValue([longIcp]); // 5382 expected
    // exact +20% (6458.4 → floor 6458): binnen tolerantie
    mockGetPositions.mockResolvedValue([demoPos("ICP-USDT", 6458)]);
    expect((await runReconciliation([]))?.ok).toBe(true);
    // ruim boven de tolerantie: size_mismatch
    mockGetPositions.mockResolvedValue([demoPos("ICP-USDT", 7000)]);
    const r = await runReconciliation([]);
    const m = r?.mismatches.find((x) => x.instId === "ICP-USDT");
    expect(m?.severity).toBe("size_mismatch");
    expect(mockClose).not.toHaveBeenCalled();
  });

  it("BloFin API faalt (timeout/500) → reconciliation rapporteert de fout, sluit niets, breekt de run niet", async () => {
    mockGetStates.mockResolvedValue([flatIcp]);
    mockGetPositions.mockRejectedValue(new Error("fetch failed: network timeout"));
    const actions: string[] = [];
    const r = await runReconciliation(actions);
    expect(r?.ok).toBe(false);
    expect((r?.error ?? "")).toContain("timeout");
    expect(mockClose).not.toHaveBeenCalled();
    expect(actions.some((a) => a.includes("reconciliatie FOUT"))).toBe(true);
  });

  it("stale close-mislukking (BloFin weigert de sluit-order) → fout gelogd, run blijft heel, volgende run probeert opnieuw", async () => {
    mockGetStates.mockResolvedValue([flatIcp]);
    mockGetPositions.mockResolvedValue([demoPos("ICP-USDT", 5382)]);
    mockClose.mockRejectedValue(new Error("Blofin: order rejected"));
    const actions: string[] = [];
    const r = await runReconciliation(actions);
    expect(mockClose).toHaveBeenCalledTimes(1);
    const m = r?.mismatches.find((x) => x.instId === "ICP-USDT");
    expect(m?.action).toContain("sluiten mislukt");
    expect(actions.some((a) => a.includes("reconciliatie FOUT"))).toBe(true);
  });

  it("na een geslaagde stale-sluiting is de volgende reconciliation-run schoon (geen dubbele correctie)", async () => {
    mockGetStates.mockResolvedValue([flatIcp]);
    mockGetPositions.mockResolvedValueOnce([demoPos("ICP-USDT", 5382)]).mockResolvedValueOnce([]);
    mockClose.mockResolvedValue("1000136728584");
    const r1 = await runReconciliation([]);
    expect(r1?.ok).toBe(false);
    expect(mockClose).toHaveBeenCalledTimes(1);
    const r2 = await runReconciliation([]);
    expect(r2?.ok).toBe(true); // demo nu leeg ↔ paper flat
    expect(mockClose).toHaveBeenCalledTimes(1); // géén tweede sluiting
  });
});
