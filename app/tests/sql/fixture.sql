-- Rough stand-in for the live NdurePlan schema (as implied by the old code) + Supabase auth bits
do $$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; end if; end $$;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
create table public.profiles (id uuid primary key references auth.users(id), email text, hr_zones jsonb, updated_at timestamptz);
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  sport_type text not null check (sport_type in ('run','bike','swim','xc ski','backcountry ski')),
  discipline text default '',
  date date not null,
  "time" time not null,
  blocks jsonb not null default '[]',
  description text default '',
  created_at timestamptz default now()
);
alter table public.sessions enable row level security;
create policy own_sessions on public.sessions for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.sessions, public.profiles to authenticated;
-- activities as it exists live (from the old Strava sync)
create table public.activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete set null,
  activity_uid text not null,
  name text, type text, sport_type text,
  date date not null,
  distance_m numeric default 0, duration_s numeric default 0, elevation_gain_m numeric default 0,
  avg_hr numeric, hr_load numeric default 0, body_load numeric default 0,
  laps jsonb default '[]', laps_loads jsonb default '[]',
  strava_start timestamptz, created_at timestamptz default now(), link_order integer,
  unique (user_id, activity_uid)
);
create index activities_user_date_idx on public.activities (user_id, date);
create index activities_session_idx on public.activities (session_id);
alter table public.activities enable row level security;
create policy "Users can view their own activities" on public.activities for select using (auth.uid() = user_id);
grant select, insert, update, delete on public.activities to authenticated;
insert into auth.users values ('11111111-1111-1111-1111-111111111111','kuba@example.com'), ('22222222-2222-2222-2222-222222222222','other@example.com');
insert into public.sessions (user_id, sport_type, discipline, date, "time", blocks, description)
values ('11111111-1111-1111-1111-111111111111','run','Road Run','2026-10-06','16:30','[{"type":"Warm Up","intensity":"easy","time_min":15}]','Threshold');
