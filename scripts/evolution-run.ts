// ── Lokaal evolution-cycle-script: npm run evolution ──────────────────────
// Draait de FIRST EVOLUTION CYCLE (Deel 42) met échte data:
//   parent baseline-rsi-dip → AI-mutaties (≤3) → research → gate → registry.
// Geen live trading; research plaatst geen orders; activatie is fail-closed
// op de strategy_registry-tabellen (supabase-phase3-setup.sql).
// Resultaat wordt als JSON naar stdout + research-results/ geschreven.

import * as fs from "node:fs";
import * as path from "node:path";

const envPath = path.resolve(".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

import { mkdirSync, writeFileSync } from "node:fs";

async function main() {
  console.log("── FASE 3: evolution-cycle ─────────────────────────────");
  console.log("parent-context laden (verse dataset, baseline herberekend)…");
  const { loadParentContext } = await import("../lib/evolution/parent");
  const { runEvolutionCycle } = await import("../lib/evolution/evolution");
  const parent = await loadParentContext();
  if (!parent) {
    console.error("FAIL: parent-context niet beschikbaar (dataset-fout?)");
    process.exit(1);
  }
  console.log(`parent: ${parent.name} (${parent.legacyStrategyId} v${parent.version}, familie ${parent.family})`);
  console.log(`parent OOS: ${parent.researchResult.oos.trades} trades · exp €${parent.researchResult.oos.expectancyEur}/trade · netto €${parent.researchResult.oos.netPnl}`);
  const result = await runEvolutionCycle(parent, { requestedBy: "local-script" });
  mkdirSync("research-results", { recursive: true });
  writeFileSync(`research-results/${result.run_id}.json`, JSON.stringify(result, null, 2));

  console.log("\n── UITKOMST ─────────────────────────────────────────────");
  for (const o of result.outcomes) {
    console.log(`\n• ${o.name} (parent: ${o.parent})`);
    console.log(`  wijziging: ${o.changedWhat} — waarom: ${o.why}`);
    console.log(`  verwachting: ${o.expectedImprovement} | mislukt als: ${o.failureCriteria}`);
    if (!o.valid) { console.log(`  ✗ ONGELDIG: ${(o.validationErrors ?? []).join("; ")}`); continue; }
    if (o.duplicate) { console.log("  ⏭ DUPLICAAT: bijna-identieke spec al actief — overgeslagen"); continue; }
    const r = o.research!;
    console.log(`  research: IS ${r.is.trades}t wr${r.is.winratePct}% netto €${r.is.netPnl} | OOS ${r.oos.trades}t wr${r.oos.winratePct}% netto €${r.oos.netPnl} exp €${r.oos.expectancyEur}`);
    console.log(`  WF: ${r.walkforward.positiveWindows}/${r.walkforward.totalWindows} positief | robustness ${(r.robustness.passRatio * 100).toFixed(0)}% | score ${r.score}`);
    if (o.gate) {
      console.log(`  gate: ${o.gate.passed ? "GESlaagd ✓" : `AFGEWEZEN ✗ (${o.gate.reasons.slice(0, 2).join("; ")})`}`);
      if (o.gate.warnings.length) console.log(`  warnings: ${o.gate.warnings.join("; ")}`);
      console.log(`  ${o.gate.baselineComparison}`);
    }
  }
  console.log(`\n${result.summary}`);
  if (result.registry_blocked_reason) console.log(`⚠ REGISTRY GEBLOKKEERD: ${result.registry_blocked_reason}`);
  if (result.activation && !result.activation.ok) {
    console.log(`⚠ ACTIVATIE NIET GELUKT: ${result.activation.error}${(result.activation.blockers ?? []).length ? " — " + (result.activation.blockers ?? []).join("; ") : ""}`);
  }
  if (result.activation?.ok) console.log(`✓ CANARY ACTIEF als PAPER (registry id ${result.activation.activated_id}) — nog steeds géén live trading`);
  console.log(`\nAI-gebruik: ${result.ai.calls} call(s), $${result.ai.cost_usd.toFixed(4)}${result.ai.error ? ` (fout: ${result.ai.error})` : ""}`);
  console.log(`resultaat opgeslagen: research-results/${result.run_id}.json`);
}

main().catch((e) => { console.error("FOUT:", e); process.exit(1); });
