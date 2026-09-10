// ── Tijdzone-bewuste handelsdag (Europe/Amsterdam) ─────────────────────
// Timestamps worden overal in UTC opgeslagen, maar de "handelsdag" (daglimiet,
// frequentie-tellers, reset) is expliciet Europe/Amsterdam — geen UTC-middernacht
// die om 02:00 lokale tijd de boel reset.

import { TRADING_TIMEZONE } from "./risk/config";

/** YYYY-MM-DD van een moment in Europe/Amsterdam. */
export function amsterdamDay(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TRADING_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

/**
 * UTC-instant van 00:00 Europe/Amsterdam op de handelsdag van `d`.
 * NL schakelt tussen UTC+1 (CET) en UTC+2 (CEST); het DST-moment ligt
 * altijd rond 02:00/03:00 lokale tijd, dus middernacht is met een
 * offset-check betrouwbaar te bepalen.
 */
export function amsterdamMidnightUtc(d: Date = new Date()): Date {
  const dayStr = amsterdamDay(d);
  const cand1 = Date.parse(`${dayStr}T00:00:00+01:00`); // CET
  const cand2 = Date.parse(`${dayStr}T00:00:00+02:00`); // CEST
  // de echte middernacht = de VROEGSTE kandidaat die op dezelfde Amsterdamse dag valt
  const cands = [cand1, cand2].filter((t) => amsterdamDay(new Date(t)) === dayStr);
  return new Date(Math.min(...cands));
}

/** Handelt een ISO-timestamp op de Amsterdamse handelsdag? */
export function isSameAmsterdamDay(iso: string, ref: Date = new Date()): boolean {
  try {
    return amsterdamDay(new Date(iso)) === amsterdamDay(ref);
  } catch {
    return false;
  }
}
