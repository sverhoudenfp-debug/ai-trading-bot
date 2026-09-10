// ── POST /api/evolution/activate — canary-activatie opnieuw proberen ────
// Voor het geval een gate-geslaagde kandidaat niet geactiveerd kon worden
// (bijv. phase3-migration nog niet gedraaid). Token-vereist. Alleen
// PAPER_CANDIDATE-rijen; alleen code beslist; max 1 canary; atomair.

import { NextRequest, NextResponse } from "next/server";
import { tokenOk } from "@/lib/auth";
import { listRegistry } from "@/lib/evolution/db";
import { activateCanary } from "@/lib/evolution/registry";
import { clearRegistryCache } from "@/lib/evolution/live";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!tokenOk(req)) {
    return NextResponse.json({ error: "onbevoegd — token vereist" }, { status: 401 });
  }
  const url = new URL(req.url);
  const wantedId = url.searchParams.get("id");
  const rows = await listRegistry(200);
  const pending = rows.filter((r) => r.status === "PAPER_CANDIDATE");
  if (!pending.length) {
    return NextResponse.json({ ok: false, error: "geen PAPER_CANDIDATE-rijen om te activeren" }, { status: 409 });
  }
  const target = wantedId ? pending.find((r) => r.id === Number(wantedId)) : pending[0];
  if (!target) {
    return NextResponse.json({ ok: false, error: `rij ${wantedId} is geen PAPER_CANDIDATE` }, { status: 409 });
  }
  const res = await activateCanary(
    target,
    `handmatige canary-activatie (gate eerder geslaagd) — aangevraagd via API`,
    req.headers.get("x-requested-by") ?? "elara"
  );
  if (res.ok) clearRegistryCache();
  return NextResponse.json({ ok: res.ok, error: res.error, blockers: res.blockers, row: res.row });
}
