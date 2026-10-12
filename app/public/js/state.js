// NdurePlan - app state and actions.
// Views read `state`; every change goes through the functions below, which
// update state first (so the UI responds at once), then save, and roll back
// with a message if saving fails.

import * as api from '../supabase_api.js';
import * as M from './model.js';
import { DEFAULT_HR_ZONES, HR_SPORTS, getParentSportForDiscipline } from '../sports.js';
import { surfaceOf, legsFactor } from './loads.js';
import { loadsFromPieces, encodePieces, decodePieces } from './fit/analyze.js';
import { debounce, readLocal, writeLocal } from './ui/util.js';

export const state = {
    email: null,
    zones: JSON.parse(JSON.stringify(DEFAULT_HR_ZONES)),
    sessions: new Map(), // id -> session row
    activities: new Map(), // id -> activity row (uploaded FIT file, without pieces)
    diary: new Map(),    // 'YYYY-MM-DD' -> diary row
    templates: [],
    range: null,         // { from, to } dates already loaded
    today: M.todayISO(),
    selected: M.todayISO(),
    view: 'plan',        // 'plan' | 'today' | 'settings'
    dayTab: {},          // date -> 'plan' | 'diary' (last tab used per day)
    density: readLocal('ndure.density', 'detailed'),
    theme: readLocal('ndure.theme', 'system'),
    schemaError: null,
    loadError: null,
    loading: true
};

// ---------------------------------------------------------------------------
// Change notification
//   'data'    something structural changed: re-render everything
//   'passive' diary typing: re-render lists/summaries, leave open forms alone
//   'ui'      selection, view, density, banners
// ---------------------------------------------------------------------------

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(kind = 'data') { listeners.forEach(fn => fn(kind)); }

let hooks = { toast: () => {}, status: () => {} };
export function setHooks(h) { hooks = { ...hooks, ...h }; }

// ---------------------------------------------------------------------------
// Save tracking (drives the "Saving… / Saved" text)
// ---------------------------------------------------------------------------

let inFlight = 0;
let lastError = null;

async function track(promise) {
    inFlight++;
    hooks.status('saving');
    try {
        const r = await promise;
        lastError = null;
        return r;
    } catch (err) {
        lastError = err;
        throw err;
    } finally {
        inFlight--;
        if (inFlight === 0) hooks.status(lastError ? 'error' : 'saved');
    }
}

function handleError(err, what) {
    console.error(what, err);
    if (err instanceof api.SchemaError) {
        state.schemaError = err.message;
        emit('ui');
        hooks.toast({ text: 'Not saved: the database needs an update (see the banner).' });
        return;
    }
    hooks.toast({ text: `Couldn't ${what}. Check your connection and try again.` });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function allSessions() { return Array.from(state.sessions.values()); }

export function sessionsOn(date) {
    return allSessions().filter(s => s.date === date).sort(M.compareSessions);
}

export function diaryOn(date) { return state.diary.get(date) || null; }

export function zonesFor(sport) {
    return state.zones[sport] || state.zones.run || DEFAULT_HR_ZONES.run;
}

/** FIT files linked to a session, in the order they were recorded. */
export function activitiesFor(sessionId) {
    const out = [];
    state.activities.forEach(a => { if (a.session_id === sessionId) out.push(a); });
    return out.sort((a, b) => (a.link_order ?? 0) - (b.link_order ?? 0) || String(a.start_time).localeCompare(String(b.start_time)));
}

function activitiesBySession() {
    const m = new Map();
    state.activities.forEach(a => {
        if (!a.session_id) return;
        if (!m.has(a.session_id)) m.set(a.session_id, []);
        m.get(a.session_id).push(a);
    });
    return m;
}

export function planOf(s) { return M.sessionPlan(s, state.zones); }
export function doneOf(s) { return M.sessionDone(s, state.zones, activitiesFor(s.id)); }

export function weekStats(monday) {
    return M.weekStats(monday, allSessions(), state.diary, { zones: state.zones, acts: activitiesBySession() });
}

export function weekFlags(monday) {
    return M.weekFlags(weekStats(monday), weekStats(M.addDays(monday, -7)));
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

let loadChain = Promise.resolve();

function mergeRows(sessions, diary, activities) {
    sessions.forEach(s => state.sessions.set(s.id, s));
    diary.forEach(d => state.diary.set(d.date, d));
    activities.forEach(a => state.activities.set(a.id, a));
}

const schemaSoft = err => {
    if (err instanceof api.SchemaError) { state.schemaError = err.message; return []; }
    throw err;
};

async function fetchSpan(from, to) {
    const [sessions, diary, activities] = await Promise.all([
        api.fetchSessions(from, to),
        api.fetchDiary(from, to).catch(schemaSoft),
        api.fetchActivities(from, to).catch(schemaSoft)
    ]);
    mergeRows(sessions, diary, activities);
}

/** Make sure every date between from and to is loaded. Calls are queued. */
export function ensureRange(from, to) {
    loadChain = loadChain.then(async () => {
        let fetched = false;
        const hadError = !!state.loadError;
        try {
            if (!state.range) {
                await fetchSpan(from, to);
                state.range = { from, to };
                fetched = true;
            } else {
                if (from < state.range.from) {
                    await fetchSpan(from, M.addDays(state.range.from, -1));
                    state.range.from = from;
                    fetched = true;
                }
                if (to > state.range.to) {
                    await fetchSpan(M.addDays(state.range.to, 1), to);
                    state.range.to = to;
                    fetched = true;
                }
            }
            state.loadError = null;
        } catch (err) {
            console.error('load', err);
            state.loadError = "Couldn't load your plan. Check your connection and reload.";
        }
        if (fetched || hadError !== !!state.loadError) emit('data');
    });
    return loadChain;
}

export async function init() {
    const profile = await api.fetchProfile().catch(err => { console.error(err); return {}; });
    state.email = profile.email || state.email;
    if (profile.hr_zones) {
        HR_SPORTS.forEach(sp => {
            if (profile.hr_zones[sp]) state.zones[sp] = { ...state.zones[sp], ...profile.hr_zones[sp] };
        });
    }
    const monday = M.mondayOf(state.today);
    await ensureRange(M.addDays(monday, -7 * 8), M.addDays(monday, 7 * 12 + 6));
    try {
        state.templates = await api.fetchTemplates();
    } catch (err) {
        if (err instanceof api.SchemaError) state.schemaError = err.message;
        state.templates = [];
    }
    state.loading = false;
    emit('data');
}

// ---------------------------------------------------------------------------
// Selection / view
// ---------------------------------------------------------------------------

export function select(date, { ensure = true } = {}) {
    state.selected = date;
    if (ensure && state.range && (date < state.range.from || date > state.range.to)) {
        const monday = M.mondayOf(date);
        ensureRange(M.addDays(monday, -7 * 6), M.addDays(monday, 7 * 6 + 6));
    }
    emit('ui');
}

export function setView(view) {
    state.view = view;
    emit('ui');
}

export function setDensity(d) {
    state.density = d;
    writeLocal('ndure.density', d);
    emit('ui');
}

export function setTheme(t) {
    state.theme = t;
    writeLocal('ndure.theme', t);
    emit('ui');
}

export function refreshToday() {
    const t = M.todayISO();
    if (t !== state.today) { state.today = t; emit('ui'); }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function sessionFields(s) {
    return {
        sport_type: s.sport_type,
        discipline: s.discipline || '',
        orienteering: s.sport_type === 'run' && (!!s.orienteering || s.discipline === 'Orienteering'),
        date: s.date,
        time: s.time || null,
        description: s.description || '',
        blocks: (s.blocks || []).map(M.serializeBlock),
        done: !!s.done,
        rpe: s.rpe ?? null,
        actual: s.actual ?? null,
        notes: s.notes ?? null
    };
}

export async function createSession(payload, { undo = true, message } = {}) {
    try {
        const row = await track(api.createSession(sessionFields(payload)));
        state.sessions.set(row.id, row);
        emit('data');
        hooks.toast({
            text: message || `Added “${M.sessionTitle(row)}”`,
            action: undo ? { label: 'Undo', run: () => deleteSession(row.id, { undo: false, quiet: true }) } : null
        });
        return row;
    } catch (err) {
        handleError(err, 'add the session');
        return null;
    }
}

export async function updateSession(id, payload) {
    const before = state.sessions.get(id);
    if (!before) return null;
    const next = { ...before, ...sessionFields({ ...before, ...payload }) };
    state.sessions.set(id, next);
    emit('data');
    try {
        const row = await track(api.updateSession(id, sessionFields(next)));
        state.sessions.set(id, row);
        emit('data');
        if (activitiesFor(id).length && (row.sport_type !== before.sport_type || surfaceOf(row) !== surfaceOf(before))) {
            recalcActivities(activitiesFor(id).map(a => a.id));
        }
        return row;
    } catch (err) {
        state.sessions.set(id, before);
        emit('data');
        handleError(err, 'save the session');
        return null;
    }
}

/** The Orienteering tick on a run (diary or editor). Legs of linked files follow. */
export async function setOrienteering(id, on) {
    const s = state.sessions.get(id);
    if (!s || s.sport_type !== 'run' || s.discipline === 'Orienteering') return;
    return updateSession(id, { orienteering: !!on });
}

export async function deleteSession(id, { undo = true, quiet = false } = {}) {
    const s = state.sessions.get(id);
    if (!s) return;
    const files = activitiesFor(id);
    state.sessions.delete(id);
    files.forEach(a => state.activities.set(a.id, { ...a, session_id: null })); // the database does the same
    emit('data');
    try {
        await track(api.deleteSessions([id]));
    } catch (err) {
        state.sessions.set(id, s);
        files.forEach(a => state.activities.set(a.id, a));
        emit('data');
        handleError(err, 'delete the session');
        return;
    }
    const fileIds = files.map(a => a.id);
    const purge = laterPurge(fileIds);
    if (quiet) { purge.now(); return; }
    hooks.toast({
        text: files.length ? `Deleted “${M.sessionTitle(s)}” and its ${files.length === 1 ? 'file' : `${files.length} files`}` : `Deleted “${M.sessionTitle(s)}”`,
        action: undo ? {
            label: 'Undo',
            run: async () => {
                purge.cancel();
                try {
                    const row = await track(api.createSession(sessionFields(s)));
                    state.sessions.set(row.id, row);
                    if (fileIds.length) {
                        await track(api.linkActivities(fileIds, row.id));
                        files.forEach(a => state.activities.set(a.id, { ...a, session_id: row.id }));
                    }
                    emit('data');
                } catch (err) { handleError(err, 'restore the session'); }
            }
        } : null
    });
}

// Unlinked files are deleted once the Undo has expired.
const UNDO_MS = 8000;
const pendingPurge = new Map(); // activity id -> purge handle
function laterPurge(ids) {
    if (!ids.length) return { cancel() {}, now() {} };
    let done = false;
    const run = async () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // only files still without a session (one may have been imported again meanwhile)
        const gone = ids.filter(i => { const a = state.activities.get(i); return !a || !a.session_id; });
        gone.forEach(i => state.activities.delete(i));
        try { await api.deleteActivities(gone); } catch (err) { console.error('purge', err); }
    };
    const timer = setTimeout(run, UNDO_MS);
    const handle = {
        cancel() { done = true; clearTimeout(timer); ids.forEach(i => { if (pendingPurge.get(i) === handle) pendingPurge.delete(i); }); },
        now: run
    };
    ids.forEach(i => pendingPurge.set(i, handle));
    return handle;
}

export async function duplicateSession(id, date) {
    const s = state.sessions.get(id);
    if (!s) return null;
    return createSession({ ...s, date: date || s.date, done: false, rpe: null, actual: null, notes: null },
        { message: `Copied “${M.sessionTitle(s)}”` });
}

// One tap on the circle: done as planned / not done.
export async function toggleDone(id) {
    const s = state.sessions.get(id);
    if (!s) return;
    pendingSessionSave.get(id)?.flush();
    const before = s.done;
    s.done = !s.done;
    emit('data');
    try {
        await track(api.updateSession(id, { done: s.done }));
    } catch (err) {
        s.done = before;
        emit('data');
        handleError(err, 'save');
    }
}

// Diary fields on a session (done, actual time/km/HR, RPE, notes). Saved after a short pause.
const pendingSessionSave = new Map();

export function patchSessionLog(id, patch) {
    const s = state.sessions.get(id);
    if (!s) return;
    if ('actual' in patch) {
        const a = { ...(s.actual || {}), ...patch.actual };
        Object.keys(a).forEach(k => { if (a[k] === null || a[k] === undefined || a[k] === '') delete a[k]; });
        s.actual = Object.keys(a).length ? a : null;
    }
    ['done', 'rpe', 'notes'].forEach(k => { if (k in patch) s[k] = patch[k]; });
    emit('passive');
    if (!pendingSessionSave.has(id)) {
        pendingSessionSave.set(id, debounce(async () => {
            const cur = state.sessions.get(id);
            if (!cur) return;
            try {
                await track(api.updateSession(id, { done: !!cur.done, rpe: cur.rpe ?? null, actual: cur.actual ?? null, notes: cur.notes || null }));
            } catch (err) { handleError(err, 'save the diary'); }
        }, 700));
    }
    pendingSessionSave.get(id)();
}

// Day diary (sleep, resting HR, legs, pain, notes). Saved after a short pause.
const pendingDiarySave = new Map();

export function patchDiary(date, patch) {
    const row = { ...(state.diary.get(date) || { date }), ...patch };
    state.diary.set(date, row);
    emit('passive');
    if (!pendingDiarySave.has(date)) {
        pendingDiarySave.set(date, debounce(async () => {
            const cur = state.diary.get(date);
            if (!cur) return;
            try {
                const saved = await track(api.upsertDiary(cur));
                // keep anything typed while the request was out
                state.diary.set(date, { ...saved, ...pickDiary(state.diary.get(date)) });
            } catch (err) { handleError(err, 'save the diary'); }
        }, 700));
    }
    pendingDiarySave.get(date)();
}

function pickDiary(r) {
    const out = {};
    ['date', 'sleep_h', 'rest_hr', 'legs', 'pain', 'notes'].forEach(k => { if (r && k in r) out[k] = r[k]; });
    return out;
}

/** Push any waiting diary saves now (page hidden, sheet closed). */
export function flushPending() {
    pendingSessionSave.forEach(d => d.flush());
    pendingDiarySave.forEach(d => d.flush());
}

export function hasPending() {
    return inFlight > 0 || [...pendingSessionSave.values(), ...pendingDiarySave.values()].some(d => d.pending());
}

// ---------------------------------------------------------------------------
// Weeks
// ---------------------------------------------------------------------------

export async function copyWeek(sourceMonday, destMonday, { skipPlannedDays = true } = {}) {
    await ensureRange(sourceMonday, M.addDays(destMonday, 6));
    const payloads = M.copyWeekPayloads(sourceMonday, destMonday, allSessions(), { skipPlannedDays });
    if (!payloads.length) {
        hooks.toast({ text: skipPlannedDays ? 'Nothing to copy: that week is empty or these days are already planned.' : 'Nothing to copy: that week is empty.' });
        return 0;
    }
    try {
        const rows = await track(api.createSessions(payloads));
        rows.forEach(r => state.sessions.set(r.id, r));
        emit('data');
        hooks.toast({
            text: `Copied ${rows.length} session${rows.length === 1 ? '' : 's'}`,
            action: {
                label: 'Undo',
                run: async () => {
                    const ids = rows.map(r => r.id);
                    ids.forEach(id => state.sessions.delete(id));
                    emit('data');
                    try { await track(api.deleteSessions(ids)); } catch (err) { handleError(err, 'undo the copy'); }
                }
            }
        });
        return rows.length;
    } catch (err) {
        handleError(err, 'copy the week');
        return 0;
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function saveZones(zones) {
    const before = state.zones;
    state.zones = zones;
    emit('ui');
    try {
        await track(api.saveHrZones(zones));
        hooks.toast({ text: 'Zones saved' });
        const n = await recalcActivities(null);
        if (n) hooks.toast({ text: `Zones saved. Loads recalculated for ${n} file${n === 1 ? '' : 's'}.` });
        return true;
    } catch (err) {
        state.zones = before;
        emit('ui');
        handleError(err, 'save the zones');
        return false;
    }
}

export async function saveTemplate(name, session) {
    try {
        const row = await track(api.createTemplate({
            name: name.trim().slice(0, 60),
            sport_type: session.sport_type,
            discipline: session.discipline || '',
            description: session.description || '',
            blocks: (session.blocks || []).map(M.serializeBlock)
        }));
        state.templates.push(row);
        emit('ui');
        hooks.toast({ text: `Saved template “${row.name}”` });
        return row;
    } catch (err) {
        handleError(err, 'save the template');
        return null;
    }
}

export async function deleteTemplate(id) {
    const before = state.templates;
    const t = before.find(x => x.id === id);
    state.templates = before.filter(x => x.id !== id);
    emit('ui');
    try {
        await track(api.deleteTemplate(id));
        if (t) hooks.toast({ text: `Deleted template “${t.name}”` });
    } catch (err) {
        state.templates = before;
        emit('ui');
        handleError(err, 'delete the template');
    }
}

export async function signOut() {
    flushPending();
    try { await api.signOutAthlete(); } catch (err) { console.error(err); }
    window.location.href = 'login.html';
}

// ---------------------------------------------------------------------------
// FIT files
// ---------------------------------------------------------------------------

const round1 = v => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

// Legs effort per minute the plan expects (used when a file has no usable HR).
export function planEffort(session) {
    const p = planOf(session);
    if (!(p.duration_s > 0) || session.sport_type === 'strength') return 1;
    const e = (p.legs / (p.duration_s / 60)) / legsFactor(session.sport_type, surfaceOf(session));
    return Math.min(1.3, Math.max(0.5, e));
}

/** Database row for an import item linked to `session`. */
export function activityRow(item, session, order) {
    const sport = session.sport_type;
    const zones = zonesFor(sport);
    const surface = surfaceOf(session);
    const fallback = planEffort(session);
    const loads = loadsFromPieces(item.pieces, item.laps, { sport, zones, surface, hrQuality: item.hrQuality, fallbackEffort: fallback });
    const T = item.totals;
    return {
        session_id: session.id,
        link_order: order,
        activity_uid: item.uid,
        name: item.label,
        type: item.label,
        sport_type: sport,
        sub_sport: item.fitSubSport === null || item.fitSubSport === undefined ? null : String(item.fitSubSport),
        date: item.date,
        start_time: new Date(item.start * 1000).toISOString(),
        duration_s: T.counted_s,
        elapsed_s: T.elapsed_s,
        moving_s: T.moving_s,
        paused_s: T.paused_s,
        excluded_s: T.excluded_s,
        distance_m: T.distance_m ?? 0,
        elevation_gain_m: T.ascent_m ?? 0,
        descent_m: T.descent_m,
        avg_hr: T.avg_hr,
        max_hr: T.max_hr,
        hr_load: loads.heart,
        body_load: loads.legs,
        laps: item.laps.map((l, i) => ({ ...l, heart: loads.laps[i].heart, legs: loads.laps[i].legs })),
        surface: sport === 'run' ? surface : null,
        device: item.device,
        hr_quality: item.hrQuality,
        source: 'fit',
        file_name: item.fileName,
        calc: { v: item.version, sport, surface, zones: { ...zones }, fallback: round1(fallback) },
        pieces: encodePieces(item.pieces)
    };
}

/** Time, km and average HR from the session's files (the diary values). */
function actualFromFiles(session) {
    const files = activitiesFor(session.id);
    if (!files.length) return null;
    let d = 0, km = 0, hs = 0, ht = 0;
    files.forEach(a => {
        const t = Number(a.duration_s) || 0;
        d += t;
        km += (Number(a.distance_m) || 0) / 1000;
        if (a.avg_hr) { hs += a.avg_hr * t; ht += t; }
    });
    const out = { ...(session.actual || {}), duration_s: Math.round(d) };
    if (km > 0) out.km = Math.round(km * 100) / 100; else delete out.km;
    if (ht > 0) out.hr = Math.round(hs / ht); else delete out.hr;
    return out;
}

async function refillDiary(sessionIds, { emptied = false } = {}) {
    for (const id of sessionIds) {
        const s = state.sessions.get(id);
        if (!s) continue;
        const actual = actualFromFiles(s);
        if (actual) {
            s.done = true;
            s.actual = actual;
            await track(api.updateSession(id, { done: true, actual }));
        } else if (emptied) {
            // the last file went: drop the values it filled in; an unplanned session is no longer done
            const a = { ...(s.actual || {}) };
            delete a.duration_s; delete a.km; delete a.hr;
            s.actual = Object.keys(a).length ? a : null;
            if (!(s.blocks || []).length) s.done = false;
            await track(api.updateSession(id, { done: !!s.done, actual: s.actual }));
        }
    }
}

function newSessionPayload(item, discipline) {
    const sport = getParentSportForDiscipline(discipline);
    return sessionFields({
        sport_type: sport, discipline, orienteering: discipline === 'Orienteering',
        date: item.date, time: item.time, description: '', blocks: [], done: true
    });
}

/**
 * Save the chosen files.
 * @param entries  [{ item, target }] target: { kind: 'session', id } | { kind: 'new', discipline } | { kind: 'with', key } | { kind: 'skip' }
 * @param orphans  Map uid -> id of a stored file that lost its session (relinked instead of inserted)
 * @returns number of files saved
 */
export async function importActivities(entries, { orphans = new Map() } = {}) {
    const todo = entries.filter(e => e.target && e.target.kind !== 'skip').sort((a, b) => a.item.start - b.item.start);
    if (!todo.length) return 0;
    const touchedBefore = new Map();
    let created = [];
    let inserted = [];
    const relinked = [];
    try {
        // 1. new sessions for unplanned files
        const roots = todo.filter(e => e.target.kind === 'new');
        if (roots.length) created = await track(api.createSessions(roots.map(e => newSessionPayload(e.item, e.target.discipline))));
        created.forEach(r => state.sessions.set(r.id, r));
        const rootSession = new Map(roots.map((e, i) => [e.item.key, created[i] && created[i].id]));
        const sessionIdOf = e => (e.target.kind === 'session' ? e.target.id : e.target.kind === 'new' ? rootSession.get(e.item.key) : rootSession.get(e.target.key));

        // 2. activity rows
        const nextOrder = new Map();
        const rows = [];
        for (const e of todo) {
            const s = state.sessions.get(sessionIdOf(e));
            if (!s) continue;
            if (!created.some(c => c.id === s.id) && !touchedBefore.has(s.id)) touchedBefore.set(s.id, { done: s.done, actual: s.actual ?? null });
            const order = nextOrder.has(s.id) ? nextOrder.get(s.id) : activitiesFor(s.id).length;
            nextOrder.set(s.id, order + 1);
            const row = activityRow(e.item, s, order);
            if (orphans.has(e.item.uid)) relinked.push({ id: orphans.get(e.item.uid), row });
            else rows.push(row);
        }
        // a stored file without a session is relinked; if it has gone meanwhile, insert it again
        const relinkedOk = [];
        for (const r of relinked) {
            try {
                const a = await track(api.updateActivity(r.id, r.row));
                state.activities.set(a.id, a);
                relinkedOk.push(r);
            } catch (err) {
                rows.push(r.row);
            }
        }
        relinked.length = 0;
        relinked.push(...relinkedOk);
        inserted = await track(api.createActivities(rows));
        inserted.forEach(a => state.activities.set(a.id, a));
        // 3. tick the sessions and fill the diary from the files
        await refillDiary([...new Set([...touchedBefore.keys(), ...created.map(c => c.id)])]);
        emit('data');
    } catch (err) {
        // put everything back the way it was, so trying again can't duplicate anything
        const ins = inserted.map(a => a.id), rel = relinked.map(r => r.id);
        ins.forEach(id => state.activities.delete(id));
        rel.forEach(id => { const a = state.activities.get(id); if (a) state.activities.set(id, { ...a, session_id: null }); });
        created.forEach(c => state.sessions.delete(c.id));
        touchedBefore.forEach((b, id) => { const s = state.sessions.get(id); if (s) { s.done = b.done; s.actual = b.actual; } });
        emit('data');
        handleError(err, 'save the files');
        try {
            if (ins.length) await api.deleteActivities(ins);
            if (rel.length) await api.linkActivities(rel, null);
            if (created.length) await api.deleteSessions(created.map(c => c.id));
            for (const [id, b] of touchedBefore) await api.updateSession(id, { done: !!b.done, actual: b.actual });
        } catch (e) { console.error('import rollback', e); }
        return 0;
    }
    const n = inserted.length + relinked.length;
    hooks.toast({
        text: `Saved ${n} file${n === 1 ? '' : 's'}${created.length ? ` · ${created.length} new session${created.length === 1 ? '' : 's'}` : ''}`,
        action: {
            label: 'Undo',
            run: async () => {
                try {
                    const ins = inserted.map(a => a.id), rel = relinked.map(r => r.id);
                    ins.forEach(id => state.activities.delete(id));
                    rel.forEach(id => { const a = state.activities.get(id); if (a) state.activities.set(id, { ...a, session_id: null }); });
                    created.forEach(c => state.sessions.delete(c.id));
                    touchedBefore.forEach((b, id) => { const s = state.sessions.get(id); if (s) { s.done = b.done; s.actual = b.actual; } });
                    emit('data');
                    await track(api.deleteActivities(ins));
                    if (rel.length) await track(api.linkActivities(rel, null));
                    if (created.length) await track(api.deleteSessions(created.map(c => c.id)));
                    for (const [id, b] of touchedBefore) await track(api.updateSession(id, { done: !!b.done, actual: b.actual }));
                } catch (err) { handleError(err, 'undo the import'); }
            }
        }
    });
    return n;
}

/** Stored files with these ids (duplicates and files that lost their session). */
export async function findStoredFiles(uids) {
    const rows = await api.findActivitiesByUid(uids);
    // a file that lost its session will be reused by this import: don't delete it meanwhile
    rows.filter(r => !r.session_id && pendingPurge.has(r.id)).forEach(r => pendingPurge.get(r.id).cancel());
    return rows;
}

/** Take a file off its session (Undo for a few seconds, then it's deleted). */
export async function removeActivity(id) {
    const a = state.activities.get(id);
    if (!a) return;
    const sid = a.session_id;
    state.activities.set(id, { ...a, session_id: null });
    emit('data');
    const s = state.sessions.get(sid);
    const before = s ? { done: s.done, actual: s.actual ?? null } : null;
    try {
        await track(api.linkActivities([id], null));
        await refillDiary([sid], { emptied: true });
        emit('data');
    } catch (err) {
        state.activities.set(id, a);
        emit('data');
        handleError(err, 'remove the file');
        return;
    }
    const purge = laterPurge([id]);
    hooks.toast({
        text: 'Removed the file',
        action: {
            label: 'Undo',
            run: async () => {
                purge.cancel();
                state.activities.set(id, a);
                const cur = state.sessions.get(sid);
                if (cur && before) { cur.done = before.done; cur.actual = before.actual; }
                emit('data');
                try {
                    await track(api.linkActivities([id], sid));
                    if (cur && before) await track(api.updateSession(sid, { done: !!before.done, actual: before.actual }));
                    emit('data');
                } catch (err) { handleError(err, 'restore the file'); }
            }
        }
    });
}

/**
 * Recalculate loads from the stored pieces (zones changed, session type or
 * Orienteering changed). ids = null -> every file.
 */
export async function recalcActivities(ids = null) {
    let rows;
    try { rows = await api.fetchActivityPieces(ids); } catch (err) { console.error('recalc', err); return 0; }
    const updates = [];
    for (const r of rows) {
        if (!r.pieces) continue;
        const s = r.session_id ? state.sessions.get(r.session_id) : null;
        const sport = s ? s.sport_type : (r.sport_type || 'run');
        const surface = s ? surfaceOf(s) : (r.surface || 'road');
        const zones = zonesFor(sport);
        const fallback = s ? planEffort(s) : ((r.calc && r.calc.fallback) || 1);
        const loads = loadsFromPieces(decodePieces(r.pieces), r.laps || [], { sport, zones, surface, hrQuality: r.hr_quality || 'ok', fallbackEffort: fallback });
        updates.push({
            id: r.id,
            hr_load: loads.heart,
            body_load: loads.legs,
            laps: (r.laps || []).map((l, i) => ({ ...l, heart: loads.laps[i] ? loads.laps[i].heart : null, legs: loads.laps[i] ? loads.laps[i].legs : null })),
            sport_type: sport,
            surface: sport === 'run' ? surface : null,
            calc: { ...(r.calc || {}), sport, surface, zones: { ...zones }, fallback: round1(fallback) }
        });
    }
    if (!updates.length) return 0;
    updates.forEach(u => { const a = state.activities.get(u.id); if (a) state.activities.set(u.id, { ...a, ...u }); });
    emit('data');
    try { await track(api.saveActivityLoads(updates)); } catch (err) { handleError(err, 'save the recalculated loads'); }
    return updates.length;
}
