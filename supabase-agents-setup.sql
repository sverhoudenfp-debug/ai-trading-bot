-- Setup voor de 3-agent-architectuur (10 sep 2026)
-- Plak dit in Supabase → SQL Editor → New query → Run.
-- Voegt drie nieuwe tabellen toe; bestaande tabellen blijven onaangeroerd.

create table if not exists trade_signals (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  pair text not null,
  side text not null,                        -- buy | sell
  kind text not null,                        -- entry | exit
  reason text not null,
  strategy_version text not null default 'v1.0',
  outcome text not null default 'pending',   -- pending | executed | blocked_news | skipped | expired
  outcome_reason text,
  consumed boolean not null default false,
  consumed_at timestamptz
);

create table if not exists news_alerts (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  level text not null,                       -- ok | caution | high | unknown
  reason text not null,
  source text not null default 'rss:cointelegraph',
  valid_until timestamptz not null
);

create table if not exists strategy_versions (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  version text not null,
  params jsonb not null,
  backtest jsonb,
  status text not null default 'candidate',  -- candidate | active | rolled_back | rejected
  activated_at timestamptz,
  note text
);

create index if not exists trade_signals_pending_idx
  on trade_signals (consumed, created_at desc);
create index if not exists news_alerts_recent_idx
  on news_alerts (created_at desc);
