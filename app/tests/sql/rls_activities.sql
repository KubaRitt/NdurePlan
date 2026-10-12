-- RLS for uploaded activities: run as the app would (role authenticated + JWT sub).
\set ON_ERROR_STOP on
select id as other_session from public.sessions where user_id = '22222222-2222-2222-2222-222222222222' limit 1 \gset
select id as own_session from public.sessions where user_id = '11111111-1111-1111-1111-111111111111' order by date limit 1 \gset
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
-- own session -> ok (user_id filled by the default)
insert into public.activities (session_id, activity_uid, date, source, duration_s, hr_load, body_load, surface, hr_quality, pieces, laps)
values (:'own_session', 'uid-own', '2026-10-06', 'fit', 3600, 97.4, 59.8, 'road', 'ok', 'AAAA', '[{"i0":0,"i1":1}]');
select 'own insert' as what, count(*) from public.activities;
-- duplicate file -> unique violation
\set ON_ERROR_STOP off
insert into public.activities (activity_uid, date) values ('uid-own', '2026-10-06');
-- someone else's session -> rejected
insert into public.activities (session_id, activity_uid, date) values (:'other_session', 'uid-foreign-session', current_date);
-- pretending to be someone else -> rejected
insert into public.activities (user_id, activity_uid, date) values ('22222222-2222-2222-2222-222222222222', 'uid-spoof', current_date);
-- bad surface -> rejected
insert into public.activities (activity_uid, date, surface) values ('uid-surface', current_date, 'sand');
\set ON_ERROR_STOP on
select 'after rejected inserts' as what, count(*) from public.activities;
-- upsert by id (what the recalculation does)
insert into public.activities (id, user_id, activity_uid, date, hr_load)
select id, user_id, activity_uid, date, 50 from public.activities where activity_uid = 'uid-own'
on conflict (id) do update set hr_load = excluded.hr_load;
select 'hr_load after upsert' as what, hr_load from public.activities where activity_uid = 'uid-own';
-- relinking to someone else's session -> rejected
\set ON_ERROR_STOP off
update public.activities set session_id = :'other_session' where activity_uid = 'uid-own';
\set ON_ERROR_STOP on
-- the other user sees nothing and can't delete it
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select 'other user sees' as what, count(*) from public.activities;
delete from public.activities;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select 'still there for owner' as what, count(*) from public.activities;
delete from public.activities where activity_uid = 'uid-own';
select 'owner deleted' as what, count(*) from public.activities;
reset role;
