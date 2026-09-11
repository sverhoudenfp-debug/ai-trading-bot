// ── Regressietests: run-lock release (audit 11 sep 2026) ────────────────
// Bug: orderAgent laadt de pot-rij NÁ de lock-claim; saveState(pot) schreef
// de lock-timestamp terug → de lock verviel pas na de volledige TTL (5 min)
// in plaats van bij run-einde. Effect: de bot draaide feitelijk 1× per
// ~5 min i.p.v. elke minuut (bewezen: ~10 blofin_reconciliation-rijen/uur).
// Fix: pot.entry_time = null vóór de saveState aan het run-einde.
//
// Deze tests dekken het lock-mechanisme zelf af (claimRunLock + saveState),
// met een volledig gemockte Supabase-REST-laag — inclusief de
// regressievariant: een run-einde-save met de lock-timestamp erin moet de
// eerstvolgende claim laten FALEN (anders loopt de bug stilletjes terug).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── gemockte Supabase-REST-laag ──────────────────────────────────────────
// minimale in-memory papier_state-tabel: alleen pot-rij, veld entry_time
let dbEntryTime: string | null = null;
const state = () => dbEntryTime;

const handler = async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  const method = init?.method ?? "GET";
  if (u.includes("/rest/v1/paper_state")) {
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      // conditional PATCH-emulatie (PostgREST-filters in de URL)
      if (u.includes("entry_time=is.null")) {
        if (dbEntryTime === null) { dbEntryTime = body.entry_time; return { ok: true, json: async () => ([]) }; }
        return { ok: true, json: async () => [] }; // filter matcht niet → 0 rijen
      }
      if (u.includes("entry_time=lt.")) {
        const filter = decodeURIComponent(u.split("entry_time=lt.")[1]?.split("&")[0] ?? "");
        if (dbEntryTime !== null && dbEntryTime < filter) {
          dbEntryTime = body.entry_time ?? null;
          return { ok: true, json: async () => [{ pair: "__POT__", entry_time: dbEntryTime }] };
        }
        return { ok: true, json: async () => [] };
      }
      // gewone saveState-PATCH op pair=eq.__POT__ (geen entry_time-filter)
      if (u.includes("pair=eq.__POT__")) {
        if (body.entry_time !== undefined) dbEntryTime = body.entry_time;
        return { ok: true, json: async () => [{ pair: "__POT__" }] };
      }
      // per-coin saveState: accepteren zonder effect op de lock
      return { ok: true, json: async () => [] };
    }
  }
  return { ok: false, json: async () => ({ error: "onbekende route in mock" }) };
};

const fetchMock = vi.fn();


vi.mock("@/lib/paper/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/paper/store")>();
  return { ...actual, claimRunLock: actual.claimRunLock, saveState: actual.saveState };
});

import { claimRunLock, saveState } from "@/lib/paper/store";
import type { PaperState } from "@/lib/paper/store";

const pot: PaperState = {
  pair: "__POT__", status: "flat", cash: 765, entry_price: null, entry_time: null,
  size: null, cost: null, day: "2026-09-11", day_start_equity: 765, halted: false,
} as unknown as PaperState;

beforeEach(() => {
  dbEntryTime = null;
  fetchMock.mockClear();
  fetchMock.mockImplementation(handler);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("SUPABASE_URL", "https://mock.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "mock-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("16. Run-lock: claim, release en TTL (audit 11 sep)", () => {
  it("claimt als het lockveld vrij (null) is en laat een tweede gelijktijdige run falen", async () => {
    expect(await claimRunLock(5)).toBe(true); // init (→1970) + claim
    expect(await claimRunLock(5)).toBe(false); // lock ligt op toekomst → 0 rijen
    expect(state()).toMatch(/^\d{4}-\d{2}-\d{2}T/); // toekomst-timestamp
  });

  it("REGRSSIE-BEWAKING: run-einde met pot.entry_time = null (de fix) geeft de lock direct vrij → volgende minuut kan de cron weer runnen", async () => {
    expect(await claimRunLock(5)).toBe(true);
    // run-einde: de fix nullt het lockveld expliciet vóór de save
    const potFixed = { ...pot, entry_time: null };
    await saveState(potFixed);
    expect(state()).toBeNull();
    // volgende cron-run (1 min later): claim moet DIRECT slagen
    expect(await claimRunLock(5)).toBe(true);
  });

  it("REGRSSIE-BEWAKING: de oude bug-vorm — save met de lock-timestamp erin — moet de volgende claim laten falen (anders is de bug terug)", async () => {
    expect(await claimRunLock(5)).toBe(true);
    const lockTs = state();
    // de bug: in-memory pot droeg de lock-timestamp en schreef hem terug
    const potBuggy = { ...pot, entry_time: lockTs };
    await saveState(potBuggy);
    expect(state()).toBe(lockTs);
    expect(await claimRunLock(5)).toBe(false); // lock vast tot TTL — dit was het 5-min-patroon
  });

  it("TTL-verval: na afloop van de TTL kan een nieuwe run claimen, ook als de vorige crashte (zelfherstellend)", async () => {
    // gesimuleerde crash: lock ligt in het verleden (TTL verstreken)
    dbEntryTime = new Date(Date.now() - 6 * 60_000).toISOString();
    expect(await claimRunLock(5)).toBe(true);
  });

  it("lock-tabel onbeschikbaar → fail-open (bot draait door; signal-claims blijven atomair)", async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, json: async () => ({}) }));
    expect(await claimRunLock(5)).toBe(true); // documentgedrag: liever draaien
  });
});
