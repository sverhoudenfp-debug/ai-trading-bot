-- AI-agent setup (9 sep 2026) — Plak in Supabase → SQL Editor → New query → Run
-- Breidt bestaande tabellen uit voor de gecombineerde AI-agent en logt
-- elke AI-aanroep inclusief token-kosten.

-- ── Signalen: AI-velden ─────────────────────────────────────────────────
alter table trade_signals
  add column if not exists ai_explanation text,
  add column if not exists timeframe text,
  add column if not exists sl_pct double precision,
  add column if not exists tp_pct double precision,
  add column if not exists risk_pct double precision,
  add column if not exists proposed_by text not null default 'rule',
  add column if not exists confidence text;

-- ── Orders: welke strategie + AI-onderbouwing per uitgevoerde trade ─────
alter table paper_orders
  add column if not exists strategy text,
  add column if not exists ai_explanation text;

-- ── Open posities: per positie de geldende SL/TP + strategie ─────────────
alter table paper_state
  add column if not exists sl_pct double precision,
  add column if not exists tp_pct double precision,
  add column if not exists strategy text;

-- ── Log van elke AI-aanroep (voor kosten-inzicht op het dashboard) ─────
create table if not exists agent_runs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  agent text not null default 'ai',
  model text,
  input_tokens bigint default 0,
  cache_read_tokens bigint default 0,
  cache_creation_tokens bigint default 0,
  output_tokens bigint default 0,
  cost_usd_est double precision default 0,
  proposals integer default 0,
  error text
);

create index if not exists agent_runs_recent_idx on agent_runs (created_at desc);
