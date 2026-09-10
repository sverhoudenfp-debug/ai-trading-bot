// ── FASE 3: strategie-lifecycle ─────────────────────────────────────────
// Expliciete state-machine. HYPOTHESIS → PAPER_ACTIVE direct is onmogelijk;
// RESEARCH_CANDIDATE → PAPER_ACTIVE is onmogelijk (VALIDATION_GATE ligt
// ertussen); een ROLLED_BACK versie komt NOOIT meer terug in PAPER_ACTIVE
// (alleen een nieuwe immutable versie kan opnieuw door de hele lifecycle).
// LIVE bestaat in dit domein niet — er is geen enkele status of transitie
// die naar live trading leidt (Deel 40).

export const REGISTRY_STATUSES = [
  "HYPOTHESIS",
  "TESTING",
  "REJECTED",
  "INSUFFICIENT_DATA",
  "RESEARCH_CANDIDATE",
  "VALIDATION_PENDING",
  "PAPER_CANDIDATE",
  "PAPER_ACTIVE",
  "PAPER_VALIDATING",
  "PAPER_APPROVED",
  "ROLLED_BACK",
  "DEPRECATED",
  "LEGACY",
] as const;

export type RegistryStatus = (typeof REGISTRY_STATUSES)[number];

/** Toegestane transities — alles wat hier NIET in staat is verboden. */
export const ALLOWED_TRANSITIONS: Record<RegistryStatus, RegistryStatus[]> = {
  HYPOTHESIS: ["TESTING", "REJECTED"],
  TESTING: ["RESEARCH_CANDIDATE", "REJECTED", "INSUFFICIENT_DATA"],
  REJECTED: ["DEPRECATED"],
  INSUFFICIENT_DATA: ["TESTING", "REJECTED"],
  RESEARCH_CANDIDATE: ["VALIDATION_PENDING", "REJECTED"],
  VALIDATION_PENDING: ["PAPER_CANDIDATE", "REJECTED"],
  PAPER_CANDIDATE: ["PAPER_ACTIVE", "REJECTED", "DEPRECATED"],
  PAPER_ACTIVE: ["PAPER_VALIDATING", "ROLLED_BACK"],
  PAPER_VALIDATING: ["PAPER_APPROVED", "ROLLED_BACK", "PAPER_ACTIVE"], // insufficient → terug naar meten
  PAPER_APPROVED: ["DEPRECATED"],
  ROLLED_BACK: ["DEPRECATED"], // NOOIT meer PAPER_ACTIVE met dezelfde versie
  DEPRECATED: [],
  LEGACY: ["DEPRECATED"], // bestaande productie-strategieën als benchmark
};

export function transitionAllowed(from: RegistryStatus, to: RegistryStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** Alleen statussen waarmee de trader signalen mag genereren. */
export const TRADABLE_PAPER_STATUSES: RegistryStatus[] = ["PAPER_ACTIVE"];

export function canTradePaper(status: RegistryStatus): boolean {
  return TRADABLE_PAPER_STATUSES.includes(status);
}

/** Re-activering van een gerolled-back versie is hard verboden (Deel 14). */
export function reactivationBlocked(status: RegistryStatus): boolean {
  return status === "ROLLED_BACK" || status === "REJECTED" || status === "DEPRECATED";
}
