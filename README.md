# Ndure — auth + Garmin test

```
index.html    sign in / create account / Google
calendar.html calendar: diary + Garmin, day detail, import, sync, relink
dashboard.html 7 / 14 / 28-day distance and time per sport
prompt.js     the diary → JSON prompt shown in the app
settings.html Garmin key, heart-rate zones (Easy/AP1/AP2/AP3) per sport, neuromuscular rule
activity.html one activity: lap chart coloured by zone, time in zone, lap list
laps.js       lap engine: splits the Garmin track into laps and classifies them
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

Rolling 7, 14 and 28 days ending today: distance (time for sports without distance) per sport, totals,
km per week, and the last four 7-day blocks. Counts Garmin activities plus diary sessions that aren't
linked to one, so nothing is counted twice. **Sync last 28 days** refreshes Garmin first.

## Laps and zones

Garmin's personal API has no lap list, so `activity.html` asks the `garmin` function for the
second-by-second track (`action: "streams"`, cached in `activity_streams`) and `laps.js` builds the laps:

- **Efforts**: stretches clearly faster than the session's typical speed (power on a bike).
- **Between efforts**: running / walking / standing are split apart; steady running becomes 1 km laps
  (ski 2 km, bike 5 km, no distance: 5 min).
- **Zone per lap**: average heart rate against your limits in Settings.
- **Neuromuscular**: an effort no longer than the rep length (default 30 s) and faster than the optional
  minimum speed. **Rest**: standing, or a walk of up to 3 min right after an effort.
- **Time in zone**: heart rate per second, except neuromuscular reps count as NM.
