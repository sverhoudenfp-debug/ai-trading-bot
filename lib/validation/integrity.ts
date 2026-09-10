// ── FASE 4: data-integrity checks (Deel 26) ──────────────────────────────
// Regelmatige consistentiecontrole over paper-orders, paper-state en de
// registry. Bij een CRITICAL-probleem: FAIL CLOSED voor nieuwe strategy
// activation (de bestaande risk management blijft gewoon werken).

import type { PaperOrderExt } from "@/lib/paper/store";
import type { RegistryRow } from "@/lib/evolution/db";

export interface IntegrityIssue {
  severity: "CRITICAL" | "WARNING";
  check: string;
  detail: string;
}

export interface IntegrityReport {
  ok: boolean;                    // geen CRITICAL issues
  issues: IntegrityIssue[];
  checked: { orders: number; states: number; registry: number };
}

export function checkDataIntegrity(args: {
  orders: PaperOrderExt[];                  // orders van de strategy zelf
  allStates: { pair: string; status?: string; strategy?: string | null; size?: number | null }[];
  registry: RegistryRow[];
  strategyKey: string;
}): IntegrityReport {
  const issues: IntegrityIssue[] = [];
  const { orders, allStates, registry, strategyKey } = args;

  // 1. geen dubbele trades (zelfde pair + entry-tijdstip + side)
  const seen = new Set<string>();
  for (const o of orders) {
    const k = `${o.pair}|${String(o.created_at ?? "")}|${o.side}`;
    if (seen.has(k)) {
      issues.push({ severity: "CRITICAL", check: "duplicate_trade", detail: `dubbele order: ${k}` });
      if (issues.filter((i) => i.check === "duplicate_trade").length >= 3) break;
    }
    seen.add(k);
  }

  // 2. entries zonder bijbehorende exit-status (open positie is legaal; hangende exit zonder entry niet)
  const entries = orders.filter((o) => o.pnl_eur === null || o.pnl_eur === undefined);
  const exits = orders.filter((o) => o.pnl_eur !== null && o.pnl_eur !== undefined);
  if (exits.length > entries.length) {
    issues.push({ severity: "CRITICAL", check: "orphan_exit", detail: `${exits.length} exits tegen ${entries.length} entries` });
  }

  // 3. onmogelijke sizes/prijzen
  for (const o of orders) {
    if (!(o.size > 0) || !(o.price > 0)) {
      issues.push({ severity: "CRITICAL", check: "invalid_size_or_price", detail: `${o.pair}: size ${o.size} @ ${o.price}` });
      if (issues.filter((i) => i.check === "invalid_size_or_price").length >= 3) break;
    }
  }

  // 4. ontbrekende timestamps
  if (orders.some((o) => !o.created_at)) {
    issues.push({ severity: "WARNING", check: "missing_timestamp", detail: "order(s) zonder created_at" });
  }

  // 5. onmogelijke PnL (|pnl| > 100% van de notionele waarde van de trade)
  for (const o of exits) {
    const notional = o.size * o.price;
    if (notional > 0 && Math.abs(o.pnl_eur ?? 0) > notional) {
      issues.push({ severity: "CRITICAL", check: "impossible_pnl", detail: `${o.pair}: pnl €${o.pnl_eur} op notioneel €${Math.round(notional)}` });
    }
  }

  // 6. exit zonder fee-uitsplitsing terwijl die verwacht wordt (Fase 1-migration)
  const missingFee = exits.filter((o) => {
    const ctx = (o as { context?: { fees_eur?: number; fees?: number } }).context ?? {};
    return ctx.fees_eur === undefined && ctx.fees === undefined;
  });
  if (missingFee.length > 2) { // eerste migratie-orders zijn bekend legacy
    issues.push({ severity: "WARNING", check: "missing_fee_data", detail: `${missingFee.length} exits zonder fee-uitsplitsing` });
  }

  // 7. paper_state verwijst naar een evo-strategie die niet (meer) actief is
  const openEvoStates = allStates.filter((s) => (s.strategy ?? "").startsWith("evo/"));
  for (const s of openEvoStates) {
    const key = s.strategy ?? "";
    const known = registry.some((r) => `evo/${r.strategy_id}@${r.version}` === key);
    if (!known) {
      issues.push({ severity: "CRITICAL", check: "registry_inconsistency", detail: `open positie ${s.pair} verwijst naar onbekende strategie ${key}` });
    }
  }

  // 8. dubbele strategie-activatie in de registry (≥2 rijen met status PAPER_ACTIVE voor dezelfde strategy_id)
  const activeById = new Map<string, number>();
  for (const r of registry) {
    if (r.status === "PAPER_ACTIVE") activeById.set(r.strategy_id, (activeById.get(r.strategy_id) ?? 0) + 1);
  }
  for (const [id, n] of activeById) {
    if (n > 1) issues.push({ severity: "CRITICAL", check: "duplicate_activation", detail: `${n} actieve rijen voor ${id}` });
  }

  // 9. dubbele canary (registry-breed)
  const canaries = registry.filter((r) => r.status === "PAPER_ACTIVE" && r.canary).length;
  if (canaries > 1) {
    issues.push({ severity: "CRITICAL", check: "multiple_canaries", detail: `${canaries} canary's tegelijk actief (max 1)` });
  }

  return {
    ok: !issues.some((i) => i.severity === "CRITICAL"),
    issues,
    checked: { orders: orders.length, states: allStates.length, registry: registry.length },
  };
}
