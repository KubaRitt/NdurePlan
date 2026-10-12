// NdurePlan - picked or dropped files -> import items (no DOM).
// Files are read one after another and only the small result is kept
// (pieces, laps, totals), so importing a whole season stays light.

import { decodeFit, isFit } from './decode.js';
import { isZip, unzipFit } from './zip.js';
import { analyze } from './analyze.js';

const MANUFACTURER = { 1: 'Garmin', 15: 'Garmin', 23: 'Suunto', 32: 'Wahoo', 123: 'Polar', 260: 'Zwift', 265: 'Strava', 294: 'Coros' };

/** FIT sport + sub sport -> app sport and session type. `known` false = please check. */
export function mapSport(sport, sub) {
    switch (sport) {
        case 1: return { sport: 'run', discipline: sub === 1 || sub === 45 ? 'Treadmill' : sub === 3 ? 'Trail Run' : sub === 4 ? 'Track' : 'Road Run', known: true };
        case 11: case 17: return { sport: 'run', discipline: 'Trail Run', known: false }; // walking, hiking: never take a planned run by itself
        case 2: return { sport: 'bike', discipline: [5, 6, 58].includes(sub) ? 'Indoor Trainer' : sub === 8 ? 'Mountain Bike' : sub === 46 ? 'Gravel Bike' : 'Road Bike', known: true };
        case 5: return { sport: 'swim', discipline: sub === 18 ? 'Open Water Swim' : 'Pool Swim', known: true };
        case 12: return { sport: 'xc ski', discipline: sub === 42 ? 'Skate XC Ski' : 'Classic XC Ski', known: true };
        case 13: return { sport: 'backcountry ski', discipline: sub === 37 ? 'Backcountry Ski' : 'Ski Touring', known: true };
        case 4: case 10:
            if ([19, 43, 44].includes(sub)) return { sport: 'strength', discipline: 'Core / mobility', known: true };
            if (sub === 20) return { sport: 'strength', discipline: 'Strength', known: true };
            return { sport: 'strength', discipline: 'Strength', known: false };
        default: return { sport: 'run', discipline: 'Road Run', known: false };
    }
}

const pad = n => String(n).padStart(2, '0');

/** Local date and clock time of the start. Uses the watch's own time zone when the file has it. */
export function localStart(startUnix, offsetS) {
    if (Number.isFinite(offsetS) && Math.abs(offsetS) <= 14 * 3600) {
        const d = new Date((startUnix + offsetS) * 1000);
        return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
    }
    const d = new Date(startUnix * 1000);
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

// A multisport file (triathlon, duathlon) holds one session per sport:
// split it into one activity per sport, skipping transitions.
export function splitSessions(fit) {
    const ss = (fit.sessions || []).filter(s => Number.isFinite(s.startTime));
    if (ss.length <= 1) return [fit];
    return ss.filter(s => s.sport !== 3).map(s => {
        const a = s.startTime;
        const b = Number.isFinite(s.timestamp) && s.timestamp > a ? s.timestamp : a + (s.elapsed || 0);
        const keep = [];
        fit.rec.t.forEach((t, i) => { if (t >= a && t <= b) keep.push(i); });
        const pick = arr => keep.map(i => arr[i]);
        return {
            ...fit,
            sessions: [s],
            laps: fit.laps.filter(l => l.startTime >= a && l.startTime < b),
            events: fit.events.filter(e => e.t >= a && e.t <= b),
            rec: { t: pick(fit.rec.t), hr: pick(fit.rec.hr), dist: pick(fit.rec.dist), alt: pick(fit.rec.alt), spd: pick(fit.rec.spd), cad: pick(fit.rec.cad) }
        };
    }).filter(f => f.rec.t.length >= 2);
}

function itemFromFit(fit, fileName, part) {
    const s = fit.sessions[0] || {};
    const lapSport = (fit.laps.find(l => Number.isFinite(l.sport)) || {}).sport;
    const mapped = mapSport(s.sport ?? lapSport, s.subSport);
    const an = analyze(fit, { sport: mapped.sport });
    const start = Number.isFinite(s.startTime) ? s.startTime : an.start;
    const act = fit.activity || {};
    const offset = Number.isFinite(act.localTimestamp) && Number.isFinite(act.timestamp) ? act.localTimestamp - act.timestamp : NaN;
    const { date, time } = localStart(start, offset);
    const fid = fit.fileId || {};
    let uid = fid.serial
        ? `${fid.manufacturer ?? 0}-${fid.serial}-${fid.timeCreated ?? Math.round(start)}`
        : `t${Math.round(start)}-${s.sport ?? 'x'}-${an.totals.distance_m ?? 0}`;
    if (part !== null) uid += `-${part}`;
    return {
        key: uid,
        uid,
        fileName,
        start,
        date,
        time,
        sport: mapped.sport,
        discipline: mapped.discipline,
        sportKnown: mapped.known,
        label: fit.sportName || mapped.discipline,
        device: MANUFACTURER[fid.manufacturer] || null,
        fitSport: s.sport ?? null,
        fitSubSport: s.subSport ?? null,
        truncated: !!fit.truncated,
        ...an
    };
}

/** One FIT file -> one import item (or one per sport for multisport files). */
export function fromFit(fileName, data) {
    const fit = decodeFit(data);
    const parts = splitSessions(fit);
    return parts.map((f, i) => itemFromFit(f, fileName, parts.length > 1 ? i : null));
}

/**
 * @param files      FileList / File[] (.fit or Garmin .zip)
 * @param onProgress (doneFiles, totalFiles)
 * @returns items: activity items, or { fileName, error } for files that couldn't be read
 */
export async function readFiles(files, { onProgress = () => {} } = {}) {
    const list = Array.from(files);
    const items = [];
    for (let i = 0; i < list.length; i++) {
        const file = list[i];
        let entries = [];
        try {
            const u8 = new Uint8Array(await file.arrayBuffer());
            if (isZip(u8)) {
                entries = await unzipFit(u8);
                if (!entries.length) throw new Error('There is no .fit file in this ZIP.');
            } else if (isFit(u8)) {
                entries = [{ name: file.name, data: u8 }];
            } else {
                throw new Error('This is not a FIT or ZIP file.');
            }
        } catch (e) {
            items.push({ fileName: file.name, error: e.message || 'Couldn’t read this file.' });
        }
        for (const en of entries) {
            try { items.push(...fromFit(en.name, en.data)); }
            catch (e) { items.push({ fileName: en.name, error: e.message || 'Couldn’t read this file.' }); }
        }
        onProgress(i + 1, list.length);
        await new Promise(r => setTimeout(r, 0)); // let the page breathe between files
    }
    return items;
}
