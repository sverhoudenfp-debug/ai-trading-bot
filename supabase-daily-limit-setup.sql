-- ════════════════════════════════════════════════════════════════════════
-- ADAPTIVE DAILY LOSS LIMIT — tabel + index (idempotent, additief)
-- ════════════════════════════════════════════════════════════════════════
-- Doel: het daglimiet-circuit breaker adaptief maken (band −5%…−15%,
-- max ±1pp per Amsterdamse handelsdag, max één beslissing per dag).
--
-- VEILIGHEID:
--  • Deze tabel bevat ALLEEN een pauze-grens. Er is geen enkele koppeling
--    naar risk-per-trade, notional of exposure — die blijven hard gecodeerd
--    in lib/risk/config.ts en worden nergens automatisch aangepast.
--  • unique(trading_date) dwingt af: max één beslissing per handelsdag
--    (race tussen parallelle cron-runs → 409 → herlezen).
--  • Bot werkt óók zonder deze tabel: dan valt hij fail-closed terug op het
--    default limiet (−10%) — de circuit breaker valt nooit uit.
--
-- Uitvoeren: Supabase → SQL Editor → New query → dit bestand → Run.

create table if not exists daily_limit_adjustments (
  id                    bigint generated always as identity primary key,
  trading_date          text not null unique,          -- Amsterdamse handelsdag (YYYY-MM-DD)
  day_start_equity      numeric not null,              -- pot-equity bij eerste tick van de dag
  previous_limit_pct    numeric not null,              -- limiet van gisteren (−5…−15)
  new_limit_pct         numeric not null,              -- limiet voor vandaag (−5…−15)
  adjustment_pp        numeric not null,              -- Δ in percentagepunten (max ±1; 0 = ongewijzigd)
  realized_return_pct  numeric,                       -- gerealiseerd dagrendement van gisteren (equity-tot-equity)
  closed_trades        int,                           -- gesloten trades gisteren
  winrate_pct           numeric,                       -- winrate gisteren
  daily_pnl_eur         numeric,                       -- netto PnL gisteren
  performance_metric    text,                          -- leesbare metric-regel
  adjustment_reason     text not null,                 -- exact waarom deze aanpassing
  created_at            timestamptz not null default now(),

  -- harde band in de database zelf: het limiet kan nooit buiten −5…−15
  constraint daily_limit_band check (
    new_limit_pct >= 5 and new_limit_pct <= 15
    and previous_limit_pct >= 5 and previous_limit_pct <= 15
    and adjustment_pp >= -1 and adjustment_pp <= 1
  )
);

-- index voor de twee query-patronen (per-dag lookup + recente historie)
create index if not exists idx_daily_limit_date on daily_limit_adjustments (trading_date desc);

comment on table daily_limit_adjustments is
  'Adaptief daglimiet-circuit breaker: één beslissing per Amsterdamse handelsdag, band −5%…−15%, max ±1pp/dag. Verhoogt nooit trade-risico — alleen de pauze-grens.';
