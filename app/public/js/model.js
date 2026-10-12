// NdurePlan - training model.
// Pure functions only (no DOM, no network) so they can be unit tested.

import { isRunSport, DEFAULT_HR_ZONES } from '../sports.js';
import { heartPerMin, effort, legsFactor, surfaceOf, isOrienteering, strengthHeart, strengthLegs } from './loads.js';

// ---------------------------------------------------------------------------
// Zones and load
// ---------------------------------------------------------------------------

export const ZONES = ['easy', 'ap1', 'ap2', 'ap3', 'sprint', 'strength'];
export const HR_ZONE_KEYS = ['easy', 'ap1', 'ap2', 'ap3'];
export const ZONE_LABEL = { easy: 'Easy', ap1: 'AP1', ap2: 'AP2', ap3: 'AP3', sprint: 'Sprint', strength: 'Strength' };

// Two loads, planned from the blocks and measured from FIT files (see loads.js):
//   Heart  per minute 3^((HR - Easy) / (AP2 - Easy)) at the block's target HR
//   Legs   per moving minute: HR effort x surface (runs) or x sport factor
// Sprints count at AP3. Standing rest adds time but no load.
// Strength: Heart = min x RPE / 60, Legs = min x RPE / 6.
export const DEFAULT_RPE = 6;
export const HARD_ZONES = new Set(['ap2', 'ap3', 'sprint']);
export const HARD_SESSION_MIN_S = 180; // >= 3 min of AP2/AP3/sprint work = hard session

export function isZone(z) { return ZONES.includes(z); }

// ---------------------------------------------------------------------------
// Dates (always local 'YYYY-MM-DD' strings)
// ---------------------------------------------------------------------------

const pad2 = n => String(n).padStart(2, '0');

export function toISODate(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Noon avoids daylight-saving edges when adding days.
export function parseISODate(s) {
    const [y, m, d] = String(s).split('-').map(Number);
    return new Date(y, m - 1, d, 12);
}

export function todayISO(now = new Date()) { return toISODate(now); }

export function addDays(dateStr, n) {
    const d = parseISODate(dateStr);
    d.setDate(d.getDate() + n);
    return toISODate(d);
}

export function daysBetween(a, b) {
    return Math.round((parseISODate(b) - parseISODate(a)) / 86400000);
}

export function mondayOf(dateStr) {
    const d = parseISODate(dateStr);
    const wd = (d.getDay() + 6) % 7; // Mon = 0
    d.setDate(d.getDate() - wd);
    return toISODate(d);
}

export function weekDates(mondayStr) {
    return Array.from({ length: 7 }, (_, i) => addDays(mondayStr, i));
}

// ISO 8601 week number.
export function isoWeek(dateStr) {
    const d = parseISODate(dateStr);
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
    const dayNr = (target.getDay() + 6) % 7;
    target.setDate(target.getDate() - dayNr + 3); // Thursday of this week
    const firstThursday = new Date(target.getFullYear(), 0, 4, 12);
    const firstDayNr = (firstThursday.getDay() + 6) % 7;
    firstThursday.setDate(firstThursday.getDate() - firstDayNr + 3);
    return 1 + Math.round((target - firstThursday) / (7 * 86400000));
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function weekdayIndex(dateStr) { return (parseISODate(dateStr).getDay() + 6) % 7; }
export function dayShort(dateStr) { return DAYS_SHORT[weekdayIndex(dateStr)]; }
export function dayLong(dateStr) { return DAYS_LONG[weekdayIndex(dateStr)]; }
export function dayNum(dateStr) { return parseISODate(dateStr).getDate(); }
export function monthLong(m) { return MONTHS_LONG[m]; }

// "Wednesday 7 October"
export function fmtDayTitle(dateStr) {
    const d = parseISODate(dateStr);
    return `${dayLong(dateStr)} ${d.getDate()} ${MONTHS_LONG[d.getMonth()]}`;
}

// "7 Oct"
export function fmtDayMonth(dateStr) {
    const d = parseISODate(dateStr);
    return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

// "5–11 Oct" or "28 Sep – 4 Oct"
export function fmtWeekRange(mondayStr) {
    const a = parseISODate(mondayStr);
    const b = parseISODate(addDays(mondayStr, 6));
    if (a.getMonth() === b.getMonth()) return `${a.getDate()}–${b.getDate()} ${MONTHS_SHORT[b.getMonth()]}`;
    return `${a.getDate()} ${MONTHS_SHORT[a.getMonth()]} – ${b.getDate()} ${MONTHS_SHORT[b.getMonth()]}`;
}

// Month grid starting Monday: array of 'YYYY-MM-DD' or null for padding cells.
export function monthGrid(year, month) {
    const first = new Date(year, month, 1, 12);
    const lead = (first.getDay() + 6) % 7;
    const days = new Date(year, month + 1, 0).getDate();
    const cells = Array(lead).fill(null);
    for (let d = 1; d <= days; d++) cells.push(toISODate(new Date(year, month, d, 12)));
    while (cells.length % 7) cells.push(null);
    return cells;
}

// ---------------------------------------------------------------------------
// Parsing user input (accepts decimal commas: "1,55")
// ---------------------------------------------------------------------------

export function parseNumber(input) {
    if (input === null || input === undefined) return null;
    const s = String(input).trim().replace(',', '.');
    if (s === '') return null;
    if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
    return Number(s);
}

/**
 * Duration text -> whole seconds.
 *   "6:00" "0:35" "1:30:00"   clock style
 *   "35s" "90 sec" "6 min" "1.5h" "1h30"
 *   "6" or "6,5"              bare number in `bare` units ('min' or 'sec')
 * Returns null for empty input and NaN for text it can't read.
 */
export function parseDuration(input, bare = 'min') {
    if (input === null || input === undefined) return null;
    let s = String(input).trim().toLowerCase().replace(/,/g, '.').replace(/\s+/g, ' ');
    if (s === '') return null;
    let m;
    if ((m = s.match(/^(\d+):(\d{1,2})$/))) {
        const sec = +m[2];
        return sec < 60 ? (+m[1]) * 60 + sec : NaN;
    }
    if ((m = s.match(/^(\d+):(\d{1,2}):(\d{1,2})$/))) {
        if (+m[2] >= 60 || +m[3] >= 60) return NaN;
        return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
    }
    if ((m = s.match(/^(\d+(?:\.\d+)?) ?(s|sec|secs|second|seconds|")$/))) return Math.round(+m[1]);
    if ((m = s.match(/^(\d+(?:\.\d+)?) ?(m|min|mins|minute|minutes|'|′)$/))) return Math.round(+m[1] * 60);
    if ((m = s.match(/^(\d+(?:\.\d+)?) ?(h|hr|hrs|hour|hours)$/))) return Math.round(+m[1] * 3600);
    if ((m = s.match(/^(\d+) ?h ?(\d{1,2}) ?(m|min)?$/))) return (+m[1]) * 3600 + (+m[2]) * 60;
    if ((m = s.match(/^(\d+) ?(m|min) ?(\d{1,2}) ?(s|sec)?$/))) return (+m[1]) * 60 + (+m[3]);
    if ((m = s.match(/^\d+(\.\d+)?$/))) return Math.round(+s * (bare === 'sec' ? 1 : 60));
    return NaN;
}

/** Distance text -> km. "1.55", "1,55", "200m", "1.5 km". null if empty, NaN if unreadable. */
export function parseDistance(input) {
    if (input === null || input === undefined) return null;
    const s = String(input).trim().toLowerCase().replace(',', '.').replace(/\s+/g, '');
    if (s === '') return null;
    let m;
    if ((m = s.match(/^(\d+(?:\.\d+)?)m$/))) return +m[1] / 1000;
    if ((m = s.match(/^(\d+(?:\.\d+)?)(km)?$/))) return +m[1];
    return NaN;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

// Clock style for inputs: 360 -> "6:00", 35 -> "0:35", 5400 -> "1:30:00"
export function fmtClock(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

// Short human text: "35 s", "45 min", "6:30 min", "1:30 h"
export function fmtDur(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    if (sec === 0) return '0 min';
    if (sec < 60) return `${sec} s`;
    if (sec < 600) {
        const m = Math.floor(sec / 60), s = sec % 60;
        return s ? `${m}:${pad2(s)} min` : `${m} min`;
    }
    if (sec < 3570) return `${Math.round(sec / 60)} min`;
    const totalMin = Math.round(sec / 60);
    return `${Math.floor(totalMin / 60)}:${pad2(totalMin % 60)} h`;
}

// Week totals: always h:mm ("5:53 h", "0:45 h")
export function fmtHours(sec) {
    const totalMin = Math.round(Math.max(0, Number(sec) || 0) / 60);
    return `${Math.floor(totalMin / 60)}:${pad2(totalMin % 60)} h`;
}

// 1.55 -> "1.55", 9.5 -> "9.5", 10 -> "10", 0.2 -> "0.2"
export function fmtKm(km, digits = 2) {
    if (km === null || km === undefined || !isFinite(km)) return '';
    return String(Number(Number(km).toFixed(digits)));
}

// Pace for a run: seconds per km -> "3:52 /km"
export function fmtPace(durationS, km) {
    if (!(km > 0) || !(durationS > 0)) return '';
    const secPerKm = Math.round(durationS / km);
    return `${Math.floor(secPerKm / 60)}:${pad2(secPerKm % 60)} /km`;
}

// '16:30:00' -> '16:30'
export function fmtTime(t) {
    if (!t) return '';
    return String(t).slice(0, 5);
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
}

// Old blocks stored whole minutes in time_min; new ones store duration_s.
export function blockDurationS(b) {
    const d = numOrNull(b && b.duration_s);
    if (d !== null) return Math.max(0, Math.round(d));
    return Math.max(0, Math.round((numOrNull(b && b.time_min) || 0) * 60));
}

export function normalizeBlock(b = {}) {
    const intensity = isZone(b.intensity) ? b.intensity : 'easy';
    const r = b.repeat;
    const reps = r ? Math.max(1, Math.round(numOrNull(r.reps) || 1)) : 1;
    const repeat = r && reps > 1 ? {
        reps,
        rest_sec: Math.max(0, Math.round(numOrNull(r.rest_sec) || 0)),
        rest_type: r.rest_type === 'moving' ? 'moving' : 'standing',
        rest_intensity: HR_ZONE_KEYS.includes(r.rest_intensity) ? r.rest_intensity : 'easy',
        rest_target_hr: numOrNull(r.rest_target_hr),
        start_with: r.start_with === 'rest' ? 'rest' : 'interval',
        end_with: r.end_with === 'rest' ? 'rest' : 'interval',
        customized: !!r.customized && Array.isArray(r.per_rep) && r.per_rep.length > 0,
        per_rep: Array.isArray(r.per_rep) ? r.per_rep.slice(0, reps).map(p => ({
            duration_s: blockDurationS(p),
            distance_km: numOrNull(p.distance_km),
            target_hr: numOrNull(p.target_hr)
        })) : []
    } : null;
    return {
        type: String(b.type ?? '').slice(0, 80),
        intensity,
        duration_s: blockDurationS(b),
        distance_km: numOrNull(b.distance_km),
        target_hr: intensity === 'strength' ? null : numOrNull(b.target_hr),
        rpe: intensity === 'strength' ? Math.min(10, Math.max(1, Math.round(numOrNull(b.rpe) || DEFAULT_RPE))) : null,
        repeat
    };
}

// What gets stored. time_min is kept for anything still reading the old field.
export function serializeBlock(b) {
    const n = normalizeBlock(b);
    const out = { ...n, time_min: Math.round(n.duration_s / 60 * 100) / 100 };
    if (n.repeat) {
        out.repeat = {
            ...n.repeat,
            per_rep: n.repeat.customized
                ? n.repeat.per_rep.map(p => ({ ...p, time_min: Math.round(p.duration_s / 60 * 100) / 100 }))
                : []
        };
    }
    return out;
}

/**
 * One block -> the concrete segments in the order they happen
 * (reps and rests, honouring start/end with rest and per-rep values).
 * Single source of truth for totals, load and the workout graph.
 */
export function expandBlock(raw) {
    const b = normalizeBlock(raw);
    const work = (over = {}) => ({
        kind: 'work', intensity: b.intensity, duration_s: b.duration_s, distance_km: b.distance_km,
        target_hr: b.target_hr, rpe: b.rpe, moving: true, ...over
    });
    if (!b.repeat) return [work()];

    const r = b.repeat;
    const works = r.customized
        ? Array.from({ length: r.reps }, (_, i) => {
            const p = r.per_rep[i] || {};
            return work({
                duration_s: p.duration_s ?? b.duration_s,
                distance_km: p.distance_km ?? b.distance_km,
                target_hr: p.target_hr ?? b.target_hr
            });
        })
        : Array.from({ length: r.reps }, () => work());

    const rest = () => ({
        kind: 'rest',
        intensity: r.rest_type === 'moving' ? r.rest_intensity : null,
        duration_s: r.rest_sec,
        distance_km: null,
        target_hr: r.rest_type === 'moving' ? r.rest_target_hr : null,
        rpe: null,
        moving: r.rest_type === 'moving'
    });

    const out = [];
    if (r.start_with === 'rest' && r.rest_sec > 0) out.push(rest());
    works.forEach((w, i) => {
        out.push(w);
        if (i < works.length - 1 && r.rest_sec > 0) out.push(rest());
    });
    if (r.end_with === 'rest' && r.rest_sec > 0) out.push(rest());
    return out;
}

/**
 * Context for planned loads: the sport, its HR zones and the running surface.
 * @param allZones  profile zones for every sport (state.zones); defaults if missing
 */
export function planCtx(session, allZones) {
    const sport = (session && session.sport_type) || 'run';
    const zones = (allZones && allZones[sport]) || DEFAULT_HR_ZONES[sport] || (allZones && allZones.run) || DEFAULT_HR_ZONES.run;
    return { sport, zones, surface: surfaceOf(session) };
}

const DEFAULT_CTX = { sport: 'run', zones: DEFAULT_HR_ZONES.run, surface: 'road' };

/** Planned Heart and Legs of one segment. */
export function segmentLoads(seg, ctx = DEFAULT_CTX) {
    if (!seg.intensity) return { heart: 0, legs: 0 }; // standing rest
    const min = (seg.duration_s || 0) / 60;
    if (seg.intensity === 'strength') {
        const rpe = seg.rpe || DEFAULT_RPE;
        return { heart: strengthHeart(min, rpe), legs: strengthLegs(min, rpe) };
    }
    const z = ctx.zones || DEFAULT_HR_ZONES.run;
    const hr = seg.target_hr || (seg.intensity === 'sprint' ? z.ap3 : z[seg.intensity]) || z.easy;
    return { heart: min * heartPerMin(hr, z), legs: min * effort(hr, z) * legsFactor(ctx.sport, ctx.surface) };
}

export function emptyZones() {
    return { easy: 0, ap1: 0, ap2: 0, ap3: 0, sprint: 0, strength: 0 };
}

/** Totals for a list of blocks. Zone and hard times are in seconds. */
export function summarizeBlocks(blocks, ctx = DEFAULT_CTX) {
    const zones = emptyZones();
    let duration_s = 0, distance_km = 0, heart = 0, legs = 0, hard_s = 0, rest_s = 0;
    (blocks || []).forEach(b => {
        if (!b) return;
        expandBlock(b).forEach(seg => {
            duration_s += seg.duration_s || 0;
            distance_km += seg.distance_km || 0;
            const l = segmentLoads(seg, ctx);
            heart += l.heart;
            legs += l.legs;
            if (seg.intensity) zones[seg.intensity] += seg.duration_s || 0;
            else rest_s += seg.duration_s || 0;
            if (seg.kind === 'work' && HARD_ZONES.has(seg.intensity)) hard_s += seg.duration_s || 0;
        });
    });
    return { duration_s, distance_km: Math.round(distance_km * 1000) / 1000, heart: Math.round(heart), legs: Math.round(legs), zones, hard_s, rest_s };
}

// One-line description of a block: "4 × 6:00 · 1.55 km · 181 bpm · 3:52 /km · 1:00 jog"
export function describeBlock(raw) {
    const b = normalizeBlock(raw);
    const parts = [];
    const reps = b.repeat ? b.repeat.reps : 1;
    parts.push(reps > 1 ? `${reps} × ${fmtClock(b.duration_s)}` : fmtDur(b.duration_s));
    if (b.distance_km) parts.push(`${fmtKm(b.distance_km)} km`);
    if (b.intensity === 'strength') parts.push(`RPE ${b.rpe}`);
    else if (b.target_hr) parts.push(`${b.target_hr} bpm`);
    const pace = fmtPace(b.duration_s, b.distance_km);
    if (pace) parts.push(pace);
    if (b.repeat && b.repeat.rest_sec > 0) {
        parts.push(`${fmtClock(b.repeat.rest_sec)} ${b.repeat.rest_type === 'moving' ? 'jog' : 'rest'}`);
    }
    return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function sessionTitle(s) {
    return (s.description && s.description.trim()) || s.discipline || 'Session';
}

export function sessionPlan(s, allZones) {
    return summarizeBlocks(s.blocks, planCtx(s, allZones));
}

export function sessionIsHard(s) {
    return sessionPlan(s).hard_s >= HARD_SESSION_MIN_S;
}

export function sessionRpe(s) {
    if (numOrNull(s.rpe)) return Number(s.rpe);
    const rpes = (s.blocks || []).map(normalizeBlock).filter(b => b.intensity === 'strength').map(b => b.rpe);
    return rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : DEFAULT_RPE;
}

/**
 * What was actually done.
 *   With FIT files: time, km and loads from the files (a file without usable
 *   HR borrows the plan's Heart per minute). Strength Legs always come from RPE.
 *   Without files: the diary values when filled in, otherwise the plan.
 * @param acts  activities linked to this session
 */
export function sessionDone(s, allZones, acts = []) {
    const zero = { duration_s: 0, km: 0, heart: 0, legs: 0, files: 0 };
    if (!s.done) return zero;
    const ctx = planCtx(s, allZones);
    const plan = summarizeBlocks(s.blocks, ctx);
    const a = s.actual || {};
    const strength = s.sport_type === 'strength';
    const rpe = sessionRpe(s);
    const planHeartPerS = plan.duration_s > 0 ? plan.heart / plan.duration_s : 1 / 60;
    const planLegsPerS = plan.duration_s > 0 ? plan.legs / plan.duration_s : legsFactor(ctx.sport, ctx.surface) / 60;

    if (acts && acts.length) {
        let duration_s = 0, km = 0, heart = 0, legs = 0;
        acts.forEach(x => {
            const d = Number(x.duration_s) || 0;
            duration_s += d;
            km += (Number(x.distance_m) || 0) / 1000;
            heart += x.hr_load !== null && x.hr_load !== undefined ? Number(x.hr_load) : (strength ? strengthHeart(d / 60, rpe) : d * planHeartPerS);
            if (!strength) legs += x.body_load !== null && x.body_load !== undefined ? Number(x.body_load) : d * planLegsPerS;
        });
        if (strength) legs = strengthLegs(duration_s / 60, rpe);
        return { duration_s, km: Math.round(km * 100) / 100, heart: Math.round(heart), legs: Math.round(legs), files: acts.length };
    }

    const duration_s = numOrNull(a.duration_s) ?? plan.duration_s;
    const km = numOrNull(a.km) ?? plan.distance_km;
    let heart, legs;
    if (strength) {
        heart = strengthHeart(duration_s / 60, rpe);
        legs = strengthLegs(duration_s / 60, rpe);
    } else {
        heart = duration_s * planHeartPerS;
        legs = duration_s * planLegsPerS;
    }
    return { duration_s, km: km || 0, heart: Math.round(heart), legs: Math.round(legs), files: 0 };
}

export function compareSessions(a, b) {
    const ta = a.time ? String(a.time) : '99';
    const tb = b.time ? String(b.time) : '99';
    if (ta !== tb) return ta < tb ? -1 : 1;
    const ca = a.created_at || '', cb = b.created_at || '';
    return ca < cb ? -1 : ca > cb ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Weeks
// ---------------------------------------------------------------------------

/**
 * @param mondayStr  'YYYY-MM-DD' (a Monday)
 * @param sessions   all sessions (any dates)
 * @param diary      Map or object date -> diary row
 * @param o.zones    profile zones for every sport
 * @param o.acts     Map sessionId -> activities (FIT files)
 */
export function weekStats(mondayStr, sessions, diary, { zones, acts } = {}) {
    const dates = weekDates(mondayStr);
    const inWeek = new Set(dates);
    const getDiary = d => (diary instanceof Map ? diary.get(d) : diary && diary[d]) || null;
    const getActs = id => (acts instanceof Map ? acts.get(id) : acts && acts[id]) || [];
    const zoneTime = emptyZones();
    const planned = { duration_s: 0, km: 0, heart: 0, legs: 0 };
    const done = { duration_s: 0, km: 0, heart: 0, legs: 0 };
    const orienteering = { count: 0, planned_s: 0, done_s: 0, km: 0, legs: 0 };
    let count = 0, doneCount = 0, hardCount = 0, rpeSum = 0, rpeN = 0, files = 0;
    const perDay = {};
    dates.forEach(d => { perDay[d] = { planned_s: 0, done_s: 0, sessions: 0, done: 0 }; });

    sessions.forEach(s => {
        if (!inWeek.has(s.date)) return;
        const p = sessionPlan(s, zones);
        const run = isRunSport(s.sport_type);
        const orient = run && isOrienteering(s);
        count++;
        planned.duration_s += p.duration_s;
        planned.heart += p.heart;
        planned.legs += p.legs;
        if (run) planned.km += p.distance_km;
        Object.keys(zoneTime).forEach(z => { zoneTime[z] += p.zones[z]; });
        if (p.hard_s >= HARD_SESSION_MIN_S) hardCount++;
        if (orient) { orienteering.count++; orienteering.planned_s += p.duration_s; }
        const day = perDay[s.date];
        day.planned_s += p.duration_s;
        day.sessions++;
        if (s.done) {
            const a = sessionDone(s, zones, getActs(s.id));
            doneCount++;
            files += a.files;
            done.duration_s += a.duration_s;
            done.heart += a.heart;
            done.legs += a.legs;
            if (run) done.km += a.km;
            if (orient) { orienteering.done_s += a.duration_s; orienteering.km += a.km; orienteering.legs += a.legs; }
            day.done_s += a.duration_s;
            day.done++;
            if (s.rpe) { rpeSum += Number(s.rpe); rpeN++; }
        }
    });

    const enduranceS = zoneTime.easy + zoneTime.ap1 + zoneTime.ap2 + zoneTime.ap3 + zoneTime.sprint;
    const painDays = dates
        .map(d => ({ date: d, pain: getDiary(d) ? numOrNull(getDiary(d).pain) : null }))
        .filter(x => x.pain !== null && x.pain >= 3);

    planned.km = Math.round(planned.km * 10) / 10;
    done.km = Math.round(done.km * 10) / 10;
    orienteering.km = Math.round(orienteering.km * 10) / 10;
    return {
        monday: mondayStr, dates, planned, done, zones: zoneTime, perDay, orienteering,
        count, doneCount, hardCount, files,
        easyShare: enduranceS > 0 ? zoneTime.easy / enduranceS : null,
        avgRpe: rpeN ? rpeSum / rpeN : null,
        painDays
    };
}

/**
 * Short notes for the week summary, based on the agreed training rules.
 * @param stats      weekStats() for this week
 * @param prevStats  weekStats() for the previous week (or null)
 */
export function weekFlags(stats, prevStats) {
    const flags = [];
    if (stats.painDays.length >= 2) {
        flags.push({
            kind: 'pain',
            text: `Knee/IT band pain on ${stats.painDays.length} days this week (${stats.painDays.map(p => `${dayShort(p.date)} ${p.pain}/10`).join(', ')}). If it keeps coming back, see a physio.`
        });
    } else if (stats.painDays.length === 1) {
        const p = stats.painDays[0];
        flags.push({
            kind: 'pain',
            text: `Knee/IT band pain ${p.pain}/10 on ${dayShort(p.date)}. If it's still there the next morning, swap the next run for the bike.`
        });
    }
    if (stats.hardCount >= 4) {
        flags.push({ kind: 'hard', text: `${stats.hardCount} hard sessions planned. A normal week has 2 plus the long run.` });
    }
    if (prevStats && prevStats.planned.km > 0) {
        const diff = stats.planned.km - prevStats.planned.km;
        if (diff > 5 && stats.planned.km / prevStats.planned.km > 1.12) {
            flags.push({
                kind: 'volume',
                text: `${fmtKm(stats.planned.km, 1)} km of running planned, ${fmtKm(diff, 1)} km more than last week. The usual step is 3–5 km.`
            });
        }
    }
    return flags;
}

// ---------------------------------------------------------------------------
// Copy a week
// ---------------------------------------------------------------------------

/**
 * New session payloads (no id) copying every session in the source week into
 * the destination week, same weekday. With skipPlannedDays, days that already
 * have something planned in the destination are left alone.
 */
export function copyWeekPayloads(sourceMonday, destMonday, sessions, { skipPlannedDays = true } = {}) {
    const shift = daysBetween(sourceMonday, destMonday);
    if (shift === 0) return [];
    const srcDates = new Set(weekDates(sourceMonday));
    const destPlanned = new Set(sessions.filter(s => weekDates(destMonday).includes(s.date)).map(s => s.date));
    return sessions
        .filter(s => srcDates.has(s.date))
        .map(s => ({ s, date: addDays(s.date, shift) }))
        .filter(({ date }) => !(skipPlannedDays && destPlanned.has(date)))
        .map(({ s, date }) => ({
            sport_type: s.sport_type,
            discipline: s.discipline || '',
            orienteering: !!s.orienteering,
            date,
            time: s.time || null,
            description: s.description || '',
            blocks: (s.blocks || []).map(serializeBlock),
            done: false,
            rpe: null,
            actual: null,
            notes: null
        }));
}
