// ── GET /api/paper/trades — volledige paper trade-historie + KPI's ───────
// Read-only, publiek (net als /api/paper/status — paper_orders bevat geen
// secrets). Hergebruikt listOrdersSince uit lib/paper/store; geen writes,
// geen trading-logica, puur presenteren van bestaande data.
//
//   ?limit=200&offset=0   paginering (max 500 per pagina)
//   ?aggregates=1         all-time portfolio-KPI's (één keer ophalen)
//
// De KPI's worden server-side berekend uit dezelfde bron (paper_orders)
// die ook de bot zelf schrijft — geen tweede bron van waarheid: dit is de
// portfolio-berekening over de VOLLEDIGE historie, de Phase 4-validation
// blijft authoritair voor per-strategie-versie-metrics.

import { NextRequest, NextResponse } from "next/server";
import { listOrdersSince, supabaseConfigured } from "@/lib/paper/store";

export const dynamic = "force-dynamic";

interface OrderExt {
  id: number;
  created_at: string | null;
  pair: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  reason: string;
  equity_after: number;
  pnl_eur: number | null;
  pnl_pct: number | null;
  strategy?: string | null;
  ai_explanation?: string | null;
  context?: Record<string, unknown> | null;
}

export async function GET(req: NextRequest) {
  if (!supabaseConfigured) {
    return NextResponse.json({ configured: false });
  }
  try {
    const sp = req.nextUrl.searchParams;
    const limit = Math.min(500, Math.max(1, Number(sp.get("limit") ?? 200)));
    const offset = Math.max(0, Number(sp.get("offset") ?? 0));
    const wantAggregates = sp.get("aggregates") === "1";

    // volledige historie ophalen (listOrdersSince is al gepagineerd intern,
    // maxPages=100 → tot ~100k orders afgedekt)
    const all = (await listOrdersSince(new Date(0).toISOString())) as OrderExt[];
    const exits = all.filter((o) => o.pnl_eur !== null);

    // paginering: nieuwste eerst
    const sorted = [...all].sort((a, b) =>
      (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    const page = sorted.slice(offset, offset + limit);

    let aggregates: Record<string, unknown> | null = null;
    if (wantAggregates) {
      const wins = exits.filter((o) => (o.pnl_eur ?? 0) > 0);
      const grossProfit = wins.reduce((a, o) => a + (o.pnl_eur ?? 0), 0);
      const grossLoss = exits.filter((o) => (o.pnl_eur ?? 0) < 0).reduce((a, o) => a + Math.abs(o.pnl_eur ?? 0), 0);
      const netPnl = exits.reduce((a, o) => a + (o.pnl_eur ?? 0), 0);
      const fees = exits.reduce((a, o) => a + (typeof o.context?.fees_eur === "number" ? (o.context.fees_eur as number) : 0), 0);
      const slip = exits.reduce((a, o) => a + (typeof o.context?.slippage_eur === "number" ? (o.context.slippage_eur as number) : 0), 0);

      // equity-curve over alle exits (running peak → drawdown, zelfde
      // conventie als de validation engine: stijgende curve = 0% DD)
      let eq = 1000; let runPeak = 1000; let maxDD = 0; const curve: { t: string; eq: number }[] = [];
      for (const o of exits) {
        eq += o.pnl_eur ?? 0;
        runPeak = Math.max(runPeak, eq);
        if (runPeak > 0) maxDD = Math.max(maxDD, ((runPeak - eq) / runPeak) * 100);
        curve.push({ t: o.created_at ?? "", eq });
      }

      const startEquity = exits.length ? (exits[0].equity_after - (exits[0].pnl_eur ?? 0)) : 1000;
      const winrate = exits.length ? (wins.length / exits.length) * 100 : null;
      const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? null : 0);
      const expectancy = exits.length ? netPnl / exits.length : null;

      aggregates = {
        total_orders: all.length,
        closed_trades: exits.length,
        net_pnl_eur: Math.round(netPnl * 100) / 100,
        gross_pnl_eur: Math.round((grossProfit - grossLoss) * 100) / 100,
        fees_eur: Math.round(fees * 100) / 100,
        slippage_eur: Math.round(slip * 100) / 100,
        winrate_pct: winrate === null ? null : Math.round(winrate * 10) / 10,
        profit_factor: pf === null ? null : Math.round(pf * 100) / 100,
        expectancy_eur: expectancy === null ? null : Math.round(expectancy * 100) / 100,
        max_drawdown_pct: Math.round(maxDD * 10) / 10,
        start_equity_eur: Math.round(startEquity * 100) / 100,
        equity_curve: curve.map((p) => ({ t: p.t, eq: Math.round(p.eq * 100) / 100 })),
        last_equity_eur: exits.length ? Math.round((exits[exits.length - 1].equity_after) * 100) / 100 : Math.round(startEquity * 100) / 100,
      };
    }

    return NextResponse.json({
      configured: true,
      trades: page,
      total: all.length,
      has_more: offset + page.length < all.length,
      aggregates,
    });
  } catch (e) {
    return NextResponse.json({ configured: true, error: String(e instanceof Error ? e.message : e) });
  }
}
