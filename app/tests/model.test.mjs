import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../public/js/model.js';

test('parseDuration: clock, units, bare numbers, commas', () => {
    assert.equal(M.parseDuration('6:00'), 360);
    assert.equal(M.parseDuration('0:35'), 35);
    assert.equal(M.parseDuration('1:30:00'), 5400);
    assert.equal(M.parseDuration('35s'), 35);
    assert.equal(M.parseDuration('35 sec'), 35);
    assert.equal(M.parseDuration('10"'), 10);
    assert.equal(M.parseDuration('6 min'), 360);
    assert.equal(M.parseDuration('1.5h'), 5400);
    assert.equal(M.parseDuration('1h30'), 5400);
    assert.equal(M.parseDuration('1h 30m'), 5400);
    assert.equal(M.parseDuration('6m30s'), 390);
    assert.equal(M.parseDuration('45'), 2700);
    assert.equal(M.parseDuration('6,5'), 390);
    assert.equal(M.parseDuration('90', 'sec'), 90);
    assert.equal(M.parseDuration(''), null);
    assert.equal(M.parseDuration('  '), null);
    assert.ok(Number.isNaN(M.parseDuration('abc')));
    assert.ok(Number.isNaN(M.parseDuration('5:75')));
});

test('parseDistance and parseNumber accept decimal commas and metres', () => {
    assert.equal(M.parseDistance('1,55'), 1.55);
    assert.equal(M.parseDistance('200m'), 0.2);
    assert.equal(M.parseDistance('200 m'), 0.2);
    assert.equal(M.parseDistance('1.5 km'), 1.5);
    assert.equal(M.parseDistance(''), null);
    assert.ok(Number.isNaN(M.parseDistance('far')));
    assert.equal(M.parseNumber('8,5'), 8.5);
    assert.equal(M.parseNumber(''), null);
    assert.ok(Number.isNaN(M.parseNumber('8h')));
});

test('formatting', () => {
    assert.equal(M.fmtClock(360), '6:00');
    assert.equal(M.fmtClock(35), '0:35');
    assert.equal(M.fmtClock(5400), '1:30:00');
    assert.equal(M.fmtDur(35), '35 s');
    assert.equal(M.fmtDur(2700), '45 min');
    assert.equal(M.fmtDur(390), '6:30 min');
    assert.equal(M.fmtDur(21180), '5:53 h');
    assert.equal(M.fmtHours(21150), '5:53 h'); // 352.5 min -> rounds to 353
    assert.equal(M.fmtKm(1.55), '1.55');
    assert.equal(M.fmtKm(10), '10');
    assert.equal(M.fmtPace(35, 0.2), '2:55 /km');
    assert.equal(M.fmtPace(360, 1.55), '3:52 /km');
    assert.equal(M.fmtTime('16:30:00'), '16:30');
});

test('dates: monday, ISO week, ranges, month grid', () => {
    assert.equal(M.mondayOf('2026-10-07'), '2026-10-05');
    assert.equal(M.mondayOf('2026-10-11'), '2026-10-05');
    assert.equal(M.mondayOf('2026-10-05'), '2026-10-05');
    assert.equal(M.addDays('2026-10-25', 1), '2026-10-26'); // DST change in Europe
    assert.equal(M.addDays('2026-03-29', 1), '2026-03-30');
    assert.equal(M.daysBetween('2026-09-28', '2026-10-05'), 7);
    assert.equal(M.isoWeek('2026-10-07'), 41);
    assert.equal(M.isoWeek('2027-01-01'), 53);
    assert.equal(M.isoWeek('2026-01-01'), 1);
    assert.equal(M.fmtWeekRange('2026-10-05'), '5–11 Oct');
    assert.equal(M.fmtWeekRange('2026-09-28'), '28 Sep – 4 Oct');
    const g = M.monthGrid(2026, 9); // October 2026 starts on Thursday
    assert.equal(g.slice(0, 4).filter(x => x === null).length, 3);
    assert.equal(g[3], '2026-10-01');
    assert.equal(g.length % 7, 0);
    assert.equal(M.fmtDayTitle('2026-10-07'), 'Wednesday 7 October');
});

test('legacy blocks in whole minutes still work', () => {
    const b = { type: 'Warm Up', intensity: 'easy', target_hr: 158, time_min: 15, distance_km: 3, repeat: null };
    assert.equal(M.blockDurationS(b), 900);
    const s = M.summarizeBlocks([b]);
    assert.equal(s.duration_s, 900);
    assert.equal(s.heart, 15);
    assert.equal(s.legs, 15);
});

test('threshold 4 x 6:00 AP2 with 1:00 jog', () => {
    const blocks = [
        { type: 'Warm up', intensity: 'easy', duration_s: 900, distance_km: 3 },
        { type: 'AP2', intensity: 'ap2', duration_s: 360, distance_km: 1.55, target_hr: 181,
          repeat: { reps: 4, rest_sec: 60, rest_type: 'moving', rest_intensity: 'easy' } },
        { type: 'Cool down', intensity: 'easy', duration_s: 900, distance_km: 3 }
    ];
    const s = M.summarizeBlocks(blocks);
    assert.equal(s.duration_s, 900 + 4 * 360 + 3 * 60 + 900);
    assert.equal(s.zones.ap2, 1440);
    assert.equal(s.zones.easy, 1800 + 180);
    assert.equal(s.distance_km, 12.2);
    // Heart = 30 min easy + 3 min easy jog + 24 min x 3 at AP2
    assert.equal(s.heart, 30 + 3 + 72);
    // Legs = 33 easy minutes x 1 + 24 AP2 minutes x 1.19 (road)
    assert.equal(s.legs, Math.round(33 + 24 * (1 + 0.3 * 23 / 37)));
    // same session on trails: Legs x 0.85, Heart unchanged
    const trail = M.summarizeBlocks(blocks, M.planCtx({ sport_type: 'run', discipline: 'Trail Run' }));
    assert.equal(trail.heart, s.heart);
    assert.equal(trail.legs, Math.round((33 + 24 * (1 + 0.3 * 23 / 37)) * 0.85));
    assert.equal(s.hard_s, 1440);
    assert.equal(M.describeBlock(blocks[1]), '4 × 6:00 · 1.55 km · 181 bpm · 3:52 /km · 1:00 jog');
});

test('speed session: 10 s hill sprints and 200 m in 35 s are no longer zero', () => {
    const blocks = [
        { type: 'Hill sprints', intensity: 'sprint', duration_s: 10, repeat: { reps: 8, rest_sec: 90, rest_type: 'standing' } },
        { type: '200 m', intensity: 'ap3', duration_s: 35, distance_km: 0.2, repeat: { reps: 8, rest_sec: 120, rest_type: 'moving', rest_intensity: 'easy' } }
    ];
    const s = M.summarizeBlocks(blocks);
    assert.equal(s.zones.sprint, 80);
    assert.equal(s.zones.ap3, 280);
    assert.equal(s.hard_s, 360);
    assert.equal(s.distance_km, 1.6);
    assert.equal(M.describeBlock(blocks[1]), '8 × 0:35 · 0.2 km · 2:55 /km · 2:00 jog');
    // standing rest adds time but no load
    const segs = M.expandBlock(blocks[0]);
    assert.equal(segs.length, 15);
    assert.equal(segs.filter(x => x.kind === 'rest' && x.intensity === null).length, 7);
});

test('start/end with rest and per-rep values', () => {
    const b = { intensity: 'ap2', duration_s: 300, repeat: { reps: 3, rest_sec: 60, start_with: 'rest', end_with: 'rest',
        customized: true, per_rep: [{ duration_s: 300 }, { duration_s: 240 }, { duration_s: 180 }] } };
    const segs = M.expandBlock(b);
    assert.deepEqual(segs.map(x => x.kind), ['rest', 'work', 'rest', 'work', 'rest', 'work', 'rest']);
    assert.deepEqual(segs.filter(x => x.kind === 'work').map(x => x.duration_s), [300, 240, 180]);
});

test('strength uses RPE: 30 min at RPE 6 = Heart 3, Legs 30', () => {
    const s = M.summarizeBlocks([{ type: 'Gym', intensity: 'strength', duration_s: 1800, rpe: 6 }]);
    assert.equal(s.heart, 3);
    assert.equal(s.legs, 30);
    assert.equal(s.zones.strength, 1800);
    const n = M.normalizeBlock({ intensity: 'strength', duration_s: 1800, target_hr: 120 });
    assert.equal(n.target_hr, null);
    assert.equal(n.rpe, 6);
});

test('serializeBlock keeps time_min for old readers and drops bad values', () => {
    const out = M.serializeBlock({ type: 'x', intensity: 'nonsense', duration_s: '35', distance_km: '', repeat: { reps: 1 } });
    assert.equal(out.intensity, 'easy');
    assert.equal(out.duration_s, 35);
    assert.equal(out.time_min, 0.58);
    assert.equal(out.distance_km, null);
    assert.equal(out.repeat, null);
});

test('sessionDone: as planned, with diary values, strength with RPE', () => {
    const run = { sport_type: 'run', done: true, blocks: [{ intensity: 'easy', duration_s: 2700, distance_km: 9 }] };
    assert.deepEqual(M.sessionDone(run), { duration_s: 2700, km: 9, heart: 45, legs: 45, files: 0 });
    const runActual = { ...run, actual: { duration_s: 3000, km: 10 } };
    assert.deepEqual(M.sessionDone(runActual), { duration_s: 3000, km: 10, heart: 50, legs: 50, files: 0 });
    assert.deepEqual(M.sessionDone({ ...run, done: false }), { duration_s: 0, km: 0, heart: 0, legs: 0, files: 0 });
    const gym = { sport_type: 'strength', done: true, rpe: 8, blocks: [{ intensity: 'strength', duration_s: 1800, rpe: 6 }] };
    assert.equal(M.sessionDone(gym).heart, 4);
    assert.equal(M.sessionDone(gym).legs, 40);
});

test('sessionDone with FIT files: file loads win, missing HR borrows the plan, strength Legs from RPE', () => {
    const run = { id: 's1', sport_type: 'run', done: true, actual: { duration_s: 999 }, blocks: [{ intensity: 'easy', duration_s: 2700, distance_km: 9 }] };
    const acts = [
        { duration_s: 1200, distance_m: 3000, hr_load: 14.4, body_load: 18.2 },  // warm-up file
        { duration_s: 2400, distance_m: 7500, hr_load: 150.6, body_load: 49.9 }  // race file
    ];
    assert.deepEqual(M.sessionDone(run, null, acts), { duration_s: 3600, km: 10.5, heart: 165, legs: 68, files: 2 });
    const noHr = [{ duration_s: 1800, distance_m: 6000, hr_load: null, body_load: 30 }];
    assert.equal(M.sessionDone(run, null, noHr).heart, 30); // plan: 1 per minute
    const gym = { sport_type: 'strength', done: true, rpe: 7, blocks: [{ intensity: 'strength', duration_s: 1800, rpe: 6 }] };
    const gymFile = [{ duration_s: 2400, distance_m: 0, hr_load: 5.3, body_load: null }];
    assert.deepEqual(M.sessionDone(gym, null, gymFile), { duration_s: 2400, km: 0, heart: 5, legs: 47, files: 1 });
});

test('planned loads follow the athlete’s zones and target HR', () => {
    const zones = { run: { easy: 160, ap1: 172, ap2: 183, ap3: 197 } };
    const s = { sport_type: 'run', discipline: 'Road Run', blocks: [{ intensity: 'easy', duration_s: 600 }, { intensity: 'easy', duration_s: 600, target_hr: 150 }] };
    const p = M.sessionPlan(s, zones);
    assert.equal(p.heart, Math.round(10 + 10 * Math.pow(3, -10 / 23)));
    const sprint = M.summarizeBlocks([{ intensity: 'sprint', duration_s: 60 }]);
    assert.equal(sprint.heart, Math.round(Math.pow(3, 37 / 23)));
    const bike = M.sessionPlan({ sport_type: 'bike', blocks: [{ intensity: 'easy', duration_s: 3600 }] });
    assert.equal(bike.legs, 15); // 60 min x 0.25
});

test('weekStats + flags', () => {
    const mon = '2026-10-05';
    const mk = (date, sport, blocks, extra = {}) => ({ date, sport_type: sport, blocks, ...extra });
    const sessions = [
        mk('2026-10-05', 'run', [{ intensity: 'easy', duration_s: 2400, distance_km: 8 }], { done: true }),
        mk('2026-10-06', 'run', [{ intensity: 'ap2', duration_s: 360, distance_km: 1.5, repeat: { reps: 4, rest_sec: 60, rest_type: 'moving' } }]),
        mk('2026-10-07', 'strength', [{ intensity: 'strength', duration_s: 1800, rpe: 6 }]),
        mk('2026-10-08', 'run', [{ intensity: 'ap3', duration_s: 35, distance_km: 0.2, repeat: { reps: 8, rest_sec: 120 } }]),
        mk('2026-10-10', 'run', [{ intensity: 'ap3', duration_s: 2400, distance_km: 7 }]),
        mk('2026-10-11', 'run', [{ intensity: 'ap3', duration_s: 2100, distance_km: 6 }]),
        mk('2026-10-12', 'run', [{ intensity: 'easy', duration_s: 9999, distance_km: 99 }]) // next week
    ];
    const diary = { '2026-10-06': { pain: 4 }, '2026-10-07': { pain: 1 } };
    const st = M.weekStats(mon, sessions, diary);
    assert.equal(st.count, 6);
    assert.equal(st.doneCount, 1);
    assert.equal(st.planned.km, 8 + 6 + 1.6 + 7 + 6);
    assert.equal(st.done.km, 8);
    assert.equal(st.hardCount, 4);
    assert.equal(st.painDays.length, 1);
    assert.equal(st.perDay['2026-10-05'].done_s, 2400);
    const prev = M.weekStats('2026-09-28', [mk('2026-09-30', 'run', [{ intensity: 'easy', duration_s: 3600, distance_km: 20 }])], {});
    const flags = M.weekFlags(st, prev);
    assert.deepEqual(flags.map(f => f.kind), ['pain', 'hard', 'volume']);
    assert.match(flags[0].text, /Tue/);
    const flags2 = M.weekFlags(M.weekStats(mon, sessions, { '2026-10-06': { pain: 4 }, '2026-10-08': { pain: 3 } }), null);
    assert.match(flags2[0].text, /2 days/);
});

test('weekStats: orienteering share and file loads', () => {
    const mon = '2026-10-05';
    const sessions = [
        { id: 'a', date: '2026-10-10', sport_type: 'run', discipline: 'Orienteering', done: true, blocks: [{ intensity: 'ap3', duration_s: 2400, distance_km: 7 }] },
        { id: 'b', date: '2026-10-08', sport_type: 'run', discipline: 'Trail Run', orienteering: true, done: true, blocks: [{ intensity: 'easy', duration_s: 3600 }] },
        { id: 'c', date: '2026-10-06', sport_type: 'run', discipline: 'Road Run', done: true, blocks: [{ intensity: 'easy', duration_s: 2700, distance_km: 9 }] }
    ];
    const acts = new Map([['a', [{ duration_s: 2500, distance_m: 7400, hr_load: 140, body_load: 40 }]]]);
    const st = M.weekStats(mon, sessions, {}, { acts });
    assert.equal(st.orienteering.count, 2);
    assert.equal(st.orienteering.done_s, 2500 + 3600);
    assert.equal(st.orienteering.km, 7.4);
    assert.equal(st.files, 1);
    assert.equal(st.done.heart, 140 + 60 + 45);
    assert.equal(st.done.legs, 40 + Math.round(60 * 0.9) + 45);
});

test('copyWeekPayloads shifts dates and skips planned days', () => {
    const sessions = [
        { id: 1, date: '2026-09-29', sport_type: 'run', blocks: [{ intensity: 'easy', time_min: 40 }], done: true, rpe: 5, time: '16:30:00' },
        { id: 2, date: '2026-10-01', sport_type: 'run', blocks: [] },
        { id: 3, date: '2026-10-08', sport_type: 'bike', blocks: [] } // already planned Thursday
    ];
    const out = M.copyWeekPayloads('2026-09-28', '2026-10-05', sessions);
    assert.equal(out.length, 1);
    assert.equal(out[0].date, '2026-10-06');
    assert.equal(out[0].done, false);
    assert.equal(out[0].rpe, null);
    assert.equal(out[0].orienteering, false);
    assert.equal(out[0].blocks[0].duration_s, 2400);
    assert.equal(M.copyWeekPayloads('2026-09-28', '2026-10-05', sessions, { skipPlannedDays: false }).length, 2);
    assert.equal(M.copyWeekPayloads('2026-10-05', '2026-10-05', sessions).length, 0);
});
