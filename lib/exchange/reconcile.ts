// ── BloFin DEMO reconciliation (Fase 1) ─────────────────────────────────
// De paper-engine blijft de source of truth voor de strategie, maar de
// spiegel naar het BloFin-demo-account is een aparte stap die kan missen.
// Elke tick controleren we: verwachte posities (paper) vs. werkelijke
// demo-posities (BloFin). Bij een mismatch:
//   • "extra" (demo positie die paper niet kent) → veilig sluiten op demo
//     (virtueel geld, geen risico, voorkomt sluipende divergentie);
//     TENZIE de positie door de lopende bot-run zélf is geopend
//     (race-safe protection — zie runReconciliation);
//   • "missing" / "size_mismatch" → alléén loggen (NOOIT automatisch
//     her-openen — dat zou de spiegel kunnen verdubbelen).
// Een BloFin-fout verdwijnt nooit stil: hij komt in het run-antwoord en
// (zodra de phase1-migration is gedraaid) in de blofin_reconciliation-tabel.

import { blofinLive, BLOFIN_INST, getPositions, closePosition, contractsFor } from "./blofin";
import { PaperState, getStates, POT_PAIR } from "@/lib/paper/store";

export interface ReconSide { side: "long" | "short"; contracts: number }
export interface ReconMismatch {
  instId: string;
  paper: string;   // paper-status ("long ~12.4 contracts", "flat")
  demo: string;    // werkelijke demo-status
  severity: "extra" | "missing" | "size_mismatch" | "side_mismatch";
  action: string;   // wat er is gedaan
}

/** Pure vergelijking — testbaar zonder BloFin-aanroepen. */
export function compareRecon(
  expected: Record<string, ReconSide>, // instId → verwacht uit paper
  actual: Record<string, number>        // instId → werkelijke contracts op demo
): { ok: boolean; mismatches: ReconMismatch[] } {
  const mismatches: ReconMismatch[] = [];
  const instIds = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const instId of instIds) {
    const exp = expected[instId];
    const act = actual[instId] ?? 0;
    if (exp && act !== 0) {
      const sameSide = (exp.side === "long" && act > 0) || (exp.side === "short" && act < 0);
      const sizeOk = Math.abs(Math.abs(act) - exp.contracts) <= Math.max(1, exp.contracts * 0.2);
      if (!sameSide) {
        mismatches.push({ instId, paper: `${exp.side} ${exp.contracts} contracts`, demo: `${act} contracts`, severity: "side_mismatch", action: "gelogd (geen auto-correctie)" });
      } else if (!sizeOk) {
        mismatches.push({ instId, paper: `${exp.side} ${exp.contracts} contracts`, demo: `${act} contracts`, severity: "size_mismatch", action: "gelogd (geen auto-correctie)" });
      }
    } else if (exp && act === 0) {
      mismatches.push({ instId, paper: `${exp.side} ${exp.contracts} contracts`, demo: "geen positie", severity: "missing", action: "gelogd (NOOIT automatisch her-openen)" });
    } else if (!exp && act !== 0) {
      mismatches.push({ instId, paper: "flat", demo: `${act} contracts`, severity: "extra", action: "" });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** Volledige reconciliation-run (alleen als de BloFin-mirror actief is). */
// RACE-SAFE: reconciliation hoort pas te draaien nadat de paper-state van
// de lopende run volledig is gepersisteerd (orderAgent roept dit aan na
// saveState). Als extra bescherming krijgt runReconciliation de instIds mee
// die déze run via de mirror heeft geopend: een verse demo-positie daarop
// wordt NOOIT als "extra" gesloten — ook niet als reconciliation onverhoopt
// tegen een tussenstaat aanloopt. Idempotent: herhaalde runs met dezelfde
// protection sluiten niets; echte achtergebleven posities (niet beschermd)
// worden nog steeds veilig gesloten.
export async function runReconciliation(
  actions: string[],
  protectedInstIds: ReadonlySet<string> = new Set()
): Promise<{ ok: boolean; mismatches: ReconMismatch[]; error?: string } | null> {
  if (!blofinLive) return null;
  try {
    const [states, demoPositions] = await Promise.all([getStates(), getPositions()]);
    const openStates = states.filter((s) => s.pair !== POT_PAIR && (s.status === "long" || s.status === "short"));

    const expected: Record<string, ReconSide> = {};
    for (const s of openStates as PaperState[]) {
      const instId = BLOFIN_INST[s.pair];
      if (!instId || !s.size) continue;
      const contracts = await contractsFor(instId, s.size);
      expected[instId] = { side: s.status as "long" | "short", contracts };
    }
    const actual: Record<string, number> = {};
    for (const p of demoPositions) {
      const c = Number(p.positions);
      if (c !== 0) actual[p.instId] = c;
    }

    const res = compareRecon(expected, actual);
    const mismatches: ReconMismatch[] = res.mismatches;

    // veilige correctie: extra demo-positie (paper kent hem niet) → sluiten;
    // MAAR: door déze run geopend (race-safe protection) → nooit sluiten
    for (const m of mismatches) {
      if (m.severity === "extra") {
        if (protectedInstIds.has(m.instId)) {
          m.action = "race-safe: deze run geopend — NIET gesloten, alleen gelogd";
          actions.push(`reconciliatie: ${m.instId} ${m.action}`);
        } else {
          try {
            const orderId = await closePosition(m.instId);
            m.action = `extra demo-positie veilig gesloten (order ${orderId.slice(-6)})`;
            actions.push(`reconciliatie: ${m.instId} ${m.action}`);
          } catch (e) {
            m.action = `sluiten mislukt: ${String(e instanceof Error ? e.message : e)}`;
            actions.push(`reconciliatie FOUT: ${m.instId} ${m.action}`);
          }
        }
      } else {
        actions.push(`reconciliatie mismatch ${m.severity}: ${m.instId} paper=${m.paper} demo=${m.demo} → ${m.action}`);
      }
    }

    // wegschrijven naar blofin_reconciliation (tabel bestaat pas na de
    // phase1-migration — anders stil loggen via actions hierboven)
    try {
      const URL_ = process.env.SUPABASE_URL ?? "";
      const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
      if (URL_ && KEY) {
        await fetch(`${URL_}/rest/v1/blofin_reconciliation`, {
          method: "POST",
          headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ok: res.ok, mismatches, created_at: new Date().toISOString() }),
        });
      }
    } catch { /* tabel er nog niet → alleen via actions gelogd */ }

    return { ok: res.ok, mismatches };
  } catch (e) {
    const err = String(e instanceof Error ? e.message : e);
    actions.push(`reconciliatie FOUT: ${err}`);
    return { ok: false, mismatches: [], error: err };
  }
}
