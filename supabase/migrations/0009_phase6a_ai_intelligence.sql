-- CivicFix Phase 6A — Advanced AI Civic Intelligence
-- Additive only: new nullable columns + one brand-new function. No drops,
-- no data loss, no rewritten history, no changes to any existing
-- function's signature (see the note above get_area_concentration() below
-- for why get_insight_metrics() itself is intentionally left untouched).

-- ============================================================
-- ai_analyses.extended — structured extras from the richer Gemini
-- response (subcategory, split severity/priority reasoning, image
-- evidence, action steps, AI-generated complaint text). Kept as a single
-- JSONB column rather than ~14 new flat columns: it's genuinely optional
-- per-report data, shaped by src/lib/ai.ts's Zod schema on write and
-- re-validated on read (src/lib/data/report-detail.ts) — never trusted
-- raw. Existing flat columns (severity, priority, reasoning,
-- recommended_department, recommended_action, confidence) are untouched.
-- ============================================================

alter table public.ai_analyses
  add column if not exists extended jsonb;

comment on column public.ai_analyses.extended is
  'Phase 6A structured extras (subcategory, severity_reasoning, priority_reasoning, evidence, action_steps, complaint draft, etc). Validated by the Zod schema in src/lib/ai.ts before insert; re-validated on read. Never authoritative for routing.';

-- ============================================================
-- report_duplicate_flags — distinguish "duplicate" from "related" and
-- record the deterministic reason (no AI call — see src/lib/duplicate-
-- detection.ts). Existing rows keep their current meaning via the default.
-- ============================================================

alter table public.report_duplicate_flags
  add column if not exists relation_type text not null default 'duplicate'
    check (relation_type in ('duplicate', 'related'));

alter table public.report_duplicate_flags
  add column if not exists reason text;

comment on column public.report_duplicate_flags.relation_type is
  'duplicate = high-confidence same complaint; related = same-area/category but lower text overlap. Deterministic, not AI-generated.';
comment on column public.report_duplicate_flags.reason is
  'Human-readable explanation of which signals matched (area/category/distance/recency/wording). Built deterministically in src/lib/duplicate-detection.ts.';

-- ============================================================
-- get_area_concentration — one more real, deterministic insight pattern:
-- geographic concentration (top area + count of reports in that area over
-- the last 30 days).
--
-- Deliberately a NEW, separate function rather than adding columns to the
-- existing get_insight_metrics() (migration 0007). Postgres's
-- `create or replace function` cannot change a function's return row type
-- (adding/removing/reordering RETURNS TABLE columns) — it errors with
-- "cannot change return type of existing function ... Row type defined by
-- OUT parameters is different", requiring `drop function` first. Dropping
-- and recreating a function that already has real callers (src/lib/data/
-- government.ts, called from the live Government Dashboard) is exactly the
-- kind of destructive-looking step this migration set avoids by design —
-- so instead this stays purely additive: get_insight_metrics() is not
-- touched at all (same name, same signature, same body, same callers,
-- zero risk), and this new function is read by application code as a
-- second, independent RPC call (see getAIInsights() in government.ts).
-- Same security/stability model as every function in migration 0007.
-- ============================================================

create or replace function public.get_area_concentration()
returns table (
  top_area text,
  top_area_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with recent_locations as (
    select rl.area
    from public.report_locations rl
    join public.reports r on r.id = rl.report_id
    where rl.area is not null and r.created_at >= now() - interval '30 days'
  ),
  area_counts as (
    select area, count(*) as cnt from recent_locations group by area
  ),
  top_area as (
    select area, cnt from area_counts order by cnt desc, area asc limit 1
  )
  select
    (select area from top_area),
    coalesce((select cnt from top_area), 0);
$$;

revoke all on function public.get_area_concentration() from public;
grant execute on function public.get_area_concentration() to authenticated;
