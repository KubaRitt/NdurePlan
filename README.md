# Ndure — auth + Garmin test

```
web/
  index.html    sign in / create account / Google
  garmin.html   Garmin Personal API test page (signed-in only)
  config.js     Supabase URL + publishable key (safe to ship)
  style.css
  vercel.json   static hosting headers
supabase/functions/garmin/index.ts   edge function (deployed)
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
cd web && python3 -m http.server 5173
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

Import the repo, set the root directory to `web`, no build step.
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
