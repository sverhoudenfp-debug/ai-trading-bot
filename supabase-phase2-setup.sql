-- ═══════════════════════════════════════════════════════════════════════
-- FASE 2-MIGRATION (10 sep 2026) — idempotent, uitsluitend additief
-- Plak dit ÉÉN keer in Supabase → SQL Editor → New query → Run.
--
-- Nieuw (bestaande tabellen/rijen blijven onaangeroerd):
--   • research_jobs       — job-queue voor research-runs
--   • research_runs       — log per run (model, tokens, kosten, resultaat)
--   • research_candidates — lifecycle-records per geteste strategie
--     (statussen: HYPOTHESIS/TESTING/REJECTED/INSUFFICIENT_DATA/
--      RESEARCH_CANDIDATE — ACTIVE/LIVE bestáát hier niet, dat is Fase 3)
-- ═══════════════════════════════════════════════════════════════════════

-- ── job-queue ────────────────────────────────────────────────────────────
create table if not exists research_jobs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  type text not null,                    -- baseline-research | ai-research
  status text not null default 'pending' check (status in ('pending','running','completed','failed','cancelled')),
  requested_by text,
  summary text
);
create index if not exists research_jobs_status_idx on research_jobs (status, created_at desc);

-- ── run-log ──────────────────────────────────────────────────────────────
create table if not exists research_runs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  run_id text unique not null,
  type text not null,                    -- baseline | full
  started_at timestamptz not null,
  ended_at timestamptz not null,
  model text,
  ai_calls integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd_est double precision not null default 0,
  dataset_days integer,
  pairs jsonb,
  strategies_tested integer,
  hypotheses_generated integer,
  candidates_found integer,
  rejected integer,
  insufficient_data integer,
  errors jsonb
);
create index if not exists research_runs_created_idx on research_runs (created_at desc);
comment on table research_runs is 'Fase 2 research-run-log; ai_calls/cost_usd_est vormen het APARTE research-AI-budget (los van het trading-budget)';

-- ── candidates (lifecycle) ──────────────────────────────────────────────
create table if not exists research_candidates (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  strategy_id text not null,             -- name-runid
  name text not null,
  version integer not null default 1,
  status text not null check (status in ('HYPOTHESIS','TESTING','REJECTED','INSUFFICIENT_DATA','RESEARCH_CANDIDATE')),
  origin text not null,                  -- baseline | ai-research | manual
  hypothesis text,
  specification jsonb,                   -- volledige StrategySpec (data, geen code)
  researcher_model text,
  dataset_days integer,
  pairs jsonb,
  timeframe text,
  is_metrics jsonb,
  oos_metrics jsonb,
  walkforward jsonb,
  robustness jsonb,
  overfitting_flags jsonb,
  regime_performance jsonb,
  per_pair jsonb,
  fee_assumptions_pct double precision,
  slippage_assumptions_pct double precision,
  sample_size integer,
  score integer,
  rejection_reasons jsonb,
  research_explanation text
);
create index if not exists research_candidates_status_idx on research_candidates (status, created_at desc);
create index if not exists research_candidates_name_idx on research_candidates (name, created_at desc);
create index if not exists research_candidates_score_idx on research_candidates (score desc);
comment on constraint research_candidates_status_check on research_candidates is
  'Fase 2: ACTIVE/LIVE/PAPER_ACTIVE bestaan hier bewust NIET — activering is een expliciete Fase 3-beslissing';
