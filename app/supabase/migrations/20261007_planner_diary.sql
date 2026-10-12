-- NdurePlan: planner + diary rebuild
--
-- Already applied to the live project on 8 Oct 2026 (as planner_diary_1/2/3).
-- Kept here so a fresh project can be set up the same way: paste into the
-- Supabase SQL editor and Run. Safe to run again; nothing is deleted.
--
--   sessions  + done, rpe, actual (time/km/HR), notes; start time optional;
--               sport_type may be 'strength'
--   diary     one row per user per day (sleep, resting HR, legs, knee/ITB pain, notes)
--   templates sessions saved for reuse

begin;

-- 1. sessions -----------------------------------------------------------------

alter table public.sessions alter column "time" drop not null;

alter table public.sessions
  add column if not exists done   boolean  not null default false,
  add column if not exists rpe    smallint check (rpe between 1 and 10),
  add column if not exists actual jsonb,          -- {"duration_s": 2700, "km": 9.1, "hr": 152}
  add column if not exists notes  text;

-- Same list as before plus 'strength'. NOT VALID: only new rows are checked.
alter table public.sessions drop constraint if exists sessions_sport_type_check;
alter table public.sessions
  add constraint sessions_sport_type_check
  check (sport_type in ('run', 'bike', 'swim', 'xc ski', 'backcountry ski', 'strength'))
  not valid;

create index if not exists sessions_user_date_idx on public.sessions (user_id, date);

-- 2. diary ----------------------------------------------------------------------

create table if not exists public.diary (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  date       date        not null,
  sleep_h    numeric(3,1) check (sleep_h >= 0 and sleep_h <= 24),
  rest_hr    smallint    check (rest_hr between 20 and 150),
  legs       text        check (legs in ('fresh', 'normal', 'heavy', 'very tired')),
  pain       smallint    check (pain between 0 and 10),
  notes      text,
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

alter table public.diary enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'diary' and policyname = 'diary_owner') then
    create policy diary_owner on public.diary
      for all to authenticated
      using (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));
  end if;
end $$;

create or replace function public.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end $$;

revoke execute on function public.set_updated_at() from public, anon, authenticated;

create or replace trigger diary_set_updated_at
  before update on public.diary
  for each row execute function public.set_updated_at();

grant select, insert, update, delete on public.diary to authenticated;

-- 3. templates ----------------------------------------------------------------

create table if not exists public.templates (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  name        text        not null check (char_length(name) between 1 and 60),
  sport_type  text        not null,
  discipline  text        not null default '',
  description text        not null default '',
  blocks      jsonb       not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists templates_user_idx on public.templates (user_id);

alter table public.templates enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'templates' and policyname = 'templates_owner') then
    create policy templates_owner on public.templates
      for all to authenticated
      using (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));
  end if;
end $$;

grant select, insert, update, delete on public.templates to authenticated;

commit;

notify pgrst, 'reload schema';
