// ── POST /api/validation/run — handmatige/cron paper-validation-tick ────
// Token-vereist. Idempotent: één run per strategie per Amsterdamse dag
// (execution-lock in de database). ?force=1 om het interval te omzeilen
// (de dag-lock blijft altijd staan). Géén live trading — de tick leest en
// muteert alléén lifecycle-statussen, nooit exchange-orders.

import { NextRequest, NextResponse } from "next/server";
import { tokenOk } from "@/lib/auth";
import { validationTick } from "@/lib/validation/tick";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!tokenOk(req)) {
    return NextResponse.json({ error: "onbevoegd — token vereist" }, { status: 401 });
  }
  const force = new URL(req.url).searchParams.get("force") === "1";
  const result = await validationTick({ force });
  return NextResponse.json({ ok: true, result });
}
