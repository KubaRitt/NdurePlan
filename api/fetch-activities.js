import { supabaseAdmin } from './supabase.js';

/**
 * NdurePlan - Strava sync endpoint
 *
 * GET /api/fetch-activities?user_id=<uuid>&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
 *
 * 1. Pulls the athlete's recent Strava activities (summary list).
 * 2. For each new activity, pulls its laps and computes HR load + body
 *    load PER LAP from the athlete's saved HR zones (profiles.hr_zones),
 *    then sums those into the activity's total hr_load/body_load.
 * 3. Tries to match each activity to a *planned* session on the same date
 *    with the same sport, and links them (sets activities.session_id).
 * 4. Upserts everything into the `activities` table, including the raw
 *    laps and their per-lap loads (activities.laps / activities.laps_loads)
 *    so the lap-level breakdown is available later without re-fetching
 *    from Strava.
 */

// Pause threshold: if paused time exceeds this fraction of a lap's elapsed
// time, use moving_time for load calc instead (avoids inflated load from
// long stops — traffic lights, aid stations, etc).
const PAUSE_THRESHOLD = 0.07; // 7%

// Safe number helper — never returns NaN, null, undefined or Infinity
function safeNum(v, fallback = 0) {
  const n = Number(v);
  return (isFinite(n) && n === n) ? n : fallback;
}

// Strava's start_date_local is an ISO string already expressed in the
// athlete's local time zone (just without an offset) — reading the date
// part directly avoids any UTC conversion shifting it by a day.
function localDateFromStrava(startDateLocal) {
  return startDateLocal.split('T')[0];
}

// Maps a raw Strava activity `type` to one of the app's 5 parent sports
// (must match PARENT_SPORTS in sports.js). Returns null for unsupported
// types so they're skipped entirely.
function normalizeSport(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('run')) return 'run';
  if (t.includes('ride') || t.includes('bike') || t.includes('cycling') || t.includes('ebike')) return 'bike';
  if (t.includes('swim')) return 'swim';
  if (t.includes('nordicski') || t.includes('nordic_ski') || t === 'crosscountryskiing') return 'xc ski';
  if (t.includes('backcountry') || t.includes('alpineski') || t.includes('snowboard')) return 'backcountry ski';
  return null;
}

// Rough per-sport weighting for body load — how hard a minute of this
// sport tends to be on the body, independent of heart rate.
const BODY_IMPACT = {
  run: 1.0,
  bike: 0.5,
  swim: 0.8,
  'xc ski': 0.9,
  'backcountry ski': 1.0
};

// Pick the most appropriate duration for a lap's load calc. If the athlete
// paused for more than PAUSE_THRESHOLD of the lap's elapsed time, use
// moving_time (HR/effort was only really happening while active).
function effectiveDurationSec(lap) {
  const elapsed = safeNum(lap.elapsed_time);
  const moving = safeNum(lap.moving_time);
  if (!elapsed) return moving;
  if (!moving) return elapsed;
  const pauseFraction = (elapsed - moving) / elapsed;
  return pauseFraction > PAUSE_THRESHOLD ? moving : elapsed;
}

// Simple body load: time-on-feet weighted by sport, with a small bump for
// climbing within that lap. Deliberately basic — refine later once real
// lap data is flowing through.
function computeBodyLoad(sport, durationMin, elevationGainM) {
  const impact = BODY_IMPACT[sport] ?? 1.0;
  const climbBonus = 1 + Math.min(elevationGainM / 1000, 2) * 0.3; // cap the bonus
  return safeNum(durationMin * impact * climbBonus);
}

// Simple HR load: linear interpolation of a load multiplier across the
// athlete's Easy/AP1/AP2/AP3 zone anchors (profiles.hr_zones[sport]),
// then load = duration * multiplier.
function computeHrLoad(sport, durationMin, avgHr, hrZones) {
  const z = hrZones?.[sport];
  if (!avgHr || !z || !z.easy || !z.ap1 || !z.ap2 || !z.ap3) return { load: 0, zone: 0 };

  const points = [
    { hr: 0, m: 0 },
    { hr: z.easy, m: 1 },
    { hr: z.ap1, m: 2 },
    { hr: z.ap2, m: 3 },
    { hr: z.ap3, m: 4 }
  ];

  let multiplier;
  let zone;
  if (avgHr >= points[points.length - 1].hr) {
    // Above AP3 — extrapolate a bit past the last multiplier rather than
    // capping, so hard efforts still register as harder.
    const a = points[points.length - 2], b = points[points.length - 1];
    const t = (avgHr - a.hr) / (b.hr - a.hr);
    multiplier = b.m + (t - 1) * (b.m - a.m);
    zone = 5;
  } else {
    multiplier = points[0].m;
    zone = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      if (avgHr >= a.hr && avgHr <= b.hr) {
        const t = (avgHr - a.hr) / (b.hr - a.hr);
        multiplier = a.m + t * (b.m - a.m);
        zone = i === 0 ? 1 : i + 1;
        break;
      }
    }
  }

  return { load: safeNum(durationMin * Math.max(0, multiplier)), zone };
}

// Compute load for a single lap. Returns both the load numbers AND a
// trimmed-down record of the lap itself worth keeping around.
function calcLapLoad(lap, sport, hrZones) {
  const durationSec = effectiveDurationSec(lap);
  const durationMin = durationSec / 60;
  const avgHr = safeNum(lap.average_heartrate);
  const elevationGainM = safeNum(lap.total_elevation_gain);
  const distanceM = safeNum(lap.distance);

  const bodyLoad = Math.round(computeBodyLoad(sport, durationMin, elevationGainM) * 10) / 10;
  const { load: hrLoad, zone } = computeHrLoad(sport, durationMin, avgHr, hrZones);

  return {
    lap_index: safeNum(lap.lap_index, lap.split ?? 0),
    duration_s: safeNum(durationSec),
    distance_m: distanceM,
    avg_hr: avgHr || null,
    elevation_gain_m: elevationGainM,
    hr_load: Math.round(hrLoad * 10) / 10,
    body_load: bodyLoad,
    zone
  };
}

async function fetchLapsForActivity(activityId, accessToken) {
  try {
    const res = await fetch(`https://www.strava.com/api/v3/activities/${activityId}/laps`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) {
      console.error(`Failed to fetch laps for activity ${activityId}`, res.status, await res.text());
      return [];
    }
    return await res.json();
  } catch (err) {
    console.error(`Failed to fetch laps for activity ${activityId}`, err);
    return [];
  }
}

function sumLapLoads(lapLoads) {
  let hr = 0;
  let body = 0;
  for (const l of lapLoads) {
    hr += safeNum(l.hr_load);
    body += safeNum(l.body_load);
  }
  return { hr_load: Math.round(hr), body_load: Math.round(body) };
}

async function loadHrZones(userId) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('hr_zones')
    .eq('id', userId)
    .single();
  if (error) return {};
  return data?.hr_zones || {};
}

// Find an existing planned session on the same date + sport that doesn't
// already have a linked activity, and return its id (or null).
async function findMatchingSession(userId, dateStr, sport) {
  const { data: sessions, error } = await supabaseAdmin
    .from('sessions')
    .select('id, time')
    .eq('user_id', userId)
    .eq('date', dateStr)
    .eq('sport_type', sport);

  if (error || !sessions || sessions.length === 0) return null;

  const { data: linked } = await supabaseAdmin
    .from('activities')
    .select('session_id')
    .in('session_id', sessions.map(s => s.id));

  const linkedIds = new Set((linked || []).map(l => l.session_id));
  const candidates = sessions.filter(s => !linkedIds.has(s.id));
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.time.localeCompare(b.time));
  return candidates[0].id;
}

async function updateStravaDescription(activityId, accessToken, bodyLoad, hrLoad) {
  try {
    const res = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const activity = await res.json();
    const currentDesc = activity.description || '';

    const signature = '— ndureplan.app';
    if (currentDesc.includes(signature)) return; // already appended

    const appendBlock = `\n\nBody Load: ${bodyLoad}\nHeart Rate Load: ${hrLoad}\n${signature}`;
    const newDescription = currentDesc ? currentDesc + appendBlock : appendBlock.trim();

    const putRes = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ description: newDescription })
    });

    if (!putRes.ok) {
      console.error('Strava description update failed', putRes.status, await putRes.text());
    }
  } catch (err) {
    // Non-critical — don't fail the whole sync over a description update
    console.error('updateStravaDescription failed', err);
  }
}

async function refreshToken(userId, refreshTokenStr) {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshTokenStr
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to refresh Strava token');

  await supabaseAdmin.from('strava_tokens').upsert({
    user_id: userId,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at
  });
  return data.access_token;
}

export default async function handler(req, res) {
  const { user_id, date_from, date_to } = req.query;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });

  try {
    // 1. Get Strava token
    const { data: tokenData, error: tokenError } = await supabaseAdmin
      .from('strava_tokens')
      .select('*')
      .eq('user_id', user_id)
      .single();

    if (tokenError || !tokenData) return res.status(400).json({ error: 'Strava not connected' });

    let accessToken = tokenData.access_token;
    const now = Math.floor(Date.now() / 1000);
    if (tokenData.expires_at < now) {
      accessToken = await refreshToken(user_id, tokenData.refresh_token);
    }

    // 2. Fetch activities (summary list)
    const activitiesUrl = new URL('https://www.strava.com/api/v3/athlete/activities');
    activitiesUrl.searchParams.set('per_page', '50');
    if (date_from) activitiesUrl.searchParams.set('after', Math.floor(new Date(date_from).getTime() / 1000));
    if (date_to) activitiesUrl.searchParams.set('before', Math.floor(new Date(date_to).getTime() / 1000));

    const activitiesRes = await fetch(activitiesUrl.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const activitiesData = await activitiesRes.json();
    if (!activitiesRes.ok) return res.status(activitiesRes.status).json({ error: activitiesData });

    if (activitiesData.length === 50) {
      console.warn(`[fetch-activities] Hit the 50-activity page limit for user ${user_id} — consider adding pagination or narrowing date_from/date_to.`);
    }

    // 3. Skip activities already synced
    const { data: existing, error: existingError } = await supabaseAdmin
      .from('activities')
      .select('activity_uid')
      .eq('user_id', user_id);

    if (existingError) return res.status(500).json({ error: existingError.message });
    const existingIds = new Set((existing ?? []).map(a => String(a.activity_uid)));
    const newActivities = activitiesData.filter(a => !existingIds.has(String(a.id)));

    if (newActivities.length === 0) {
      return res.status(200).json({ message: 'No new activities to sync', synced: 0, matched: 0 });
    }

    const hrZones = await loadHrZones(user_id);
    const supported = newActivities
      .map(activity => ({ activity, sport: normalizeSport(activity.type) }))
      .filter(({ sport }) => sport !== null);

    // 4. Fetch laps + compute per-lap loads for each activity
    const rows = [];
    let matchedCount = 0;

    for (const { activity, sport } of supported) {
      const laps = await fetchLapsForActivity(activity.id, accessToken);
      const dateStr = localDateFromStrava(activity.start_date_local);

      let lapsLoads;
      if (laps.length > 0) {
        lapsLoads = laps.map(lap => calcLapLoad(lap, sport, hrZones));
      } else {
        // No lap data available (e.g. manual entry) — fall back to
        // treating the whole activity as a single "lap".
        lapsLoads = [calcLapLoad({
          lap_index: 1,
          elapsed_time: activity.elapsed_time,
          moving_time: activity.moving_time,
          distance: activity.distance,
          average_heartrate: activity.average_heartrate,
          total_elevation_gain: activity.total_elevation_gain
        }, sport, hrZones)];
      }

      const totals = sumLapLoads(lapsLoads);
      const sessionId = await findMatchingSession(user_id, dateStr, sport);
      if (sessionId) matchedCount++;

      rows.push({
        user_id,
        session_id: sessionId,
        activity_uid: String(activity.id),
        name: activity.name || '',
        type: activity.type,
        sport_type: sport,
        date: dateStr,
        distance_m: safeNum(activity.distance),
        duration_s: safeNum(activity.moving_time),
        elevation_gain_m: safeNum(activity.total_elevation_gain),
        avg_hr: safeNum(activity.average_heartrate) || null,
        hr_load: totals.hr_load,
        body_load: totals.body_load,
        laps: laps.map(l => ({
          lap_index: l.lap_index ?? l.split,
          elapsed_time: l.elapsed_time,
          moving_time: l.moving_time,
          distance: l.distance,
          average_heartrate: l.average_heartrate,
          total_elevation_gain: l.total_elevation_gain
        })),
        laps_loads: lapsLoads,
        strava_start: activity.start_date
      });

      // Best-effort — don't let a Strava write failure break the sync
      updateStravaDescription(activity.id, accessToken, totals.body_load, totals.hr_load);
    }

    if (rows.length === 0) {
      return res.status(200).json({ message: 'No supported activity types to sync', synced: 0, matched: 0 });
    }

    // 5. Upsert into activities table
    const { data: inserted, error: dbError } = await supabaseAdmin
      .from('activities')
      .upsert(rows, { onConflict: 'user_id,activity_uid' })
      .select();

    if (dbError) return res.status(500).json({ error: dbError.message });

    res.status(200).json({
      synced: inserted?.length ?? rows.length,
      matched: matchedCount
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
