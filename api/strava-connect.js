/**
 * NdurePlan - Strava OAuth kickoff
 *
 * GET /api/strava-connect?user_id=<supabase-user-id>
 *
 * Redirects the browser to Strava's authorization screen. Strava will
 * redirect back to STRAVA_REDIRECT_URI (or /api/strava-exchange on the
 * current host) with a `code` and the `state` we pass through here
 * (the Supabase user id), which strava-exchange.js uses to know which
 * athlete just connected.
 *
 * Requires these env vars set in your Vercel project:
 *   STRAVA_CLIENT_ID
 *   STRAVA_REDIRECT_URI   (optional — defaults to https://<host>/api/strava-exchange)
 *
 * The redirect URI must exactly match one registered in your Strava API
 * application settings (https://www.strava.com/settings/api).
 */

export default function handler(req, res) {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).send('Missing user_id');

  const redirectUri = process.env.STRAVA_REDIRECT_URI || `https://${req.headers.host}/api/strava-exchange`;

  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'activity:read_all',
    state: user_id
  });

  res.redirect(`https://www.strava.com/oauth/authorize?${params.toString()}`);
}
