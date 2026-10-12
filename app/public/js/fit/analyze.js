// NdurePlan - turn the records of a FIT file into what the app stores:
// 10-second pieces (5 bytes each), lap summaries and totals.
// Loads are always calculated from the stored pieces, so they can be
// recalculated later (new zones, Orienteering ticked) without the file.
//
// Time rules
//   - Timer paused (watch stopped, auto-pause): not counted.
//   - Standing still (< 1.8 km/h) for up to 5 minutes: counted for Heart
//     (rest between reps, waiting at a control), not for Legs.
//   - Standing still for more than 5 minutes in one go: not counted at all
//     (forgot to stop the watch, long break, chat before the warm-up).
//
// Piece layout (5 bytes): HR, HR 20 s later, counted s x 20, legs s x 10, speed m/s x 10
//   "legs s" = moving seconds x downhill factor (running) or moving seconds (other sports).

import { heartPerMin, effort, downhillFactor, legsFactor, MAX_GRADE } from '../loads.js';

export const CALC_VERSION = 1;
export const PIECE_S = 10;
export const STOP_CUT_S = 300;
export const MOVING_MPS = 0.5;
export const HR_LAG_S = 20;
export const GRADE_HALF_S = 25;
export const PIECE_BYTES = 5;
export const MAX_SPAN_S = 48 * 3600; // one activity; longer files are refused

const finite = Number.isFinite;

export class NoDataError extends Error {
    constructor(msg = 'There is no recorded activity in this file (it may be a settings or health file).') { super(msg); this.name = 'NoDataError'; }
}

// Index of the last x[i] <= v (x ascending). -1 if v < x[0].
function floorIndex(x, v) {
    let lo = 0, hi = x.length - 1;
    if (v < x[0]) return -1;
    if (v >= x[hi]) return hi;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (x[mid] <= v) lo = mid; else hi = mid;
    }
    return lo;
}

// Piecewise-linear value of series y over times t at time v (clamped to the ends).
function interp(t, y, v) {
    const i = floorIndex(t, v);
    if (i < 0) return y[0];
    if (i >= t.length - 1) return y[t.length - 1];
    const f = (v - t[i]) / (t[i + 1] - t[i]);
    return y[i] + f * (y[i + 1] - y[i]);
}

function fillSeries(src, n) {
    const out = new Float64Array(n);
    let first = NaN;
    for (let i = 0; i < n; i++) if (finite(src[i])) { first = src[i]; break; }
    if (!finite(first)) return null;
    let last = first;
    for (let i = 0; i < n; i++) {
        if (finite(src[i])) last = src[i];
        out[i] = last;
    }
    return out;
}

function smooth(y, half) {
    const n = y.length;
    const cum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + y[i];
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
        out[i] = (cum[b] - cum[a]) / (b - a);
    }
    return out;
}

/**
 * @param fit    result of decodeFit()
 * @param o.sport  app sport ('run', 'bike', ...): running gets the downhill factor and the cadence check
 * @param o.pieceS piece length in seconds (10; other values only for studies)
 */
/**
 * Records in time order, one per second at most, inside the session's own time window
 * (a stray record with a wrong date would otherwise stretch the activity over years).
 */
export function cleanRecords(fit) {
    const src = fit.rec;
    let idx = src.t.map((_, i) => i).filter(i => Number.isFinite(src.t[i]));
    const sorted = idx.every((v, k) => k === 0 || src.t[idx[k - 1]] <= src.t[v]);
    if (!sorted) idx.sort((a, b) => src.t[a] - src.t[b] || a - b);
    const sess = (fit.sessions && fit.sessions[0]) || {};
    if (Number.isFinite(sess.startTime)) {
        const end = Number.isFinite(sess.timestamp) && sess.timestamp > sess.startTime ? sess.timestamp : sess.startTime + (sess.elapsed || 0);
        if (end > sess.startTime) {
            const inside = idx.filter(i => src.t[i] >= sess.startTime - 60 && src.t[i] <= end + 60);
            if (inside.length >= 2) idx = inside;
        }
    }
    const out = { t: [], hr: [], dist: [], alt: [], spd: [], cad: [] };
    for (const i of idx) {
        const n = out.t.length;
        if (n && out.t[n - 1] === src.t[i]) continue;
        for (const k of Object.keys(out)) out[k].push(src[k][i]);
    }
    return out;
}

export function analyze(fit, { sport = 'run', pieceS = PIECE_S } = {}) {
    const r = cleanRecords(fit);
    const n = r.t.length;
    if (n < 2) throw new NoDataError();
    const t = r.t;
    const t0 = t[0], tEnd = t[n - 1];
    if (tEnd - t0 < 10) throw new NoDataError('This activity is shorter than 10 seconds.');
    if (tEnd - t0 > MAX_SPAN_S) throw new NoDataError('This file covers more than 48 hours, so it doesn’t look like one activity.');
    const run = sport === 'run';

    // --- clean series ------------------------------------------------------
    const hr = r.hr.map(v => (v >= 30 && v <= 240 ? v : NaN));
    let dist = null;
    const nDist = r.dist.reduce((a, v) => a + (finite(v) ? 1 : 0), 0);
    if (nDist >= n * 0.5) {
        dist = fillSeries(r.dist, n);
        for (let i = 1; i < n; i++) if (dist[i] < dist[i - 1]) dist[i] = dist[i - 1];
    } else if (r.spd.reduce((a, v) => a + (finite(v) ? 1 : 0), 0) >= n * 0.5) {
        const spd = fillSeries(r.spd, n);
        dist = new Float64Array(n);
        for (let i = 1; i < n; i++) dist[i] = dist[i - 1] + spd[i] * Math.min(t[i] - t[i - 1], 10);
    }
    if (dist && dist[n - 1] - dist[0] < 200) dist = null; // treadmill without a foot pod, gym, ...
    const hasDistance = !!dist;
    let alt = null;
    if (run && dist && r.alt.reduce((a, v) => a + (finite(v) ? 1 : 0), 0) >= n * 0.5) alt = smooth(fillSeries(r.alt, n), 5);

    // --- timer pauses from start/stop events ---------------------------------
    const pauses = [];
    let stopAt = null;
    for (const e of [...fit.events].sort((a, b) => a.t - b.t)) {
        if (e.type === 0) { if (stopAt !== null) { pauses.push([stopAt, e.t]); stopAt = null; } }
        else if ([1, 4, 8, 9].includes(e.type)) { if (stopAt === null) stopAt = e.t; }
    }
    if (stopAt !== null && stopAt < tEnd) pauses.push([stopAt, tEnd]);

    // --- classify every interval between two records -------------------------
    // 0 paused, 1 standing (counted), 2 moving, 3 standing too long (not counted)
    const m = n - 1;
    const st = new Uint8Array(m);
    const iHr = new Float64Array(m);
    let pj = 0, pausedS = 0;
    const distAt = v => interp(t, dist, v);
    for (let i = 0; i < m; i++) {
        const a = t[i], b = t[i + 1], dt = b - a;
        const mid = (a + b) / 2;
        while (pj < pauses.length && pauses[pj][1] <= mid) pj++;
        if (pj < pauses.length && pauses[pj][0] <= mid) { st[i] = 0; pausedS += dt; continue; }
        const h1 = hr[i], h2 = hr[i + 1];
        iHr[i] = finite(h1) && finite(h2) ? (h1 + h2) / 2 : finite(h2) ? h2 : h1;
        if (dist) {
            const wa = Math.max(t0, a - 5), wb = Math.min(tEnd, b + 5);
            const v = (distAt(wb) - distAt(wa)) / Math.max(1, wb - wa);
            st[i] = v >= MOVING_MPS ? 2 : 1;
        } else {
            st[i] = 2; // no distance: every counted second is "moving"
        }
    }
    // Stops longer than STOP_CUT_S are not counted.
    let s0 = -1, sDur = 0;
    const flush = end => {
        if (s0 >= 0 && sDur > STOP_CUT_S) for (let k = s0; k < end; k++) if (st[k] === 1) st[k] = 3;
        s0 = -1; sDur = 0;
    };
    for (let i = 0; i < m; i++) {
        if (st[i] === 1) { if (s0 < 0) s0 = i; sDur += t[i + 1] - t[i]; }
        else flush(i);
    }
    flush(m);

    // --- laps -> pieces ------------------------------------------------------
    const lapsIn = (fit.laps || [])
        .filter(l => finite(l.startTime))
        .map(l => ({ a: l.startTime, b: finite(l.timestamp) && l.timestamp > l.startTime ? l.timestamp : l.startTime + (l.elapsed ?? l.timer ?? 0), src: l }))
        .sort((x, y) => x.a - y.a);
    const L = [];
    for (const lap of lapsIn) {
        let a = Math.max(lap.a, t0);
        const b = Math.min(lap.b, tEnd);
        if (L.length) {
            const prev = L[L.length - 1];
            if (a < prev.b) a = prev.b;
            if (a > prev.b) prev.b = a;
        }
        if (b - a >= 1) L.push({ a, b, src: lap.src });
    }
    if (!L.length) L.push({ a: t0, b: tEnd, src: null });
    L[0].a = t0;
    L[L.length - 1].b = tEnd;

    const pa = [], pb = [], ranges = [];
    L.forEach(lap => {
        const i0 = pa.length;
        for (let x = lap.a; x < lap.b - 1e-6; x += pieceS) { pa.push(x); pb.push(Math.min(x + pieceS, lap.b)); }
        ranges.push([i0, pa.length]);
    });
    const P = pa.length;
    const cnt = new Float64Array(P), mov = new Float64Array(P), hrS = new Float64Array(P), hrT = new Float64Array(P), dS = new Float64Array(P);
    let excludedS = 0;

    let p = 0;
    for (let i = 0; i < m; i++) {
        const s = st[i];
        if (s === 0) continue;
        const a = t[i], b = t[i + 1], dt = b - a;
        if (s === 3) { excludedS += dt; continue; }
        while (p < P && pb[p] <= a) p++;
        const dd = dist ? dist[i + 1] - dist[i] : 0;
        for (let q = p; q < P && pa[q] < b; q++) {
            const o = Math.min(b, pb[q]) - Math.max(a, pa[q]);
            if (o <= 0) continue;
            cnt[q] += o;
            if (finite(iHr[i])) { hrS[q] += iHr[i] * o; hrT[q] += o; }
            if (s === 2) mov[q] += o;
            dS[q] += dd * o / dt;
        }
    }

    // Cumulative HR over counted time, for "HR 20 s later".
    const CT = new Float64Array(n), CH = new Float64Array(n);
    for (let i = 0; i < m; i++) {
        const dt = t[i + 1] - t[i];
        const use = (st[i] === 1 || st[i] === 2) && finite(iHr[i]);
        CT[i + 1] = CT[i] + (use ? dt : 0);
        CH[i + 1] = CH[i] + (use ? iHr[i] * dt : 0);
    }

    // --- HR quality ---------------------------------------------------------
    let totCnt = 0, totHrT = 0;
    for (let q = 0; q < P; q++) { totCnt += cnt[q]; totHrT += hrT[q]; }
    let hrQuality = totHrT >= 60 && totHrT >= totCnt * 0.5 ? 'ok' : 'none';
    if (hrQuality === 'ok' && run) {
        // Wrist sensors sometimes lock onto the step rate: HR = cadence for most of the run.
        let tot = 0, lock = 0;
        for (let i = 0; i < m; i++) {
            if (st[i] !== 2) continue;
            const c = r.cad[i + 1], h = hr[i + 1];
            if (!finite(c) || !finite(h) || c <= 0) continue;
            const spm = c < 120 ? c * 2 : c;
            if (spm < 140) continue;
            const dt = t[i + 1] - t[i];
            tot += dt;
            if (Math.abs(h - spm) <= 2) lock += dt;
        }
        if (tot > 300 && lock / tot > 0.6) hrQuality = 'cadence';
    }

    // --- pieces -> bytes ----------------------------------------------------
    const bytes = new Uint8Array(P * PIECE_BYTES);
    const lagAvg = (a, b) => {
        const ta = Math.min(tEnd, a), tb = Math.min(tEnd, b);
        const dT = interp(t, CT, tb) - interp(t, CT, ta);
        return dT >= 1 ? (interp(t, CH, tb) - interp(t, CH, ta)) / dT : NaN;
    };
    const distAtS = v => interp(t, dist, v);
    const altAt = v => interp(t, alt, v);
    for (let q = 0; q < P; q++) {
        const h = hrT[q] > 0 ? hrS[q] / hrT[q] : NaN;
        let hl = lagAvg(pa[q] + HR_LAG_S, pb[q] + HR_LAG_S);
        if (!finite(hl)) hl = h;
        let legS = mov[q];
        if (run && alt && mov[q] > 0) {
            const wa = Math.max(t0, pa[q] - GRADE_HALF_S), wb = Math.min(tEnd, pb[q] + GRADE_HALF_S);
            const dd = distAtS(wb) - distAtS(wa);
            const g = dd >= 15 ? Math.max(-MAX_GRADE, Math.min(MAX_GRADE, (altAt(wb) - altAt(wa)) / dd)) : 0;
            legS *= downhillFactor(g);
        }
        const k = q * PIECE_BYTES;
        bytes[k] = finite(h) ? Math.min(255, Math.max(1, Math.round(h))) : 0;
        bytes[k + 1] = finite(hl) ? Math.min(255, Math.max(1, Math.round(hl))) : 0;
        bytes[k + 2] = Math.min(255, Math.round(cnt[q] * 20));
        bytes[k + 3] = Math.min(255, Math.round(legS * 10));
        bytes[k + 4] = mov[q] > 0 ? Math.min(255, Math.round(dS[q] / mov[q] * 10)) : 0;
    }

    // --- laps and totals ----------------------------------------------------
    let maxHr = -Infinity;
    hr.forEach(v => { if (finite(v) && v > maxHr) maxHr = v; });
    const sess = (fit.sessions && fit.sessions[0]) || {};
    const laps = L.map((lap, li) => {
        const [i0, i1] = ranges[li];
        let c = 0, mv = 0, d = 0, hs = 0, ht = 0;
        for (let q = i0; q < i1; q++) { c += cnt[q]; mv += mov[q]; d += dS[q]; hs += hrS[q]; ht += hrT[q]; }
        let mx = -Infinity;
        for (let i = Math.max(0, floorIndex(t, lap.a)); i < n && t[i] <= lap.b; i++) if (finite(hr[i]) && hr[i] > mx) mx = hr[i];
        const src = lap.src || {};
        return {
            i0, i1,
            start: Math.round(lap.a - t0),
            elapsed: Math.round(lap.b - lap.a),
            counted: Math.round(c),
            moving: Math.round(hasDistance ? mv : c),
            dist: finite(src.distance) && src.distance > 0 ? Math.round(src.distance) : hasDistance ? Math.round(d) : null,
            hr: ht > 0 ? Math.round(hs / ht) : null,
            max_hr: finite(mx) ? Math.round(mx) : null,
            ascent: finite(src.ascent) ? Math.round(src.ascent) : null,
            descent: finite(src.descent) ? Math.round(src.descent) : null
        };
    });
    let sumHrS = 0, sumMov = 0, sumD = 0;
    for (let q = 0; q < P; q++) { sumHrS += hrS[q]; sumMov += mov[q]; sumD += dS[q]; }
    const totals = {
        elapsed_s: Math.round(tEnd - t0),
        timer_s: Math.round(tEnd - t0 - pausedS),
        counted_s: Math.round(totCnt),
        moving_s: Math.round(hasDistance ? sumMov : totCnt),
        excluded_s: Math.round(excludedS),
        paused_s: Math.round(pausedS),
        distance_m: finite(sess.distance) && sess.distance > 0 ? Math.round(sess.distance) : hasDistance ? Math.round(sumD) : null,
        ascent_m: finite(sess.ascent) ? Math.round(sess.ascent) : null,
        descent_m: finite(sess.descent) ? Math.round(sess.descent) : null,
        avg_hr: totHrT > 0 ? Math.round(sumHrS / totHrT) : null,
        max_hr: finite(maxHr) ? Math.round(maxHr) : (finite(sess.maxHr) ? sess.maxHr : null)
    };
    return { version: CALC_VERSION, start: t0, pieces: bytes, laps, totals, hrQuality, hasDistance };
}

// ---------------------------------------------------------------------------
// Loads from stored pieces
// ---------------------------------------------------------------------------

/**
 * @param pieces   Uint8Array (5 bytes per piece)
 * @param laps     [{ i0, i1, ... }]
 * @param o.sport, o.zones (that sport's zones), o.surface, o.hrQuality
 * @param o.fallbackEffort  legs effort per minute when there is no usable HR (planned zone, else 1)
 * @returns { heart (null without usable HR), legs (null for strength), laps: [{ heart, legs }] }
 */
export function loadsFromPieces(pieces, laps, { sport, zones, surface, hrQuality = 'ok', fallbackEffort = 1 }) {
    const P = Math.floor(pieces.length / PIECE_BYTES);
    const hrOk = hrQuality === 'ok';
    const strength = sport === 'strength';
    const factor = legsFactor(sport, surface);
    // pass 1: averages used to fill pieces without HR
    let hSum = 0, hT = 0, eSum = 0, eT = 0;
    if (hrOk) {
        for (let q = 0; q < P; q++) {
            const k = q * PIECE_BYTES;
            const c = pieces[k + 2] / 20;
            if (pieces[k] && c > 0) { hSum += c / 60 * heartPerMin(pieces[k], zones); hT += c; }
            const lg = pieces[k + 3] / 10;
            const hl = pieces[k + 1] || pieces[k];
            if (hl && lg > 0) { eSum += lg * effort(hl, zones); eT += lg; }
        }
    }
    const heartPerS = hT > 0 ? hSum / hT : 0;
    const meanEffort = eT > 0 ? eSum / eT : fallbackEffort;
    const pieceHeart = new Float64Array(P), pieceLegs = new Float64Array(P);
    for (let q = 0; q < P; q++) {
        const k = q * PIECE_BYTES;
        const c = pieces[k + 2] / 20;
        const lg = pieces[k + 3] / 10;
        if (hrOk) pieceHeart[q] = pieces[k] ? c / 60 * heartPerMin(pieces[k], zones) : c * heartPerS;
        if (!strength && lg > 0) {
            const hl = pieces[k + 1] || pieces[k];
            const e = !hrOk ? fallbackEffort : hl ? effort(hl, zones) : meanEffort;
            pieceLegs[q] = lg / 60 * e * factor;
        }
    }
    const sum = (arr, a, b) => { let s = 0; for (let q = a; q < b; q++) s += arr[q]; return s; };
    const r1 = v => Math.round(v * 10) / 10;
    return {
        heart: hrOk ? r1(sum(pieceHeart, 0, P)) : null,
        legs: strength ? null : r1(sum(pieceLegs, 0, P)),
        laps: (laps || []).map(l => ({
            heart: hrOk ? r1(sum(pieceHeart, l.i0, l.i1)) : null,
            legs: strength ? null : r1(sum(pieceLegs, l.i0, l.i1))
        }))
    };
}

// ---------------------------------------------------------------------------
// Storage: pieces <-> base64 text
// ---------------------------------------------------------------------------

export function encodePieces(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

export function decodePieces(text) {
    if (!text) return new Uint8Array(0);
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

/** HR, HR 20 s later, counted s, legs s and speed of piece q (for charts and tests). */
export function readPiece(bytes, q) {
    const k = q * PIECE_BYTES;
    return { hr: bytes[k] || null, hrLag: bytes[k + 1] || null, counted: bytes[k + 2] / 20, legsS: bytes[k + 3] / 10, speed: bytes[k + 4] / 10 };
}
