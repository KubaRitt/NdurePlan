/**
 * NdurePlan - data layer (Supabase)
 *
 * Everything the app reads or writes goes through these functions, so the
 * UI never builds queries itself. Row Level Security on every table makes
 * sure a user only ever sees their own rows; the user_id filters below are
 * there for clarity and index use, not for security.
 *
 * Activities come from FIT files the athlete uploads (no Strava/Garmin API).
 * The old Strava serverless endpoints in /api are not deployed.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://ogikyrfnsaswqwsldkhr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9naWt5cmZuc2Fzd3F3c2xka2hyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0NDAwNzUsImV4cCI6MjA5NzAxNjA3NX0.a00mYAiTDWqm5R3VEoO3cUmwjbnXfePoHGSsfpVKLAE';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/** Thrown when a table or column the app needs doesn't exist yet. */
export class SchemaError extends Error {
    constructor(detail) {
        super('The database needs an update before this can be saved. Run the files in supabase/migrations in the Supabase SQL editor (oldest first).');
        this.detail = detail;
        this.name = 'SchemaError';
    }
}

function isSchemaProblem(error) {
    const code = error && error.code;
    if (['PGRST204', 'PGRST205', '42P01', '42703'].includes(code)) return true;
    return /could not find the .* (column|table)|does not exist/i.test((error && error.message) || '');
}

function check(error) {
    if (!error) return;
    if (isSchemaProblem(error)) throw new SchemaError(error.message);
    throw error;
}

let cachedUserId = null;
supabase.auth.onAuthStateChange((_event, session) => {
    cachedUserId = session ? session.user.id : null;
});

async function userId() {
    if (cachedUserId) return cachedUserId;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not signed in.');
    cachedUserId = session.user.id;
    return cachedUserId;
}

// --------------------------------------------------------------------------
// Auth
// --------------------------------------------------------------------------

export async function signUpAthlete(email, password) {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
    return data;
}

export async function signInAthlete(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
}

export async function signOutAthlete() {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
}

/** Current session or null (no network call). */
export async function getAuthSession() {
    const { data: { session } } = await supabase.auth.getSession();
    return session;
}

// --------------------------------------------------------------------------
// Profile / HR zones
// --------------------------------------------------------------------------

export async function fetchProfile() {
    const id = await userId();
    const { data, error } = await supabase.from('profiles').select('email, hr_zones').eq('id', id).maybeSingle();
    check(error);
    return data || { email: null, hr_zones: null };
}

export async function saveHrZones(hrZones) {
    const id = await userId();
    const { error } = await supabase.from('profiles')
        .update({ hr_zones: hrZones, updated_at: new Date().toISOString() })
        .eq('id', id);
    check(error);
}

// --------------------------------------------------------------------------
// Sessions
// --------------------------------------------------------------------------

const SESSION_FIELDS = ['sport_type', 'discipline', 'orienteering', 'date', 'time', 'blocks', 'description', 'done', 'rpe', 'actual', 'notes'];

function pickSessionFields(obj) {
    const out = {};
    SESSION_FIELDS.forEach(k => { if (k in obj) out[k] = obj[k]; });
    if ('time' in out && !out.time) out.time = null;
    return out;
}

export async function fetchSessions(fromDate, toDate) {
    const id = await userId();
    const { data, error } = await supabase.from('sessions')
        .select('*')
        .eq('user_id', id)
        .gte('date', fromDate)
        .lte('date', toDate)
        .order('date', { ascending: true })
        .order('time', { ascending: true, nullsFirst: false });
    check(error);
    return data || [];
}

export async function createSessions(payloads) {
    if (!payloads.length) return [];
    const id = await userId();
    const rows = payloads.map(p => ({ ...pickSessionFields(p), user_id: id }));
    const { data, error } = await supabase.from('sessions').insert(rows).select();
    check(error);
    return data || [];
}

export async function createSession(payload) {
    const [row] = await createSessions([payload]);
    return row;
}

export async function updateSession(sessionId, patch) {
    const id = await userId();
    const { data, error } = await supabase.from('sessions')
        .update(pickSessionFields(patch))
        .eq('id', sessionId)
        .eq('user_id', id)
        .select()
        .single();
    check(error);
    return data;
}

export async function deleteSessions(sessionIds) {
    if (!sessionIds.length) return;
    const id = await userId();
    const { error } = await supabase.from('sessions').delete().in('id', sessionIds).eq('user_id', id);
    check(error);
}

// --------------------------------------------------------------------------
// Diary (one row per day)
// --------------------------------------------------------------------------

const DIARY_FIELDS = ['date', 'sleep_h', 'rest_hr', 'legs', 'pain', 'notes'];

export async function fetchDiary(fromDate, toDate) {
    const id = await userId();
    const { data, error } = await supabase.from('diary')
        .select('*')
        .eq('user_id', id)
        .gte('date', fromDate)
        .lte('date', toDate);
    check(error);
    return data || [];
}

export async function upsertDiary(entry) {
    const id = await userId();
    const row = { user_id: id };
    DIARY_FIELDS.forEach(k => { if (k in entry) row[k] = entry[k] === '' ? null : entry[k]; });
    const { data, error } = await supabase.from('diary')
        .upsert(row, { onConflict: 'user_id,date' })
        .select()
        .single();
    check(error);
    return data;
}

// --------------------------------------------------------------------------
// Templates
// --------------------------------------------------------------------------

export async function fetchTemplates() {
    const id = await userId();
    const { data, error } = await supabase.from('templates')
        .select('*')
        .eq('user_id', id)
        .order('created_at', { ascending: true });
    check(error);
    return data || [];
}

export async function createTemplate({ name, sport_type, discipline = '', description = '', blocks = [] }) {
    const id = await userId();
    const { data, error } = await supabase.from('templates')
        .insert({ user_id: id, name, sport_type, discipline, description, blocks })
        .select()
        .single();
    check(error);
    return data;
}

export async function deleteTemplate(templateId) {
    const id = await userId();
    const { error } = await supabase.from('templates').delete().eq('id', templateId).eq('user_id', id);
    check(error);
}

// --------------------------------------------------------------------------
// Activities (uploaded FIT files)
// --------------------------------------------------------------------------

// Everything except the 10-second pieces, which are only needed to recalculate.
export const ACTIVITY_FIELDS = 'id, session_id, link_order, activity_uid, name, type, sport_type, sub_sport, date, start_time, duration_s, elapsed_s, moving_s, paused_s, excluded_s, distance_m, elevation_gain_m, descent_m, avg_hr, max_hr, hr_load, body_load, laps, surface, device, hr_quality, source, file_name, calc';
const ACTIVITY_WRITE = ['session_id', 'link_order', 'activity_uid', 'name', 'type', 'sport_type', 'sub_sport', 'date', 'start_time', 'duration_s', 'elapsed_s', 'moving_s', 'paused_s', 'excluded_s', 'distance_m', 'elevation_gain_m', 'descent_m', 'avg_hr', 'max_hr', 'hr_load', 'body_load', 'laps', 'surface', 'device', 'hr_quality', 'source', 'file_name', 'calc', 'pieces'];

function pickActivity(obj) {
    const out = {};
    ACTIVITY_WRITE.forEach(k => { if (k in obj) out[k] = obj[k]; });
    return out;
}

function chunks(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

export async function fetchActivities(fromDate, toDate) {
    const id = await userId();
    const { data, error } = await supabase.from('activities')
        .select(ACTIVITY_FIELDS)
        .eq('user_id', id)
        .gte('date', fromDate)
        .lte('date', toDate)
        .order('start_time', { ascending: true });
    check(error);
    return data || [];
}

/** Which of these files are already stored (to skip duplicates or relink orphans). */
export async function findActivitiesByUid(uids) {
    if (!uids.length) return [];
    const id = await userId();
    const out = [];
    for (const part of chunks(uids, 100)) {
        const { data, error } = await supabase.from('activities')
            .select('id, activity_uid, session_id, date')
            .eq('user_id', id)
            .in('activity_uid', part);
        check(error);
        out.push(...(data || []));
    }
    return out;
}

export async function createActivities(rows) {
    if (!rows.length) return [];
    const id = await userId();
    const out = [];
    for (const part of chunks(rows, 50)) {
        const { data, error } = await supabase.from('activities')
            .insert(part.map(r => ({ ...pickActivity(r), user_id: id })))
            .select(ACTIVITY_FIELDS);
        check(error);
        out.push(...(data || []));
    }
    return out;
}

export async function updateActivity(activityId, patch) {
    const id = await userId();
    const { data, error } = await supabase.from('activities')
        .update(pickActivity(patch))
        .eq('id', activityId)
        .eq('user_id', id)
        .select(ACTIVITY_FIELDS)
        .single();
    check(error);
    return data;
}

/** Link several activities to a session (or unlink with null). */
export async function linkActivities(ids, sessionId) {
    if (!ids.length) return;
    const id = await userId();
    const { error } = await supabase.from('activities').update({ session_id: sessionId }).in('id', ids).eq('user_id', id);
    check(error);
}

export async function deleteActivities(ids) {
    if (!ids.length) return;
    const id = await userId();
    for (const part of chunks(ids, 100)) {
        const { error } = await supabase.from('activities').delete().in('id', part).eq('user_id', id);
        check(error);
    }
}

/**
 * Activities with their pieces, for recalculating loads.
 * @param ids  only these; omit for all of the athlete's activities (paged)
 */
export async function fetchActivityPieces(ids = null) {
    const id = await userId();
    const cols = 'id, session_id, activity_uid, date, sport_type, surface, hr_quality, laps, calc, pieces';
    const out = [];
    if (ids) {
        for (const part of chunks(ids, 100)) {
            const { data, error } = await supabase.from('activities').select(cols).eq('user_id', id).in('id', part);
            check(error);
            out.push(...(data || []));
        }
        return out;
    }
    for (let from = 0; ; from += 200) {
        const { data, error } = await supabase.from('activities').select(cols).eq('user_id', id)
            .not('pieces', 'is', null).order('date', { ascending: true }).order('id', { ascending: true }).range(from, from + 199);
        check(error);
        out.push(...(data || []));
        if (!data || data.length < 200) break;
    }
    return out;
}

/** Save recalculated loads: [{ id, hr_load, body_load, laps, surface, sport_type, calc }]. */
export async function saveActivityLoads(rows) {
    const id = await userId();
    for (const r of rows) {
        const { id: actId, ...patch } = r;
        const { error } = await supabase.from('activities').update(pickActivity(patch)).eq('id', actId).eq('user_id', id);
        check(error);
    }
}
