// ── Lokaal research-script (tsx scripts/research-run.ts [baseline|full]) ──
// Draait de research-pipeline buiten Vercel om (geen time-outlimiet) en
// schrijft het VOLLEDIGE resultaat naar research-results/<id>.json zodat
// de run reproduceerbaar en herleesbaar blijft.

import * as fs from "node:fs";
import * as path from "node:path";

async function main() {
  const mode = (process.argv[2] === "full" ? "full" : "baseline") as "baseline" | "full";
  // env laden uit .env (indien aanwezig)
  const envPath = path.resolve(".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
  const { runResearchPipeline } = await import("../lib/research/researcher");
  console.log(`▶ research-run (${mode}) — data: 180d 15m+1h, 4 pairs…`);
  const t0 = Date.now();
  const result = await runResearchPipeline({ mode, requestedBy: "local-script" });
  const mins = ((Date.now() - t0) / 60_000).toFixed(1);
  console.log(`✔ klaar in ${mins} min — ${result.summary}`);
  const dir = path.resolve("research-results");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${result.run_id}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 1));
  console.log(`→ resultaat: ${file}`);
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
