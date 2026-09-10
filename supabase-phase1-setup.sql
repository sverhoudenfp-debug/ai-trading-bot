-- ═══════════════════════════════════════════════════════════════════════
-- FASE 1-MIGRATION (10 sep 2026) — idempotent, uitsluitend additief
-- Plak dit ÉÉN keer in Supabase → SQL Editor → New query → Run.
--
-- Wat deze migration doet (en wat er NIET verandert):
--   • paper_orders:     + timeframe, confidence, context (jsonb)
--   • trade_signals:    + expected_move_pct, expected_duration_min,
--                        setup_quality, thesis, invalidation
--   • news_alerts:      + category, affected_pairs
--   • agent_runs:       + execution_id
--   • NIEUW blofin_reconciliation (reconciliation-log per tick)
--   • bestaande tabellen/rijen/data: BLIJVEN ONAANGEROAST
--
-- BELANGRIJK: de bot werkt óók zonder deze migration (code valt terug op
-- de klassieke velden); mét migration worden snapshots + fee-uitsplitsing
-- + reconciliation-log volledig opgeslagen.
-- ═══════════════════════════════════════════════════════════════════════

-- ── paper_orders: tijdframe + confidence + snapshot/fee-uitsplitsing ──
alter table paper_orders
  add column if not exists timeframe text,
  add column if not exists confidence text,
  add column if not exists context jsonb;
comment on column paper_orders.context is
  'Fase 1: indicator-snapshot bij entry (rsi15, ema-afstanden, vol24h, expected_move, thesis, invalidation, …) en bij exit de uitsplitsing: gross_pnl_eur / fees_eur / slippage_eur / net_pnl_eur + hold_min + exit_reason';

-- ── trade_signals: rijkere proposal-data ───────────────────────────────
alter table trade_signals
  add column if not exists expected_move_pct double precision,
  add column if not exists expected_duration_min double precision,
  add column if not exists setup_quality text,
  add column if not exists thesis text,
  add column if not exists invalidation text;

-- ── news_alerts: gestructureerde categorie + geraakte pairs ───────────
alter table news_alerts
  add column if not exists category text,
  add column if not exists affected_pairs text;
comment on column news_alerts.affected_pairs is
  'kommagescheiden lijst van onze pairs die in de geraakte koppen voorkomen (bijv. "BTC-EUR,NEAR-EUR")';

-- ── agent_runs: uitvoerings-id van de orchestrator-run ─────────────────
alter table agent_runs
  add column if not exists execution_id text;

-- ── NIEUW: reconciliation-log BloFin demo ↔ paper ──────────────────────
create table if not exists blofin_reconciliation (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  ok boolean not null,
  mismatches jsonb,
  error text
);
create index if not exists blofin_reconciliation_recent_idx
  on blofin_reconciliation (created_at desc);

-- ── performance-indexes (monitoring/leer-vensters over created_at) ────
create index if not exists paper_orders_created_idx
  on paper_orders (created_at desc);
create index if not exists paper_orders_pair_created_idx
  on paper_orders (pair, created_at desc);
create index if not exists trade_signals_created_idx
  on trade_signals (created_at desc);
