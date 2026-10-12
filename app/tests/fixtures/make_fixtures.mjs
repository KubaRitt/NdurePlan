// Builds the FIT test files with Garmin's own encoder (npm i -D @garmin/fitsdk).
// Run: node tests/fixtures/make_fixtures.mjs   (the .fit files are committed, so tests don't need this)
import { Encoder, Profile } from '@garmin/fitsdk';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const FIT_EPOCH = 631065600;

/**
 * segments: { sec, hr, speed (m/s), grade, stand, pause, lap, noHr, cadLock, step }
 *   stand   standing still with the timer running
 *   pause   timer stopped: no records, stop/start events
 *   lap     start a new lap at this segment (default true)
 *   step    seconds between records (smart recording)
 */
function simulate(segments, start, seed = 7) {
    let rnd = seed;
    const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647 - 0.5);
    const recs = [], laps = [], events = [{ t: 0, type: 'start' }];
    let hr = 95, dist = 0, alt = 300, t = 0, lapStart = 0, lapDist = 0;
    const closeLap = () => {
        if (t > lapStart) laps.push({ start: lapStart, end: t, dist: dist - lapDist });
        lapStart = t; lapDist = dist;
    };
    for (const seg of segments) {
        if (seg.lap !== false) closeLap();
        if (seg.pause) {
            events.push({ t, type: 'stop' });
            t += seg.sec;
            events.push({ t, type: 'start' });
            continue;
        }
        for (let i = 0; i < seg.sec;) {
            const dt = typeof seg.step === 'function' ? seg.step() : (seg.step || 1);
            i += dt;
            const grade = seg.grade || 0;
            const speed = seg.stand ? 0 : seg.speed * (1 + rand() * 0.03);
            const target = (seg.stand ? (seg.hr ?? Math.max(100, hr - 25)) : seg.hr) + grade * 120;
            hr += (target - hr) / (target > hr ? 25 : 45) * dt + rand() * 1.2;
            dist += speed * dt;
            alt += speed * grade * dt;
            t += dt;
            const cadence = seg.stand ? 0 : Math.round((seg.cadence || 86) + rand() * 3);
            const r = { timestamp: new Date(start.getTime() + t * 1000), distance: dist, enhancedSpeed: speed, enhancedAltitude: alt };
            if (!seg.noHr) r.heartRate = seg.cadLock && !seg.stand ? cadence * 2 : Math.round(hr);
            if (!seg.stand) r.cadence = cadence;
            recs.push(r);
        }
    }
    closeLap();
    events.push({ t, type: 'stopAll' });
    return { recs, laps, events, total: t, dist };
}

function write(name, { segments, start, sport = 'running', subSport = 'generic', seed }) {
    const { recs, laps, events, total, dist } = simulate(segments, start, seed);
    const at = s => new Date(start.getTime() + s * 1000);
    const e = new Encoder();
    e.onMesg(Profile.MesgNum.FILE_ID, { manufacturer: 'garmin', product: 3990, serialNumber: 3412345678, timeCreated: start, type: 'activity' });
    // events and records in time order
    const items = [
        ...events.map(ev => ({ t: ev.t, k: 0, m: () => e.onMesg(Profile.MesgNum.EVENT, { timestamp: at(ev.t), event: 'timer', eventType: ev.type }) })),
        ...recs.map(r => ({ t: (r.timestamp - start) / 1000, k: 1, m: () => e.onMesg(Profile.MesgNum.RECORD, r) }))
    ].sort((a, b) => a.t - b.t || a.k - b.k);
    items.forEach(i => i.m());
    laps.forEach((l, i) => e.onMesg(Profile.MesgNum.LAP, {
        messageIndex: i, startTime: at(l.start), timestamp: at(l.end), totalElapsedTime: l.end - l.start, totalTimerTime: l.end - l.start,
        totalDistance: l.dist, event: 'lap', eventType: 'stop', sport
    }));
    const hrs = recs.filter(r => r.heartRate).map(r => r.heartRate);
    e.onMesg(Profile.MesgNum.SESSION, {
        timestamp: at(total), startTime: start, totalElapsedTime: total, totalTimerTime: total, totalDistance: dist,
        sport, subSport, firstLapIndex: 0, numLaps: laps.length, event: 'session', eventType: 'stop',
        ...(hrs.length ? { avgHeartRate: Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length), maxHeartRate: Math.max(...hrs) } : {})
    });
    e.onMesg(Profile.MesgNum.ACTIVITY, {
        timestamp: at(total), numSessions: 1, type: 'manual', event: 'activity', eventType: 'stop', totalTimerTime: total,
        localTimestamp: Math.round(at(total).getTime() / 1000) + 7200 - FIT_EPOCH
    });
    const bytes = e.close();
    fs.writeFileSync(path.join(DIR, name), bytes);
    console.log(name, bytes.length, 'bytes,', recs.length, 'records,', laps.length, 'laps');
    return bytes;
}

const easy = { hr: 150, speed: 1000 / 295 };
const jog = { hr: 145, speed: 1000 / 330 };
const ap2 = { hr: 182, speed: 1000 / 230 };

const threshold = write('threshold.fit', {
    start: new Date('2026-10-06T14:30:00Z'),
    segments: [{ ...easy, sec: 900 }, ...[1, 2, 3, 4].flatMap(i => i < 4 ? [{ ...ap2, sec: 360 }, { ...jog, sec: 60 }] : [{ ...ap2, sec: 360 }]), { ...easy, sec: 900 }]
});

const hill = up => ({ hr: 150, speed: 1000 / 300, sec: 360, grade: up ? 0.09 : -0.09 });
write('hills.fit', {
    start: new Date('2026-10-04T07:00:00Z'), subSport: 'trail',
    segments: [{ ...easy, sec: 600 }, hill(true), hill(false), { ...easy, sec: 300 }, hill(true), hill(false), { ...easy, sec: 300 }, hill(true), hill(false), { ...easy, sec: 240 }]
});

// 58 min on the watch: 3 min paused, 2 min standing (counted), 12 + 8 min standing (not counted).
write('stops.fit', {
    start: new Date('2026-10-05T15:00:00Z'), subSport: 'street',
    segments: [
        { ...easy, sec: 600 },
        { stand: true, sec: 120, lap: false },
        { ...easy, sec: 480, lap: false },
        { pause: true, sec: 180, lap: false },
        { ...easy, sec: 420, lap: false },
        { stand: true, sec: 720, lap: false },
        { ...easy, sec: 480 },
        { stand: true, sec: 480, lap: false }
    ]
});

write('cadence-lock.fit', { start: new Date('2026-10-03T16:00:00Z'), segments: [{ ...easy, sec: 1800, cadLock: true, cadence: 87 }] });
write('no-hr.fit', { start: new Date('2026-10-02T16:00:00Z'), segments: [{ ...easy, sec: 1800, noHr: true }] });
write('strength.fit', {
    start: new Date('2026-10-07T16:00:00Z'), sport: 'training', subSport: 'strengthTraining',
    segments: [{ stand: true, hr: 115, sec: 2400 }]
});
// Smart recording: a record every 1-7 s.
let k = 0;
const smartStep = () => [1, 3, 7, 2, 5][k++ % 5];
write('smart.fit', { start: new Date('2026-10-01T06:30:00Z'), segments: [{ ...easy, sec: 1500, step: smartStep }] });

// A Garmin Connect style ZIP around threshold.fit (deflate).
function crc32(buf) { return zlib.crc32(buf) >>> 0; }
function zip(entries) {
    const locals = [], central = [];
    let off = 0;
    for (const { name, data } of entries) {
        const comp = zlib.deflateRawSync(data);
        const nameB = Buffer.from(name);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034B50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
        lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
        lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014B50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
        ch.writeUInt32LE(crc32(data), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
        ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(off, 42);
        locals.push(lh, nameB, comp);
        central.push(ch, nameB);
        off += 30 + nameB.length + comp.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054B50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
    return Buffer.concat([...locals, cd, end]);
}
fs.writeFileSync(path.join(DIR, 'garmin-export.zip'), zip([{ name: '20261006_ACTIVITY.fit', data: Buffer.from(threshold) }, { name: 'notes.txt', data: Buffer.from('not a fit file') }]));
console.log('garmin-export.zip');
