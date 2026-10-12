-- NdurePlan: loads from uploaded FIT files (9 Oct 2026)
-- Safe to run more than once; nothing is removed.
--
-- What is stored per file (no original FIT is kept):
--   totals (times, distance, HR), lap summaries with their loads (laps jsonb),
--   and the 10-second pieces as base64 text (5 bytes per piece, about 2.4 kB per hour)
--   so loads can be recalculated when zones change or Orienteering is ticked.

-- Sessions: the Orienteering tick on runs ------------------------------------
alter table public.sessions add column if not exists orienteering boolean not null default false;
update public.sessions set orienteering = true where discipline = 'Orienteering' and not orienteering;

-- Activities ------------------------------------------------------------------
alter table public.activities
    add column if not exists source text not null default 'strava',
    add column if not exists file_name text,
    add column if not exists start_time timestamptz,
    add column if not exists elapsed_s numeric,
    add column if not exists moving_s numeric,
    add column if not exists paused_s numeric,
    add column if not exists excluded_s numeric,
    add column if not exists descent_m numeric,
    add column if not exists max_hr numeric,
    add column if not exists sub_sport text,
    add column if not exists surface text,
    add column if not exists device text,
    add column if not exists hr_quality text,
    add column if not exists calc jsonb,
    add column if not exists pieces text;

alter table public.activities alter column user_id set default auth.uid();
-- null = no usable heart rate in the file (the plan fills in)
alter table public.activities alter column hr_load set default null;
alter table public.activities alter column body_load set default null;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'activities_pieces_size') then
        alter table public.activities add constraint activities_pieces_size
            check (pieces is null or char_length(pieces) <= 400000);          -- ~44 hours
    end if;
    if not exists (select 1 from pg_constraint where conname = 'activities_laps_size') then
        alter table public.activities add constraint activities_laps_size
            check (laps is null or pg_column_size(laps) <= 200000);
    end if;
    if not exists (select 1 from pg_constraint where conname = 'activities_surface_check') then
        alter table public.activities add constraint activities_surface_check
            check (surface is null or surface in ('road', 'track', 'treadmill', 'orienteering', 'trail'));
    end if;
    if not exists (select 1 from pg_constraint where conname = 'activities_hr_quality_check') then
        alter table public.activities add constraint activities_hr_quality_check
            check (hr_quality is null or hr_quality in ('ok', 'none', 'cadence'));
    end if;
end $$;

-- Row level security: your own rows, and only linked to your own sessions ------
alter table public.activities enable row level security;

do $$
begin
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'activities' and policyname = 'activities_insert_own') then
        create policy activities_insert_own on public.activities for insert to authenticated
            with check (
                user_id = (select auth.uid())
                and (session_id is null or exists (select 1 from public.sessions s where s.id = session_id and s.user_id = (select auth.uid())))
            );
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'activities' and policyname = 'activities_update_own') then
        create policy activities_update_own on public.activities for update to authenticated
            using (user_id = (select auth.uid()))
            with check (
                user_id = (select auth.uid())
                and (session_id is null or exists (select 1 from public.sessions s where s.id = session_id and s.user_id = (select auth.uid())))
            );
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'activities' and policyname = 'activities_remove_own') then
        create policy activities_remove_own on public.activities for delete to authenticated
            using (user_id = (select auth.uid()));
    end if;
end $$;
