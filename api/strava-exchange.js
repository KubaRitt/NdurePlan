import { supabaseAdmin } from './supabase.js';

export default async function handler(req, res) {
  const { code, state, error: stravaError } = req.query;

  // Athlete hit "Cancel" on the Strava authorization screen
  if (stravaError) return res.redirect('/dashboard.html?strava=denied');

  if (!code || !state) return res.status(400).send('Missing code or state');

  const userId = state; // Supabase user id, passed through as `state`

  try {
    const tokenRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code'
      })
    });

    const data = await tokenRes.json();
    if (!data.access_token) {
      console.error('Strava token exchange failed', data);
      return res.redirect('/dashboard.html?strava=error');
    }

    const { error: dbError } = await supabaseAdmin.from('strava_tokens').upsert({
      user_id: userId,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at
    });

    if (dbError) {
      console.error('Failed to store strava tokens', dbError);
      return res.redirect('/dashboard.html?strava=error');
    }

    res.redirect('/dashboard.html?strava=connected');
  } catch (err) {
    console.error('strava-exchange error', err);
    res.redirect('/dashboard.html?strava=error');
  }
}
