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
  "PAPER_PENDING",            // Fase 4: gate geslaagd, wacht op paper-opzet
  "PAPER_CANDIDATE",
  "WAITING_FOR_CANARY_SLOT",  // Fase 4: candidate in de wachtrij (Deel 21)
  "PAPER_ACTIVE",
  "VALIDATION_EARLY",         // Fase 4: in observatie, nog geen minimums
  "VALIDATION_PROGRESS",      // Fase 4: minimums deels gehaald
  "VALIDATION_READY",         // Fase 4: alle criteria gehaald → klaar voor approval
  "PAPER_VALIDATING",         // (legacy Fase 3-status, nog geldig)
  "PAPER_APPROVED",
  "FAILED",                   // Fase 4: definitief gefaald na voldoende data
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
  VALIDATION_PENDING: ["PAPER_PENDING", "PAPER_CANDIDATE", "REJECTED"],
  PAPER_PENDING: ["PAPER_CANDIDATE", "REJECTED", "DEPRECATED"],
  PAPER_CANDIDATE: ["PAPER_ACTIVE", "WAITING_FOR_CANARY_SLOT", "REJECTED", "DEPRECATED"],
  WAITING_FOR_CANARY_SLOT: ["PAPER_ACTIVE", "DEPRECATED"], // slot vrij → kanary; anders blijft hij wachten
  PAPER_ACTIVE: ["VALIDATION_EARLY", "PAPER_VALIDATING", "ROLLED_BACK"],
  VALIDATION_EARLY: ["VALIDATION_PROGRESS", "PAPER_VALIDATING", "ROLLED_BACK", "FAILED"],
  VALIDATION_PROGRESS: ["VALIDATION_READY", "VALIDATION_EARLY", "PAPER_VALIDATING", "ROLLED_BACK", "FAILED"],
  VALIDATION_READY: ["PAPER_APPROVED", "ROLLED_BACK", "FAILED"],
  PAPER_VALIDATING: ["PAPER_APPROVED", "ROLLED_BACK", "PAPER_ACTIVE", "VALIDATION_READY"], // insufficient → terug naar meten
  PAPER_APPROVED: ["DEPRECATED"],
  FAILED: ["DEPRECATED"], // gefaald na voldoende data → nieuwe versie nodig
  ROLLED_BACK: ["DEPRECATED"], // NOOIT meer PAPER_ACTIVE met dezelfde versie (24u cooldown, Deel 20)
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

/** Re-activering van een gerolled-back/failed versie is hard verboden (Deel 14/20). */
export function reactivationBlocked(status: RegistryStatus): boolean {
  return status === "ROLLED_BACK" || status === "REJECTED" || status === "DEPRECATED" || status === "FAILED";
}

/** Statussen waarin de dagelijkse paper-validation-tick een strategie evalueert. */
export const VALIDATION_STATUSES: RegistryStatus[] = [
  "PAPER_ACTIVE", "VALIDATION_EARLY", "VALIDATION_PROGRESS", "PAPER_VALIDATING",
];
