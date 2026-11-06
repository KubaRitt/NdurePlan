# Ndure — auth + Garmin test

```
index.html    sign in / create account / Google
calendar.html calendar: diary + Garmin, day detail, import, sync, relink
garmin.html   Garmin Personal API test page (signed-in only)
config.js     Supabase URL + publishable key (safe to ship)
style.css
vercel.json   static hosting headers
supabase/functions/garmin/index.ts   Garmin: key, token, test GET, sync (deployed)
supabase/functions/diary/index.ts    diary import: JSON or scanned template (deployed)
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
- **Import diary** takes the JSON from `templates/diary-to-json-prompt.md`, or a PDF / photo of a filled
  template. Scans are read with Claude and need an `ANTHROPIC_API_KEY` edge function secret
  (Supabase → Edge Functions → Secrets).
- Each diary session is linked to the best Garmin activity that day (same sport family, then start time,
  duration, distance, then written order). Change a link in the day panel; your manual links are kept on re-sync.
- Tables: `days`, `diary_sessions`, `garmin_activities` (row-level security: your rows only).
