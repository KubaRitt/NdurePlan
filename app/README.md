# NdurePlan

Training planner and diary. Static site (no build step) on Vercel, data in Supabase.

## Deploy

The database is ready: every file in `supabase/migrations/` is applied to the live project (last on 9 Oct 2026).
Push or deploy `app/` to Vercel as before. There's no build step; Vercel serves `public/`.
`.vercelignore` keeps `tests/`, `node_modules/` and the Strava endpoints in `api/` out of the deployment.

For a fresh Supabase project: run the files in `supabase/migrations/` in the SQL editor, oldest first.

## Layout

```
public/
  index.html, login.html, dashboard.html
  css/app.css              all styles (light + dark), no framework
  supabase_api.js          every database call (Supabase client + RLS)
  sports.js                sports, session types, default zones
  js/model.js              pure logic: durations, planned/done loads, week totals, flags, copy week
  js/loads.js              the load formulas (Heart, Legs, surfaces, sports, strength)
  js/state.js              app state + actions (optimistic save, undo, debounced diary, FIT import)
  js/fit/decode.js         small FIT decoder (records, laps, sessions, timer events)
  js/fit/zip.js            reads the .fit inside a Garmin Connect .zip (built-in DecompressionStream)
  js/fit/analyze.js        10 s pieces, stops, HR checks, loads from pieces, storage encoding
  js/fit/importer.js       files -> import items (sport, local date, id); loaded only when importing
  js/fit/match.js          which session each file belongs to
  js/templates.js          built-in session templates
  js/main.js               wiring, rendering, events
  js/ui/                   week, day (plan/diary), editor, settings, activity (files + import), overlay, toast
supabase/migrations/       SQL to run in Supabase
tests/                     unit, end-to-end and real-database tests
api/                       Strava endpoints (not used by the app right now)
```

## How things are counted

Two loads, the same formulas for the plan (target HR of each block) and for files (`js/loads.js`):

- **Heart**, per minute: `3 ^ ((HR - Easy) / (AP2 - Easy))`. Easy = 1, AP2 = 3, AP3 about 6. From files it's summed over 10-second pieces.
- **Legs**, per moving minute: HR effort x surface. HR effort = 1.0 at Easy, 1.3 at AP3, straight line between (never below 0.5),
  using the HR 20 s later because the heart reacts late. Surfaces: road 1.0, track 0.95, treadmill 0.9, orienteering 0.9, trail 0.85.
  Downhill running x (1 + 3.4 x grade), slope measured over ±25 s. Other sports per minute: bike 0.25, XC/backcountry ski 0.4, swim 0.1.
- **Strength**: Heart = minutes x RPE / 60, Legs = minutes x RPE / 6.
- **Time from files**: a paused watch never counts; standing still (< 1.8 km/h) counts for Heart while it lasts 5 minutes or less;
  a stop longer than 5 minutes isn't counted at all.
- **Bad HR**: if HR covers less than half the time, or follows the step rate (wrist sensor locked to cadence), Heart comes from the plan
  and Legs uses the plan's effort.
- A session counts as hard with 3+ minutes of AP2, AP3 or sprint work.
- Done loads: from the files when there are any, otherwise the plan scaled to the diary time.

## FIT files

- Add them in the Diary tab, with "Add files" on a computer, by dropping them on the window, or in Settings. `.fit` or Garmin's `.zip`, many at once.
- Each file is matched to a session: same day and sport (a second file within 90 min joins the first), else a new unplanned session.
  The dialog shows the loads and lets you change the session before saving. Duplicates are skipped (watch serial + time created).
- Nothing big is stored: no original file. Each activity keeps totals, laps with their loads, and the 10-second pieces as base64
  text (5 bytes per piece, about 2.4 kB per hour). Changing zones, the session type or the Orienteering tick recalculates from the pieces.
- The decoder was checked record by record against Garmin's SDK and on 26 real device files (Garmin, Coros, Wahoo, old compressed formats,
  multisport, developer fields). Multisport files become one activity per sport.

## Tests

```
npm test                          # model, FIT decoding + loads, data layer (Node 20+)
npm run test:e2e                  # phone + desktop flows and FIT upload with a mock database (pip install playwright)
tests/realstack/realstack.py      # real supabase-js against a local Postgres with the migrations (needs Postgres 16 on :54329)
npm run fixtures                  # rebuild tests/fixtures/*.fit (needs npm install for @garmin/fitsdk)
```

## Strava

Switched off for now: the app doesn't call it, and `.vercelignore` keeps `api/` out of the deployment.
To bring the endpoints back, delete the `api/` line in `.vercelignore`.
