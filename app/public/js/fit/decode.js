// NdurePlan - small FIT file decoder.
// Reads only what the load calculation needs: file id, sport, session and lap
// summaries, timer events and the per-second records (time, HR, distance,
// altitude, speed, cadence). Records are kept as columns of plain numbers
// (NaN = missing), which is far smaller than one object per second.
// No DOM, no network: works in the browser and in Node (tests).

export const FIT_EPOCH = 631065600; // seconds from 1970-01-01 to 1989-12-31
// FIT times below this are "seconds since the watch was switched on", not real dates.
const MIN_REAL_TIME = 0x10000000;

// Base types: index (low 5 bits) -> [bytes, invalid value, reader]
const BASE = [
    [1, 0xFF, 'u8'],          // 0 enum
    [1, 0x7F, 's8'],          // 1 sint8
    [1, 0xFF, 'u8'],          // 2 uint8
    [2, 0x7FFF, 's16'],       // 3 sint16
    [2, 0xFFFF, 'u16'],       // 4 uint16
    [4, 0x7FFFFFFF, 's32'],   // 5 sint32
    [4, 0xFFFFFFFF, 'u32'],   // 6 uint32
    [1, null, 'str'],         // 7 string
    [4, null, 'f32'],         // 8 float32
    [8, null, 'f64'],         // 9 float64
    [1, 0, 'u8'],             // 10 uint8z
    [2, 0, 'u16'],            // 11 uint16z
    [4, 0, 'u32'],            // 12 uint32z
    [1, 0xFF, 'u8'],          // 13 byte
    [8, null, 'skip'],        // 14 sint64
    [8, null, 'skip'],        // 15 uint64
    [8, null, 'skip']         // 16 uint64z
];

// global message -> field number -> [name, scale, offset]
const WANT = {
    0: { 0: ['type'], 1: ['manufacturer'], 2: ['product'], 3: ['serial'], 4: ['timeCreated'] },
    12: { 0: ['sport'], 1: ['subSport'], 3: ['name'] },
    18: {
        253: ['timestamp'], 2: ['startTime'], 5: ['sport'], 6: ['subSport'], 7: ['elapsed', 1000], 8: ['timer', 1000],
        9: ['distance', 100], 16: ['avgHr'], 17: ['maxHr'], 22: ['ascent'], 23: ['descent']
    },
    19: {
        253: ['timestamp'], 2: ['startTime'], 7: ['elapsed', 1000], 8: ['timer', 1000], 9: ['distance', 100],
        15: ['avgHr'], 16: ['maxHr'], 21: ['ascent'], 22: ['descent'], 24: ['trigger'], 25: ['sport']
    },
    20: {
        253: ['timestamp'], 2: ['altitude', 5, 500], 3: ['hr'], 4: ['cadence'], 5: ['distance', 100],
        6: ['speed', 1000], 73: ['enhancedSpeed', 1000], 78: ['enhancedAltitude', 5, 500], 8: ['csd']
    },
    21: { 253: ['timestamp'], 0: ['event'], 1: ['eventType'] },
    34: { 253: ['timestamp'], 5: ['localTimestamp'] }
};

export class FitError extends Error {
    constructor(msg) { super(msg); this.name = 'FitError'; }
}

export function isFit(u8) {
    return u8 && u8.length >= 12 && u8[8] === 0x2E && u8[9] === 0x46 && u8[10] === 0x49 && u8[11] === 0x54; // ".FIT"
}

function readValue(dv, pos, kind, little) {
    switch (kind) {
        case 'u8': return dv.getUint8(pos);
        case 's8': return dv.getInt8(pos);
        case 'u16': return dv.getUint16(pos, little);
        case 's16': return dv.getInt16(pos, little);
        case 'u32': return dv.getUint32(pos, little);
        case 's32': return dv.getInt32(pos, little);
        case 'f32': return dv.getFloat32(pos, little);
        case 'f64': return dv.getFloat64(pos, little);
        default: return NaN;
    }
}

function readString(u8, pos, size) {
    let end = pos;
    while (end < pos + size && u8[end] !== 0) end++;
    try { return new TextDecoder().decode(u8.subarray(pos, end)); } catch { return ''; }
}

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @returns decoded activity (see bottom of function)
 */
export function decodeFit(input) {
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!isFit(u8)) throw new FitError('This is not a FIT file.');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

    const out = {
        fileId: null, sportName: null,
        sessions: [], laps: [], events: [], activity: null,
        rec: { t: [], hr: [], dist: [], alt: [], spd: [], cad: [] },
        truncated: false
    };
    const rec = out.rec;
    let lastTs = 0;
    let csdRaw = null, csdTotal = 0; // old devices: compressed speed + rolling distance

    const onMessage = (global, m) => {
        if (global === 20) {
            const raw = m.timestamp ?? lastTs;
            if (raw < MIN_REAL_TIME) return; // before the watch knew the time
            const t = raw + FIT_EPOCH;
            const hr = m.hr > 0 ? m.hr : NaN;
            let dist = m.distance ?? NaN;
            const alt = m.enhancedAltitude ?? m.altitude ?? NaN;
            let spd = m.enhancedSpeed ?? m.speed ?? NaN;
            if (m.csd && Number.isNaN(dist)) {
                const [b0, b1, b2] = m.csd;
                const d12 = ((b1 >> 4) | (b2 << 4)) & 0xFFF;
                if (csdRaw !== null) csdTotal += ((d12 - csdRaw) & 0xFFF) / 16;
                csdRaw = d12;
                dist = csdTotal;
                if (Number.isNaN(spd)) spd = (b0 | ((b1 & 0x0F) << 8)) / 100;
            }
            const cad = m.cadence ?? NaN;
            const n = rec.t.length;
            if (n && rec.t[n - 1] === t) {
                // Same second written twice (different sensors): fill the gaps.
                if (Number.isNaN(rec.hr[n - 1])) rec.hr[n - 1] = hr;
                if (Number.isNaN(rec.dist[n - 1])) rec.dist[n - 1] = dist;
                if (Number.isNaN(rec.alt[n - 1])) rec.alt[n - 1] = alt;
                if (Number.isNaN(rec.spd[n - 1])) rec.spd[n - 1] = spd;
                if (Number.isNaN(rec.cad[n - 1])) rec.cad[n - 1] = cad;
                return;
            }
            // out-of-order records are kept; analyze() sorts them and drops strays
            rec.t.push(t); rec.hr.push(hr); rec.dist.push(dist); rec.alt.push(alt); rec.spd.push(spd); rec.cad.push(cad);
        } else if (global === 19 || global === 18) {
            const o = { ...m };
            ['timestamp', 'startTime'].forEach(k => { if (o[k] !== undefined) o[k] += FIT_EPOCH; });
            (global === 19 ? out.laps : out.sessions).push(o);
        } else if (global === 21) {
            if (m.event === 0 && m.eventType !== undefined) out.events.push({ t: (m.timestamp ?? lastTs) + FIT_EPOCH, type: m.eventType });
        } else if (global === 0) {
            if (!out.fileId) out.fileId = { ...m, timeCreated: m.timeCreated !== undefined ? m.timeCreated + FIT_EPOCH : undefined };
        } else if (global === 34) {
            out.activity = {
                timestamp: m.timestamp !== undefined ? m.timestamp + FIT_EPOCH : undefined,
                localTimestamp: m.localTimestamp !== undefined ? m.localTimestamp + FIT_EPOCH : undefined
            };
        } else if (global === 12) {
            if (!out.sportName && m.name) out.sportName = m.name;
        }
    };

    let off = 0;
    let fileCount = 0;
    while (off + 12 <= u8.length) {
        if (!isFit(u8.subarray(off))) {
            if (fileCount === 0) throw new FitError('This is not a FIT file.');
            break; // trailing bytes after the last file
        }
        const hSize = u8[off];
        const dataSize = dv.getUint32(off + 4, true);
        let pos = off + hSize;
        let end = pos + dataSize;
        if (end > u8.length) { end = u8.length; out.truncated = true; }
        const defs = new Map();
        fileCount++;

        while (pos < end) {
            const h = u8[pos++];
            let local, compressedTs = null;
            if (h & 0x80) {
                // compressed timestamp header
                local = (h >> 5) & 0x03;
                const offset = h & 0x1F;
                let ts = (lastTs & 0xFFFFFFE0) + offset;
                if (offset < (lastTs & 0x1F)) ts += 0x20;
                lastTs = ts >>> 0;
                compressedTs = lastTs;
            } else if (h & 0x40) {
                // definition message
                local = h & 0x0F;
                const hasDev = (h & 0x20) !== 0;
                if (pos + 5 > end) { out.truncated = true; break; }
                const little = u8[pos + 1] === 0;
                const global = dv.getUint16(pos + 2, little);
                const nFields = u8[pos + 4];
                pos += 5;
                const fields = [];
                for (let i = 0; i < nFields; i++) {
                    fields.push({ num: u8[pos], size: u8[pos + 1], base: u8[pos + 2] & 0x1F });
                    pos += 3;
                }
                let devSize = 0;
                if (hasDev) {
                    const nDev = u8[pos++];
                    for (let i = 0; i < nDev; i++) { devSize += u8[pos + 1]; pos += 3; }
                }
                let size = devSize;
                fields.forEach(f => { size += f.size; });
                defs.set(local, { little, global, fields, devSize, size });
                continue;
            } else {
                local = h & 0x0F;
            }

            const def = defs.get(local);
            if (!def) throw new FitError('This FIT file is damaged (data before its definition).');
            if (pos + def.size > end) { out.truncated = true; break; }
            const want = WANT[def.global];
            if (want) {
                const m = {};
                let p = pos;
                for (const f of def.fields) {
                    const w = want[f.num];
                    if (w) {
                        const bt = BASE[f.base] || BASE[13];
                        const [bytes, invalid, kind] = bt;
                        if (w[0] === 'csd') {
                            if (f.size === 3) m.csd = [u8[p], u8[p + 1], u8[p + 2]];
                        } else if (kind === 'str') {
                            const s = readString(u8, p, f.size);
                            if (s) m[w[0]] = s;
                        } else if (kind !== 'skip' && f.size >= bytes) {
                            const v = readValue(dv, p, kind, def.little);
                            const bad = invalid === null ? !Number.isFinite(v) : v === invalid;
                            if (!bad) {
                                let val = v;
                                if (w[1]) val = val / w[1];
                                if (w[2]) val = val - w[2];
                                m[w[0]] = val;
                            }
                        }
                    }
                    p += f.size;
                }
                if (m.timestamp !== undefined) lastTs = m.timestamp;
                if (compressedTs !== null && m.timestamp === undefined) m.timestamp = compressedTs;
                onMessage(def.global, m);
            } else {
                // Messages we don't read still carry timestamps that compressed headers build on.
                const tsField = def.fields.findIndex(f => f.num === 253 && f.size === 4);
                if (tsField >= 0) {
                    let p = pos;
                    for (let i = 0; i < tsField; i++) p += def.fields[i].size;
                    const v = dv.getUint32(p, def.little);
                    if (v !== 0xFFFFFFFF) lastTs = v;
                }
            }
            pos += def.size;
        }
        off = end + 2; // skip the CRC
    }

    return out; // all times in Unix seconds
}
