\set ON_ERROR_STOP on
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
-- new columns + strength + null time
insert into public.sessions (user_id, sport_type, discipline, date, "time", blocks, description, done, rpe, actual)
values (auth.uid(), 'strength', 'Strength', '2026-10-07', null, '[]', 'Gym', true, 6, '{"duration_s":1800}');
insert into public.diary (user_id, date, sleep_h, legs, pain, notes) values (auth.uid(), '2026-10-07', 8.5, 'heavy', 3, 'knee ok');
-- upsert (what the app does)
insert into public.diary (user_id, date, pain) values (auth.uid(), '2026-10-07', 1)
  on conflict (user_id, date) do update set pain = excluded.pain;
insert into public.templates (name, sport_type, blocks) values ('Threshold 4x6', 'run', '[]');
select 'own diary rows' as what, count(*) from public.diary;
select 'own sessions' as what, count(*) from public.sessions;
select 'pain after upsert' as what, pain from public.diary where date = '2026-10-07';
-- someone else's row must be rejected
\set ON_ERROR_STOP off
insert into public.diary (user_id, date, pain) values ('22222222-2222-2222-2222-222222222222', '2026-10-08', 5);
\set ON_ERROR_STOP on
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select 'other user sees diary rows' as what, count(*) from public.diary;
select 'other user sees templates' as what, count(*) from public.templates;
reset role;
