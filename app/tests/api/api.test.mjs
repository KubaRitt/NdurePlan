import test from 'node:test';
import assert from 'node:assert/strict';
import { log, setResult } from './fake-supabase.mjs';
const api = await import('../../public/supabase_api.js');

const last = () => log[log.length - 1];
const op = (q, name) => q.ops.filter(o => o[0] === name);

test('fetchSessions filters by user and date range, time nulls last', async () => {
    setResult({ data: [{ id: 1 }], error: null });
    const rows = await api.fetchSessions('2026-10-01', '2026-10-31');
    assert.deepEqual(rows, [{ id: 1 }]);
    const q = last();
    assert.equal(q.table, 'sessions');
    assert.deepEqual(op(q, 'eq')[0], ['eq', 'user_id', 'user-1']);
    assert.deepEqual(op(q, 'gte')[0], ['gte', 'date', '2026-10-01']);
    assert.deepEqual(op(q, 'lte')[0], ['lte', 'date', '2026-10-31']);
    assert.deepEqual(op(q, 'order')[1], ['order', 'time', { ascending: true, nullsFirst: false }]);
});

test('createSessions only sends known columns and adds user_id; empty time -> null', async () => {
    setResult({ data: [{ id: 9 }], error: null });
    await api.createSessions([{ sport_type: 'run', date: '2026-10-07', time: '', blocks: [], description: 'x', done: false, id: 'evil', user_id: 'someone-else', created_at: 'x' }]);
    const q = last();
    assert.equal(q.table, 'sessions');
    const rows = op(q, 'insert')[0][1];
    assert.deepEqual(rows, [{ sport_type: 'run', date: '2026-10-07', time: null, blocks: [], description: 'x', done: false, user_id: 'user-1' }]);
    assert.ok(op(q, 'select').length === 1);
});

test('updateSession scopes by id and user', async () => {
    setResult({ data: { id: 5 }, error: null });
    await api.updateSession(5, { done: true, rpe: 7, junk: 1 });
    const q = last();
    assert.deepEqual(op(q, 'update')[0][1], { done: true, rpe: 7 });
    assert.deepEqual(op(q, 'eq').map(o => o[1]), ['id', 'user_id']);
    assert.equal(op(q, 'single').length, 1);
});

test('deleteSessions uses in() and user filter; no-op for empty list', async () => {
    setResult({ data: null, error: null });
    const before = log.length;
    await api.deleteSessions([]);
    assert.equal(log.length, before);
    await api.deleteSessions(['a', 'b']);
    const q = last();
    assert.deepEqual(op(q, 'in')[0], ['in', 'id', ['a', 'b']]);
    assert.equal(op(q, 'delete').length, 1);
});

test('upsertDiary sends one row per day with conflict target and blanks as null', async () => {
    setResult({ data: { date: '2026-10-07' }, error: null });
    await api.upsertDiary({ date: '2026-10-07', sleep_h: 8.5, legs: '', pain: 0, notes: 'ok', extra: 1 });
    const q = last();
    assert.equal(q.table, 'diary');
    const [, row, opts] = op(q, 'upsert')[0];
    assert.deepEqual(row, { user_id: 'user-1', date: '2026-10-07', sleep_h: 8.5, legs: null, pain: 0, notes: 'ok' });
    assert.deepEqual(opts, { onConflict: 'user_id,date' });
});

test('templates create/delete', async () => {
    setResult({ data: { id: 't1' }, error: null });
    await api.createTemplate({ name: 'T', sport_type: 'run', blocks: [] });
    assert.deepEqual(op(last(), 'insert')[0][1], { user_id: 'user-1', name: 'T', sport_type: 'run', discipline: '', description: '', blocks: [] });
    await api.deleteTemplate('t1');
    assert.deepEqual(op(last(), 'eq').map(o => o[1]), ['id', 'user_id']);
});

test('missing table/column becomes SchemaError pointing at the migrations', async () => {
    setResult({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.diary' in the schema cache" } });
    await assert.rejects(api.fetchDiary('2026-10-01', '2026-10-07'), err => err instanceof api.SchemaError && /supabase\/migrations/.test(err.message));
    setResult({ data: null, error: { code: 'PGRST204', message: "Could not find the 'done' column of 'sessions' in the schema cache" } });
    await assert.rejects(api.updateSession(1, { done: true }), api.SchemaError);
    setResult({ data: null, error: { code: '23514', message: 'new row violates check constraint' } });
    await assert.rejects(api.updateSession(1, { rpe: 99 }), err => !(err instanceof api.SchemaError));
});

test('saveHrZones updates own profile row', async () => {
    setResult({ data: null, error: null });
    await api.saveHrZones({ run: { easy: 150 } });
    const q = last();
    assert.equal(q.table, 'profiles');
    assert.deepEqual(op(q, 'eq')[0], ['eq', 'id', 'user-1']);
    assert.deepEqual(op(q, 'update')[0][1].hr_zones, { run: { easy: 150 } });
});

test('activities: list without pieces, insert with user_id, link/unlink, delete in chunks', async () => {
    setResult({ data: [], error: null });
    await api.fetchActivities('2026-10-01', '2026-10-31');
    let q = last();
    assert.equal(q.table, 'activities');
    assert.ok(!/pieces/.test(op(q, 'select')[0][1]), 'list must not download pieces');
    assert.deepEqual(op(q, 'eq')[0], ['eq', 'user_id', 'user-1']);

    setResult({ data: [{ id: 'a1' }], error: null });
    await api.createActivities([{ session_id: 's1', activity_uid: 'u', date: '2026-10-06', pieces: 'AAAA', user_id: 'evil', id: 'evil', junk: 1 }]);
    q = last();
    const row = op(q, 'insert')[0][1][0];
    assert.deepEqual(row, { session_id: 's1', activity_uid: 'u', date: '2026-10-06', pieces: 'AAAA', user_id: 'user-1' });

    setResult({ data: null, error: null });
    await api.linkActivities(['a1', 'a2'], null);
    q = last();
    assert.deepEqual(op(q, 'update')[0][1], { session_id: null });
    assert.deepEqual(op(q, 'in')[0], ['in', 'id', ['a1', 'a2']]);

    const before = log.length;
    await api.deleteActivities(Array.from({ length: 150 }, (_, i) => `id${i}`));
    assert.equal(log.length - before, 2, '150 ids -> 2 requests of at most 100');
});

test('activities: duplicate lookup by uid, pieces only on request', async () => {
    setResult({ data: [{ id: 'a1', activity_uid: 'u1', session_id: null }], error: null });
    const found = await api.findActivitiesByUid(['u1', 'u2']);
    assert.equal(found.length, 1);
    assert.deepEqual(op(last(), 'in')[0], ['in', 'activity_uid', ['u1', 'u2']]);
    setResult({ data: [{ id: 'a1', pieces: 'AAAA' }], error: null });
    const rows = await api.fetchActivityPieces(['a1']);
    assert.equal(rows[0].pieces, 'AAAA');
    assert.ok(/pieces/.test(op(last(), 'select')[0][1]));
});
