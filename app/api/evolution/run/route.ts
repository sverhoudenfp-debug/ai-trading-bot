// ── POST /api/evolution/run — één gecontroleerde evolution-cycle ────────
// Token-vereist (net als research/run). Draait de cyclus:
// AI-mutaties (≤3) → research-pipeline → validation gate → registry
// → eventueel canary-activatie (max 1, atomair, fail-closed).
// NOOIT live trading; research kan geen orders plaatsen.

import { NextRequest, NextResponse } from "next/server";
import { tokenOk } from "@/lib/auth";
import { runEvolutionCycle } from "@/lib/evolution/evolution";
import { loadParentContext } from "@/lib/evolution/parent";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!tokenOk(req)) {
    return NextResponse.json({ error: "onbevoegd — token vereist" }, { status: 401 });
  }
  try {
    const parent = await loadParentContext();
    if (!parent) {
      return NextResponse.json({ ok: false, error: "geen parent-context beschikbaar (baseline-run eerst draaien)" }, { status: 409 });
    }
    const result = await runEvolutionCycle(parent, {
      requestedBy: req.headers.get("x-requested-by") ?? "dashboard",
    });
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
