// ── FASE 4: statistische voorzichtigheid (Deel 17) ─────────────────────────
// Kleine samples zijn geen bewijs. Confidence-labels + deterministische
// bootstrap-percentielinterval op de netto-expectancy. Geen methode die
// valse zekerheid creëert: het interval is breed bij kleine samples —
// dat is het punt.

import { BOOTSTRAP_RUNS, CONF_LOW_SAMPLE_TRADES, CONF_EARLY_DAYS } from "./config";
import {
  VAL_MIN_CLOSED_TRADES, VAL_MIN_OBSERVATION_DAYS, VAL_MIN_ACTIVE_DAYS,
} from "./config";

export type ConfidenceLabel = "LOW_SAMPLE" | "EARLY" | "PRELIMINARY" | "VALIDATION_READY";

export interface ConfidenceReport {
  label: ConfidenceLabel;
  trades: number;
  observationDays: number;
  activeDays: number;
  bootstrap: {
    runs: number;
    p5: number;   // 5%-percentiel van netto-expectancy (€/trade)
    p50: number;
    p95: number;
  } | null;
  note: string;
}

/** Deterministische PRNG (mulberry32) — zelfde input → zelfde interval. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bootstrap-percentielen van de gemiddelde netto PnL per trade. */
export function bootstrapExpectancy(pnls: number[]): ConfidenceReport["bootstrap"] {
  if (pnls.length < 3) return null; // bootstrap op <3 punten is zinloos theater
  const seed = pnls.length * 1000 + Math.round(Math.abs(pnls.reduce((a, b) => a + b, 0)) * 100);
  const rnd = mulberry32(seed || 12345);
  const means: number[] = [];
  for (let i = 0; i < BOOTSTRAP_RUNS; i++) {
    let s = 0;
    for (let j = 0; j < pnls.length; j++) s += pnls[Math.floor(rnd() * pnls.length)];
    means.push(s / pnls.length);
  }
  means.sort((a, b) => a - b);
  const q = (p: number) => Math.round(means[Math.min(means.length - 1, Math.floor(p * means.length))] * 100) / 100;
  return { runs: BOOTSTRAP_RUNS, p5: q(0.05), p50: q(0.5), p95: q(0.95) };
}

export function confidenceReport(args: {
  pnls: number[];
  trades: number;
  observationDays: number;
  activeDays: number;
}): ConfidenceReport {
  const boot = bootstrapExpectancy(args.pnls);
  let label: ConfidenceLabel;
  let note: string;
  if (args.trades < CONF_LOW_SAMPLE_TRADES) {
    label = "LOW_SAMPLE";
    note = `${args.trades} trades — te weinig voor enige conclusie (min. ${CONF_LOW_SAMPLE_TRADES})`;
  } else if (args.observationDays < CONF_EARLY_DAYS || args.activeDays < 1) {
    label = "EARLY";
    note = `${args.observationDays} dag(en) observatie — eerste indrukken, geen bewijs`;
  } else if (
    args.trades < VAL_MIN_CLOSED_TRADES ||
    args.observationDays < VAL_MIN_OBSERVATION_DAYS ||
    args.activeDays < VAL_MIN_ACTIVE_DAYS
  ) {
    label = "PRELIMINARY";
    note = `${args.trades}/${VAL_MIN_CLOSED_TRADES} trades · ${args.observationDays}/${VAL_MIN_OBSERVATION_DAYS} dagen · ${args.activeDays}/${VAL_MIN_ACTIVE_DAYS} actieve dagen — trends zichtbaar, nog geen oordeel`;
  } else {
    label = "VALIDATION_READY";
    note = "minimums gehaald — statistisch überhaupt pas nu een oordeel mogelijk";
  }
  return {
    label,
    trades: args.trades,
    observationDays: Math.round(args.observationDays * 10) / 10,
    activeDays: args.activeDays,
    bootstrap: boot,
    note,
  };
}
