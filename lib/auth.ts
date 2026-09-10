// ── Authenticatie-hulp voor de agent-endpoints (Fase 1) ──────────────────
// Token kan voortaan via de header `x-paper-token` (aanbevolen) óf — voor
// backwards-compatibility met cron-job.org — via ?token=…
// Timing-safe vergelijken; nooit loggen.

export function tokenOk(req: Request): boolean {
  const expected = process.env.PAPER_TOKEN;
  if (!expected) return false; // geen token geconfigureerd → alles dicht
  const url = new URL(req.url);
  const given = req.headers.get("x-paper-token") ?? url.searchParams.get("token") ?? "";
  if (given.length !== expected.length) return false;
  // constant-time vergelijking
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return diff === 0;
}
