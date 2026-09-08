-- Eenmalige setup voor fase 2 (paper trading)
-- Plak dit in Supabase → SQL Editor → New query → Run
create table if not exists paper_state (
  id int primary key default 1 check (id = 1),
  status text not null default 'flat',
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
insert into paper_state (id) values (1) on conflict (id) do nothing;

create table if not exists paper_orders (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  side text not null,
  price numeric not null,
  size numeric not null,
  reason text not null,
  equity_after numeric not null,
  pnl_eur numeric,
  pnl_pct numeric
);
