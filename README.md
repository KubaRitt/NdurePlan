# Ndure — auth + Garmin test

```
index.html    sign in / create account / Google
calendar.html calendar: diary + Garmin, day detail, import, sync, relink
dashboard.html 7 / 14 / 28-day distance and time per sport
prompt.js     the diary → JSON prompt shown in the app
settings.html Garmin key, heart-rate zones (Easy/AP1/AP2/AP3) per sport, neuromuscular rule
activity.html one activity: lap chart coloured by zone, time in zone, lap list
laps.js       lap engine + load model (TRIMP + body km)
metrics.js    saves per-activity load results in activity_metrics, recalculates when settings change
garmin.html   redirects to settings.html
config.js     Supabase URL + publishable key (safe to ship)
style.css
vercel.json   static hosting headers
supabase/functions/garmin/index.ts   Garmin: key, token, test GET, sync (deployed)
supabase/functions/diary/index.ts    diary import from the prompt's JSON (deployed)
supabase/functions/_shared/match.ts  sport families + session ↔ activity matching
templates/
  ndure-training-day.pdf    1 day, A4 portrait
  ndure-training-week.pdf   7 days, A4 landscape
  diary-to-json-prompt.md   prompt that turns any diary into import JSON
```

## How it fits together

Browser → Supabase Auth (session) → `garmin` edge function (checks your JWT) → Garmin.
The Garmin key lives in `public.garmin_credentials`. RLS is on with no policies, so no
browser client can read it; only the edge function (service role) can. That sidesteps
the CORS block you hit on a public domain, because Garmin is only ever called server-side.

## Run locally

```
python3 -m http.server 5173
```
Open http://localhost:5173

## Push to GitHub

```
git init
git add .
git commit -m "Ndure: auth + Garmin test page"
git branch -M main
git remote add origin https://github.com/<you>/ndure.git
git push -u origin main
```
`_backup/` is git-ignored.

## Deploy (Vercel)

Import the repo, leave the root directory as is, no build step.
GitHub Pages also works: Settings → Pages → Deploy from branch `main`, folder `/`.
Then add the Vercel URL in Supabase → Authentication → URL Configuration
(Site URL + Redirect URLs, e.g. `https://ndure.vercel.app/**`).

## Turn on Google sign-in

1. Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID (Web).
2. Authorised redirect URI: `https://ogikyrfnsaswqwsldkhr.supabase.co/auth/v1/callback`
3. Supabase → Authentication → Sign In / Providers → Google → paste client ID + secret → enable.

## Garmin test page

1. Garmin Connect Web → Personal API → Create key, paste it on the page and save.
2. **Get token** checks the key and that Supabase's servers can reach Garmin.
3. **Send GET** calls any `https://*.garmin.com` URL from the Personal API reference with the token attached.

## Calendar

- **Sync Garmin** pulls the visible month: activities, HRV, resting HR and sleep.
- **Prompt** shows the diary → JSON prompt with a copy button. Paste it into an AI with photos of your diary
  and save what it returns as a `.json` file.
- **Import diary** accepts only that `.json` file, then syncs Garmin for the imported dates automatically.
- Each diary session is linked to the best Garmin activity that day (same sport family, then start time,
  duration, distance, then written order). Change a link in the day panel; your manual links are kept on re-sync.
- Tables: `days`, `diary_sessions`, `garmin_activities` (row-level security: your rows only).

## Dashboard

Everything is rolling (windows ending today), not calendar weeks.

1. **Tiles**: HR load, body load, volume (time + km). Big number = last 7 days, plus 14 and 28 days,
   a 90-day sparkline of the 7-day sum, and a status (7 days ÷ 28-day weekly average: < 0.8 easing off,
   ≤ 1.3 steady, ≤ 1.5 building fast, above = spike). Click a tile to chart it.
2. **Load chart**:
   - Metric: HR load · Body load · HR + Body (body × a coefficient = total HR ÷ total body load over the
     loaded period, rounded, so both sit on one scale) · Volume (per sport, time or km).
   - Window: 7·14·28 (three rolling sums together, line only) · Day · 7 d · 14 d · 28 d rolling sum.
   - Line or bars (volume bars stack by sport, HR + Body bars sit side by side).
   - Range: 1 week · 1 month · 3 months · custom dates (older data is loaded when needed).
3. **Heart vs legs**: HR load and body load each as % of a normal week, on one scale, daily HR and body
   load as bars underneath.
4. **Where your time goes**: per sport and period (7 / 28 / 90 d), second-by-second heart rate in 5 bpm bins
   and pace (run/walk, min/km) or speed (km/h), each bar coloured by HR zone (speed bars by the average HR
   at that speed). The outline shows the previous period of the same length. Histograms are stored per activity in `activity_metrics.hist`.
5. **Per sport**: distance / time / sessions for 7, 14, 28 days. Garmin activities plus diary sessions that
   aren't linked to one.

**Sync last 120 days** refreshes Garmin in two 60-day calls, then saves any new tracks.

## Laps and zones

`activity.html` asks the `garmin` function for the activity (`action: "streams"`, cached in `activity_streams`):

- **Laps come from the watch.** The function downloads the activity file
  (`/download-service/files/activity/{id}` with `Accept: application/x-zip-compressed`), unzips it and reads the
  lap records with Garmin's FIT SDK (`supabase/functions/_shared/fitlaps.ts`). So you see exactly your lap
  presses, workout steps or auto-laps.
- The second-by-second track is used for the chart, the heart-rate line, time in zone and lap pace
  (speed sensor, because GPS distance lags on short reps).
- **Zone per lap**: average heart rate against your limits in Settings.
- **Neuromuscular**: a lap no longer than the rep length (default 30 s) and faster than the minimum speed
  (or 30 % faster than the session's typical speed). **Rest**: rest laps, recovery laps up to 3 min, or standing.
- If the watch file can't be read, laps are detected from the track instead and the page says so.

## Saved activities

Sync (calendar / dashboard) and diary import also save every new activity's track and watch laps in
`activity_streams` (`garmin` function, `action: "prefetch"`, ~45 s per call, repeated until done).
Pages read saved activities straight from the database; Garmin is only asked when one isn't saved yet.

## Load

Calculated second by second from the saved track (`laps.js`, `load()`), also shown per lap:

- **HR load** = Banister TRIMP: minutes × x × 0.64 × e^(1.92·x), x = (HR − resting) ÷ (max − resting).
  Resting HR is Garmin's value for that day (`days.rhr`), falling back to the one in Settings → Load.
  1 h easy ≈ 75, 30 min hard ≈ 95.
- **Body load** = points for bones, tendons and muscles: 10 per km × (speed ÷ easy pace, 0.4–2.5 for
  running/walking) × sport factor (run/walk 1, ski 0.4, bike 0.1, swim 0) + 10 per 100 m of descent.
  One easy km = 10.
- Strength / HIIT: HR load = half of the same minutes of easy running (1 h ≈ 30 min), body load 0.
- Settings → Load: max HR (198), resting HR fallback (48), easy running pace (5:30 /km).
- Results are stored in `activity_metrics` with a `calc_key`; changing settings or the day's resting HR
  recalculates them the next time they're shown.
- Dashboard: last 7 days vs 28-day weekly average and their ratio (< 0.8 low, ≤ 1.3 steady, ≤ 1.5 rising,
  above = spike), see Dashboard above.
