insert into public.profiles (id, email, hr_zones) values
 ('11111111-1111-1111-1111-111111111111', 'kuba@example.com', '{"run":{"easy":158,"ap1":172,"ap2":181,"ap3":195},"bike":{"easy":150,"ap1":163,"ap2":172,"ap3":185},"swim":{"easy":145,"ap1":158,"ap2":167,"ap3":180},"xc ski":{"easy":155,"ap1":168,"ap2":178,"ap3":190},"backcountry ski":{"easy":150,"ap1":163,"ap2":172,"ap3":185}}'),
 ('22222222-2222-2222-2222-222222222222', 'other@example.com', null);
-- legacy rows in whole minutes, the way the old app saved them
insert into public.sessions (user_id, sport_type, discipline, date, "time", blocks, description) values
 ('11111111-1111-1111-1111-111111111111','run','Road Run', date_trunc('week', current_date)::date + 1, '16:30',
  '[{"type":"Warm Up","intensity":"easy","target_hr":158,"time_min":15,"distance_km":3,"repeat":null},{"type":"AP2","intensity":"ap2","target_hr":181,"time_min":6,"distance_km":1.55,"repeat":{"reps":4,"rest_sec":60,"rest_type":"moving","rest_intensity":"easy","customized":false,"per_rep":[]}},{"type":"Cool Down","intensity":"easy","target_hr":158,"time_min":15,"distance_km":3,"repeat":null}]',
  'Threshold 4x6 (old format)'),
 ('11111111-1111-1111-1111-111111111111','run','Track', date_trunc('week', current_date)::date + 3, '16:30',
  '[{"type":"Warm Up","intensity":"easy","target_hr":158,"time_min":15,"distance_km":3,"repeat":null}]', 'Speed'),
 ('11111111-1111-1111-1111-111111111111','run','Road Run', date_trunc('week', current_date)::date - 6, '17:00',
  '[{"type":"Easy","intensity":"easy","target_hr":158,"time_min":40,"distance_km":8,"repeat":null}]', 'Easy last week'),
 ('22222222-2222-2222-2222-222222222222','run','Road Run', current_date, '07:00',
  '[{"type":"Secret","intensity":"easy","time_min":30}]', 'OTHER USER SESSION');
insert into public.diary (user_id, date, pain, notes) values ('22222222-2222-2222-2222-222222222222', current_date, 9, 'OTHER USER DIARY');
