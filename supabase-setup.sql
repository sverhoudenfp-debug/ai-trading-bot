-- Setup voor fase 2 (multi-coin paper trading)
-- Plak dit in Supabase → SQL Editor → New query → Run.
-- Let op: dit verwijdert de oude tabellen en maakt ze opnieuw aan
-- (eventuele paper-data van vandaag gaat weg — dat is één testdag, geen ramp).

drop table if exists paper_orders;
drop table if exists paper_state;

create table paper_state (
  pair text primary key,
  status text not null default 'flat',        -- flat | long | short
  cash numeric not null default 1000,
  entry_price numeric,
  entry_time timestamptz,
  size numeric,
  cost numeric,
  day date,
  day_start_equity numeric not null default 1000,
  halted boolean not null default false,
  updated_at timestamptz not null default now()
);

create table paper_orders (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  pair text not null,
  side text not null,                          -- buy | sell
  price numeric not null,
  size numeric not null,
  reason text not null,
  equity_after numeric not null,
  pnl_eur numeric,
  pnl_pct numeric
);

-- De bot praat via de service_role key (bypass RLS), dus RLS hoeft niet aan.
