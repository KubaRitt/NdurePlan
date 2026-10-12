// Test double for supabase_api.js: same exports, in-memory data.
// Seeded around "today" with a realistic block of Kuba's training.
// Knobs (set from the test before the page loads):
//   window.__mock = { signedIn, schemaMissing, failWrites, latency, empty }

const cfg = Object.assign({ signedIn: true, schemaMissing: false, failWrites: false, latency: 60, empty: false }, window.__mock || {});
window.__mockState = { calls: [], cfg };

export class SchemaError extends Error {
    constructor(detail) { super('The database needs an update before this can be saved. Run the files in supabase/migrations in the Supabase SQL editor (oldest first).');
        this.detail = detail; this.name = 'SchemaError'; }
}

const wait = (ms = cfg.latency) => new Promise(r => setTimeout(r, ms));
const clone = o => JSON.parse(JSON.stringify(o));
const log = (name, args) => window.__mockState.calls.push({ name, args: clone(args ?? null) });
async function write(name, args) {
    log(name, args);
    await wait();
    if (cfg.failWrites || cfg.failOn === name) throw new Error('Network down (mock)');
}

const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = new Date(); today.setHours(12, 0, 0, 0);
const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
const day = (weekOffset, wd) => { const d = new Date(monday); d.setDate(monday.getDate() + weekOffset * 7 + wd); return iso(d); };

let seq = 1000;
const uid = () => `id-${++seq}`;

const Z = { easy: 158, ap1: 172, ap2: 181, ap3: 195 };
const easy = (min, km, type = 'Easy') => ({ type, intensity: 'easy', duration_s: min * 60, distance_km: km, target_hr: Z.easy });
const thr = reps => ({ type: 'AP2', intensity: 'ap2', duration_s: 360, distance_km: 1.55, target_hr: Z.ap2, repeat: { reps, rest_sec: 60, rest_type: 'moving', rest_intensity: 'easy', rest_target_hr: Z.easy } });
const sprints = n => ({ type: 'Hill sprints', intensity: 'sprint', duration_s: 10, distance_km: null, target_hr: null, repeat: { reps: n, rest_sec: 90, rest_type: 'standing' } });
const two100 = n => ({ type: '200 m', intensity: 'ap3', duration_s: 35, distance_km: 0.2, target_hr: Z.ap3, repeat: { reps: n, rest_sec: 120, rest_type: 'moving', rest_intensity: 'easy', rest_target_hr: Z.easy } });
const ap1 = (reps, min) => ({ type: 'AP1', intensity: 'ap1', duration_s: min * 60, distance_km: 2.4, target_hr: Z.ap1, repeat: { reps, rest_sec: 180, rest_type: 'moving', rest_intensity: 'easy', rest_target_hr: Z.easy } });
const gym = () => ({ type: 'Spanish squats, side planks, band walks, calf raises', intensity: 'strength', duration_s: 1800, rpe: 6 });
const S = (date, discipline, sport_type, description, blocks, extra = {}) => ({
    id: uid(), user_id: 'u1', date, time: null, discipline, sport_type, description, blocks,
    done: false, rpe: null, actual: null, notes: null, created_at: `${date}T08:00:00Z`, ...extra
});

let sessions = [];
let diary = [];
if (!cfg.empty) {
    for (const w of [-2, -1]) {
        sessions.push(
            S(day(w, 0), 'Road Run', 'run', 'Easy + strides', [easy(40, 8.5), { type: 'Strides', intensity: 'sprint', duration_s: 20, repeat: { reps: 6, rest_sec: 60, rest_type: 'standing' } }], { done: true, rpe: 3 }),
            S(day(w, 1), 'Road Run', 'run', 'Threshold 4 × 6 min', [easy(15, 3, 'Warm up'), thr(4), easy(15, 3, 'Cool down')], { done: true, rpe: 7, actual: { duration_s: 3720, km: 13.1, hr: 168 }, time: '16:30:00' }),
            S(day(w, 2), 'Strength', 'strength', 'Strength: hips, knees, calves', [gym()], { done: true, rpe: 6 }),
            S(day(w, 3), 'Track', 'run', 'Hill sprints + 200s', [easy(15, 3, 'Warm up'), sprints(8), two100(8), easy(12, 2.5, 'Cool down')], { done: true, rpe: 8 }),
            S(day(w, 4), 'Road Run', 'run', 'Easy', [easy(35, 7)], { done: w === -2 }),
            S(day(w, 6), 'Trail Run', 'run', 'Long run with AP1', [easy(45, 9.5, 'Easy on trails'), ap1(2, 10), easy(10, 2, 'Easy home')], { done: true, rpe: 5 })
        );
    }
    diary.push(
        { user_id: 'u1', date: day(-1, 1), sleep_h: 8, legs: 'normal', pain: 1, notes: null, rest_hr: 48 },
        { user_id: 'u1', date: day(-1, 3), sleep_h: 7.5, legs: 'heavy', pain: 2, notes: 'Last 200 felt slow', rest_hr: 50 }
    );
    // this week: race week
    sessions.push(
        S(day(0, 0), 'Road Run', 'run', 'Easy + strides', [easy(40, 8.5), { type: 'Strides', intensity: 'sprint', duration_s: 20, repeat: { reps: 6, rest_sec: 60, rest_type: 'standing' } }], { done: true, rpe: 3 }),
        S(day(0, 1), 'Road Run', 'run', 'Threshold (short, race week)', [easy(15, 3, 'Warm up'), thr(3), easy(12, 2.5, 'Cool down')], { done: true, rpe: 6, time: '16:30:00' }),
        S(day(0, 2), 'Indoor Trainer', 'bike', 'Easy spin', [{ type: 'Spin', intensity: 'easy', duration_s: 2700, target_hr: 150 }], { time: '16:00:00' }),
        S(day(0, 2), 'Strength', 'strength', 'Strength: hips, knees, calves', [gym()], { time: '18:00:00' }),
        S(day(0, 3), 'Track', 'run', 'Speed: hill sprints + 200s', [easy(15, 3, 'Warm up'), sprints(6), two100(6), easy(12, 2.5, 'Cool down')]),
        S(day(0, 4), 'Road Run', 'run', 'Shakeout', [easy(25, 5)]),
        S(day(0, 5), 'Orienteering', 'run', 'Race: middle distance', [easy(20, 3.5, 'Warm up'), { type: 'Race', intensity: 'ap3', duration_s: 2400, distance_km: 7, target_hr: Z.ap3 }], { time: '10:30:00' }),
        S(day(0, 6), 'Orienteering', 'run', 'Race: relay', [easy(15, 3, 'Warm up'), { type: 'Relay leg', intensity: 'ap3', duration_s: 2100, distance_km: 6, target_hr: Z.ap3 }], { time: '09:30:00' })
    );
    diary.push({ user_id: 'u1', date: day(0, 1), sleep_h: 8.5, legs: 'fresh', pain: 3, notes: 'Knee a bit sore after cool-down', rest_hr: 47 });
    // next week: recovery
    sessions.push(
        S(day(1, 1), 'Road Run', 'run', 'Easy', [easy(30, 6)]),
        S(day(1, 3), 'Road Bike', 'bike', 'Easy ride', [{ type: 'Easy', intensity: 'easy', duration_s: 3600, distance_km: 25, target_hr: 150 }]),
        S(day(1, 6), 'Trail Run', 'run', 'Easy long', [easy(50, 10)])
    );
}
let templates = [];
let profile = { email: 'athlete@example.com', hr_zones: { run: Z, bike: { easy: 150, ap1: 163, ap2: 172, ap3: 185 }, swim: { easy: 145, ap1: 158, ap2: 167, ap3: 180 }, 'xc ski': { easy: 155, ap1: 168, ap2: 178, ap3: 190 }, 'backcountry ski': { easy: 150, ap1: 163, ap2: 172, ap3: 185 } } };
let activities = [];
window.__mockState.db = () => ({ sessions: clone(sessions), diary: clone(diary), templates: clone(templates), profile: clone(profile), activities: clone(activities) });

const SESSION_FIELDS = ['sport_type', 'discipline', 'orienteering', 'date', 'time', 'blocks', 'description', 'done', 'rpe', 'actual', 'notes'];
const pick = o => { const out = {}; SESSION_FIELDS.forEach(k => { if (k in o) out[k] = o[k]; }); return out; };
const schema = () => { if (cfg.schemaMissing) throw new SchemaError("Could not find the 'done' column of 'sessions' in the schema cache"); };

export const supabase = {};
export async function signUpAthlete() { return { session: null }; }
export async function signInAthlete() { return {}; }
export async function signOutAthlete() { log('signOut'); }
export async function getAuthSession() { return cfg.signedIn ? { user: { id: 'u1', email: profile.email } } : null; }
export async function fetchProfile() { log('fetchProfile'); await wait(); return clone(profile); }
export async function saveHrZones(z) { await write('saveHrZones', z); profile.hr_zones = clone(z); }
export async function fetchSessions(a, b) { log('fetchSessions', [a, b]); await wait(); return clone(sessions.filter(s => s.date >= a && s.date <= b)); }
export async function createSessions(ps) {
    await write('createSessions', ps); schema();
    const rows = ps.map(p => ({ id: uid(), user_id: 'u1', created_at: new Date().toISOString(), done: false, orienteering: false, rpe: null, actual: null, notes: null, ...pick(p) }));
    sessions.push(...rows); return clone(rows);
}
export async function createSession(p) { const [r] = await createSessions([p]); return r; }
export async function updateSession(id, patch) {
    await write('updateSession', { id, patch }); schema();
    const i = sessions.findIndex(s => s.id === id);
    if (i < 0) throw new Error('not found');
    sessions[i] = { ...sessions[i], ...pick(patch) };
    return clone(sessions[i]);
}
export async function deleteSessions(ids) {
    await write('deleteSessions', ids);
    sessions = sessions.filter(s => !ids.includes(s.id));
    activities.forEach(a => { if (ids.includes(a.session_id)) a.session_id = null; }); // on delete set null
}
export async function fetchDiary(a, b) { log('fetchDiary', [a, b]); await wait(); if (cfg.schemaMissing) throw new SchemaError("Could not find the table 'public.diary'"); return clone(diary.filter(d => d.date >= a && d.date <= b)); }
export async function upsertDiary(e) {
    await write('upsertDiary', e); schema();
    const row = { user_id: 'u1', ...e };
    const i = diary.findIndex(d => d.date === e.date);
    if (i >= 0) diary[i] = { ...diary[i], ...row }; else diary.push(row);
    return clone(diary.find(d => d.date === e.date));
}
export async function fetchTemplates() { log('fetchTemplates'); await wait(); if (cfg.schemaMissing) throw new SchemaError("Could not find the table 'public.templates'"); return clone(templates); }
export async function createTemplate(t) { await write('createTemplate', t); schema(); const row = { id: uid(), user_id: 'u1', created_at: new Date().toISOString(), ...clone(t) }; templates.push(row); return clone(row); }
export async function deleteTemplate(id) { await write('deleteTemplate', id); templates = templates.filter(t => t.id !== id); }

// Activities (uploaded FIT files)
export const ACTIVITY_FIELDS = 'all but pieces';
const noPieces = a => { const { pieces, ...rest } = a; return rest; };
export async function fetchActivities(a, b) { log('fetchActivities', [a, b]); await wait(); return clone(activities.filter(x => x.date >= a && x.date <= b).map(noPieces)); }
export async function findActivitiesByUid(uids) { log('findActivitiesByUid', uids); await wait(); return clone(activities.filter(a => uids.includes(a.activity_uid)).map(a => ({ id: a.id, activity_uid: a.activity_uid, session_id: a.session_id, date: a.date }))); }
export async function createActivities(rows) {
    await write('createActivities', rows.map(noPieces));
    for (const r of rows) {
        if (activities.some(a => a.activity_uid === r.activity_uid)) throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
        if (r.session_id && !sessions.some(s => s.id === r.session_id)) throw new Error('new row violates row-level security policy');
    }
    const out = rows.map(r => ({ id: uid(), user_id: 'u1', created_at: new Date().toISOString(), ...clone(r) }));
    activities.push(...out);
    return clone(out.map(noPieces));
}
export async function updateActivity(id, patch) {
    await write('updateActivity', { id, patch: noPieces(patch) });
    const a = activities.find(x => x.id === id); if (!a) throw new Error('not found');
    Object.assign(a, clone(patch)); return clone(noPieces(a));
}
export async function linkActivities(ids, sessionId) { await write('linkActivities', { ids, sessionId }); activities.forEach(a => { if (ids.includes(a.id)) a.session_id = sessionId; }); }
export async function deleteActivities(ids) { await write('deleteActivities', ids); activities = activities.filter(a => !ids.includes(a.id)); }
export async function fetchActivityPieces(ids = null) { log('fetchActivityPieces', ids); await wait(); return clone(activities.filter(a => a.pieces && (!ids || ids.includes(a.id)))); }
export async function saveActivityLoads(rows) {
    await write('saveActivityLoads', rows);
    rows.forEach(r => { const a = activities.find(x => x.id === r.id); if (a) Object.assign(a, clone(r)); });
}
