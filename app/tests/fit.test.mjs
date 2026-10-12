// FIT decoding, ZIP reading and load calculation from recorded files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeFit, FitError, FIT_EPOCH } from '../public/js/fit/decode.js';
import { unzipFit, isZip } from '../public/js/fit/zip.js';
import { analyze, loadsFromPieces, encodePieces, decodePieces, readPiece, PIECE_BYTES, NoDataError } from '../public/js/fit/analyze.js';
import { fromFit, readFiles, mapSport, localStart, splitSessions } from '../public/js/fit/importer.js';
import { heartPerMin, effort, downhillFactor, surfaceOf, legsFactor } from '../public/js/loads.js';

const FX = new URL('./fixtures/', import.meta.url);
const read = name => new Uint8Array(fs.readFileSync(new URL(name, FX)));
const RUN = { easy: 158, ap1: 172, ap2: 181, ap3: 195 };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ± ${tol}, got ${a}`);

// ---------------------------------------------------------------------------
// formulas
// ---------------------------------------------------------------------------

test('heart per minute: Easy 1, AP2 3, lactate-like', () => {
    near(heartPerMin(158, RUN), 1, 1e-9);
    near(heartPerMin(181, RUN), 3, 1e-9);
    near(heartPerMin(195, RUN), 5.9, 0.05);
    near(heartPerMin(140, RUN), 0.42, 0.01);
});

test('legs effort: 1 at Easy, 1.3 at AP3, never below 0.5', () => {
    near(effort(158, RUN), 1, 1e-9);
    near(effort(195, RUN), 1.3, 1e-9);
    near(effort(181, RUN), 1.186, 0.001);
    assert.equal(effort(60, RUN), 0.5);
    near(downhillFactor(-0.1), 1.34, 1e-9);
    assert.equal(downhillFactor(0.1), 1);
    near(downhillFactor(-0.5), 1 + 3.4 * 0.3, 1e-9); // capped at 30 %
});

test('surface and sport factors', () => {
    assert.equal(surfaceOf({ discipline: 'Road Run' }), 'road');
    assert.equal(surfaceOf({ discipline: 'Trail Run' }), 'trail');
    assert.equal(surfaceOf({ discipline: 'Trail Run', orienteering: true }), 'orienteering');
    assert.equal(surfaceOf({ discipline: 'Orienteering' }), 'orienteering');
    assert.equal(legsFactor('run', 'trail'), 0.85);
    assert.equal(legsFactor('bike', 'road'), 0.25);
    assert.equal(legsFactor('volleyball'), 0.25);
});

// ---------------------------------------------------------------------------
// decoder
// ---------------------------------------------------------------------------

test('decodes a Garmin-encoded activity', () => {
    const fit = decodeFit(read('threshold.fit'));
    assert.equal(fit.rec.t.length, 3420);
    assert.equal(fit.laps.length, 9);
    assert.equal(fit.sessions[0].sport, 1);
    assert.equal(fit.fileId.serial, 3412345678);
    assert.equal(fit.rec.t[0], Date.parse('2026-10-06T14:30:01Z') / 1000);
    near(fit.sessions[0].distance, 12910, 20);
    assert.ok(fit.rec.hr.every(Number.isFinite));
    assert.ok(fit.activity.localTimestamp - fit.activity.timestamp === 7200);
});

test('matches Garmin’s own decoder record by record', async t => {
    let sdk;
    try { sdk = await import('@garmin/fitsdk'); } catch { t.skip('@garmin/fitsdk not installed'); return; }
    for (const f of ['threshold.fit', 'hills.fit', 'stops.fit', 'smart.fit']) {
        const ours = decodeFit(read(f));
        const theirs = new sdk.Decoder(sdk.Stream.fromByteArray(Array.from(read(f)))).read().messages.recordMesgs;
        assert.equal(ours.rec.t.length, theirs.length, f);
        theirs.forEach((r, i) => {
            assert.equal(ours.rec.t[i], r.timestamp.getTime() / 1000);
            if (r.heartRate !== undefined) assert.equal(ours.rec.hr[i], r.heartRate);
            near(ours.rec.dist[i], r.distance, 0.01);
            near(ours.rec.alt[i], r.enhancedAltitude, 0.2);
        });
    }
});

test('rejects files that are not FIT, keeps what it can from cut-off files', () => {
    assert.throws(() => decodeFit(new Uint8Array(64)), FitError);
    const full = read('threshold.fit');
    const half = decodeFit(full.slice(0, Math.floor(full.length / 2)));
    assert.equal(half.truncated, true);
    assert.ok(half.rec.t.length > 1000 && half.rec.t.length < 3420);
});

// Hand-built file: developer fields and compressed timestamp headers.
function tinyFit() {
    const body = [];
    const u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
    // local 0 = record with timestamp, HR and a 2-byte developer field
    body.push(0x40 | 0x20, 0, 0, 20, 0, 2, 253, 4, 0x86, 3, 1, 0x02, 1, 0, 2, 0);
    body.push(0x00, ...u32(1100000008), 100, 0xAB, 0xCD); // 2024; low 5 bits = 8
    // local 1 = record without timestamp (for compressed headers): HR only
    body.push(0x41, 0, 0, 20, 0, 1, 3, 1, 0x02);
    body.push(0x80 | (1 << 5) | 9, 101);  // offset 9 => ...009
    body.push(0x80 | (1 << 5) | 5, 102);  // 5 < 9 => rolls over: ...000 + 32 + 5 = ...037
    const head = [14, 0x20, 0x08, 0x08, ...u32(body.length), 0x2E, 0x46, 0x49, 0x54, 0, 0];
    return new Uint8Array([...head, ...body, 0, 0]);
}

test('developer fields are skipped and compressed timestamps rebuilt', () => {
    const fit = decodeFit(tinyFit());
    assert.deepEqual(fit.rec.hr, [100, 101, 102]);
    assert.deepEqual(fit.rec.t.map(t => t - FIT_EPOCH), [1100000008, 1100000009, 1100000037]);
});

test('power-on times, stray dates and out-of-order records', () => {
    const base = decodeFit(read('threshold.fit'));
    const r = base.rec;
    // a record before the watch knew the time is dropped by the decoder (tested via the hand-built file)
    const u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
    const body = [0x40, 0, 0, 20, 0, 2, 253, 4, 0x86, 3, 1, 0x02, 0x00, ...u32(5000), 99, 0x00, ...u32(1100000000), 100];
    const head = [14, 0x20, 0x08, 0x08, ...u32(body.length), 0x2E, 0x46, 0x49, 0x54, 0, 0];
    assert.deepEqual(decodeFit(new Uint8Array([...head, ...body, 0, 0])).rec.hr, [100]);
    // one record dated years ahead and two swapped records: analysis still sees one hour
    const fit = { ...base, rec: { ...r, t: [...r.t] } };
    fit.rec.t[100] = r.t[100] + 86400 * 400;
    [fit.rec.t[200], fit.rec.t[201]] = [fit.rec.t[201], fit.rec.t[200]];
    const an = analyze(fit, { sport: 'run' });
    near(an.totals.elapsed_s, 3419, 2);
    // without a session window a multi-day file is refused
    const noSess = { ...fit, sessions: [] };
    assert.throws(() => analyze(noSess, { sport: 'run' }), /48 hours/);
});

test('reads the .fit inside a Garmin Connect ZIP', async () => {
    const z = read('garmin-export.zip');
    assert.ok(isZip(z));
    const files = await unzipFit(z);
    assert.equal(files.length, 1);
    assert.equal(files[0].name, '20261006_ACTIVITY.fit');
    assert.deepEqual(files[0].data, read('threshold.fit'));
});

// ---------------------------------------------------------------------------
// analysis
// ---------------------------------------------------------------------------

function run(file, sport = 'run') {
    const an = analyze(decodeFit(read(file)), { sport });
    const loads = loadsFromPieces(an.pieces, an.laps, { sport, zones: RUN, surface: 'road', hrQuality: an.hrQuality });
    return { an, loads };
}

test('threshold run: everything counted, lap loads add up', () => {
    const { an, loads } = run('threshold.fit');
    assert.equal(an.totals.counted_s, an.totals.elapsed_s);
    assert.equal(an.totals.excluded_s, 0);
    assert.equal(an.hrQuality, 'ok');
    assert.equal(an.laps.length, 9);
    near(loads.heart, 97, 3, 'heart');
    near(loads.legs, 59.7, 1, 'legs');
    near(loads.laps.reduce((a, l) => a + l.heart, 0), loads.heart, 0.6);
    near(loads.laps.reduce((a, l) => a + l.legs, 0), loads.legs, 0.6);
    // laps cover the pieces without gaps
    an.laps.forEach((l, i) => { if (i) assert.equal(l.i0, an.laps[i - 1].i1); });
    assert.equal(an.laps.at(-1).i1 * PIECE_BYTES, an.pieces.length);
    // reps are ~6 min at AP2: lap heart ~3 per minute
    const rep = loads.laps[1];
    near(rep.heart / 6, 2.9, 0.5, 'rep heart per minute');
    // 10 s pieces: about 1.7 kB per hour
    assert.ok(an.pieces.length < 2000);
});

test('stops: pauses never count, short stops count for Heart only, stops over 5 min not at all', () => {
    const { an } = run('stops.fit');
    const T = an.totals;
    near(T.paused_s, 180, 3, 'paused');
    near(T.excluded_s, 1200, 25, 'long stops cut');
    near(T.counted_s, 2100, 25, 'counted');
    near(T.counted_s - T.moving_s, 120, 25, 'the 2 min stop is counted but not moving');
    near(T.elapsed_s, 3480, 2, 'elapsed');
});

test('downhill running adds legs load, uphill shows in HR', () => {
    const { an, loads } = run('hills.fit');
    // same run with the slope ignored: sum of moving minutes x HR effort
    let flat = 0;
    for (let q = 0; q < an.pieces.length / PIECE_BYTES; q++) {
        const p = readPiece(an.pieces, q);
        flat += p.counted / 60 * effort(p.hrLag || p.hr, RUN);
    }
    assert.ok(loads.legs > flat * 1.05, `downhill should add load (${loads.legs} vs ${flat})`);
    near(loads.legs, 60.9, 1.5);
});

test('HR locked to cadence or missing: no Heart, Legs from the fallback effort', () => {
    const lock = run('cadence-lock.fit');
    assert.equal(lock.an.hrQuality, 'cadence');
    assert.equal(lock.loads.heart, null);
    near(lock.loads.legs, 30, 0.5);
    const none = run('no-hr.fit');
    assert.equal(none.an.hrQuality, 'none');
    const withPlan = loadsFromPieces(none.an.pieces, none.an.laps, { sport: 'run', zones: RUN, surface: 'road', hrQuality: 'none', fallbackEffort: 1.19 });
    near(withPlan.legs, 30 * 1.19, 0.6);
});

test('smart recording (a record every 1-7 s) works the same', () => {
    const { an, loads } = run('smart.fit');
    near(an.totals.counted_s, 1500, 10);
    near(loads.heart, 25 * heartPerMin(149, RUN), 2.5);
});

test('strength file: Heart from HR, Legs left to RPE', () => {
    const { an, loads } = run('strength.fit', 'strength');
    assert.equal(an.hasDistance, false);
    assert.equal(an.totals.counted_s, an.totals.elapsed_s);
    assert.equal(loads.legs, null);
    assert.ok(loads.heart > 3 && loads.heart < 10);
});

test('pieces survive storage and recalculate with new zones and surface', () => {
    const { an, loads } = run('threshold.fit');
    const back = decodePieces(encodePieces(an.pieces));
    assert.deepEqual(back, an.pieces);
    const same = loadsFromPieces(back, an.laps, { sport: 'run', zones: RUN, surface: 'road' });
    assert.equal(same.heart, loads.heart);
    const higher = loadsFromPieces(back, an.laps, { sport: 'run', zones: { easy: 165, ap1: 178, ap2: 188, ap3: 200 }, surface: 'road' });
    assert.ok(higher.heart < loads.heart * 0.8);
    const orient = loadsFromPieces(back, an.laps, { sport: 'run', zones: RUN, surface: 'orienteering' });
    near(orient.legs, loads.legs * 0.9, 0.2);
});

test('no recorded data -> clear error', () => {
    const fit = { rec: { t: [1], hr: [NaN], dist: [NaN], alt: [NaN], spd: [NaN], cad: [NaN] }, events: [], laps: [], sessions: [] };
    assert.throws(() => analyze(fit), NoDataError);
});

// ---------------------------------------------------------------------------
// import items
// ---------------------------------------------------------------------------

test('file -> import item: local date from the watch, sport, unique id', () => {
    const [it] = fromFit('threshold.fit', read('threshold.fit'));
    assert.equal(it.date, '2026-10-06');
    assert.equal(it.time, '16:30');
    assert.equal(it.sport, 'run');
    assert.equal(it.discipline, 'Road Run');
    assert.equal(it.uid, `1-3412345678-${Date.parse('2026-10-06T14:30:00Z') / 1000}`);
    const [trail] = fromFit('hills.fit', read('hills.fit'));
    assert.equal(trail.discipline, 'Trail Run');
    const [gym] = fromFit('strength.fit', read('strength.fit'));
    assert.equal(gym.sport, 'strength');
});

test('sport mapping and local time', () => {
    assert.deepEqual(mapSport(1, 1), { sport: 'run', discipline: 'Treadmill', known: true });
    assert.equal(mapSport(2, 6).discipline, 'Indoor Trainer');
    assert.equal(mapSport(12, 42).discipline, 'Skate XC Ski');
    assert.equal(mapSport(5, 17).discipline, 'Pool Swim');
    assert.equal(mapSport(99).known, false);
    assert.deepEqual(localStart(Date.parse('2026-10-06T22:30:00Z') / 1000, 7200), { date: '2026-10-07', time: '00:30' });
});

test('multisport files split into one activity per sport', () => {
    const base = decodeFit(read('threshold.fit'));
    const t0 = base.rec.t[0];
    const fit = { ...base, sessions: [
        { sport: 2, startTime: t0, timestamp: t0 + 1200 },
        { sport: 3, startTime: t0 + 1200, timestamp: t0 + 1300 },
        { sport: 1, startTime: t0 + 1300, timestamp: t0 + 3419 }
    ] };
    const parts = splitSessions(fit);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].sessions[0].sport, 2);
    assert.ok(parts[1].rec.t[0] >= t0 + 1300);
});

test('readFiles: FIT, ZIP and junk together', async () => {
    const files = [
        new File([read('garmin-export.zip')], 'export.zip'),
        new File([read('hills.fit')], 'hills.fit'),
        new File([new TextEncoder().encode('hello')], 'notes.txt')
    ];
    const seen = [];
    const items = await readFiles(files, { onProgress: (a, b) => seen.push(`${a}/${b}`) });
    assert.deepEqual(seen, ['1/3', '2/3', '3/3']);
    assert.equal(items.length, 3);
    assert.equal(items[0].date, '2026-10-06');
    assert.equal(items[1].discipline, 'Trail Run');
    assert.match(items[2].error, /not a FIT or ZIP/);
});
