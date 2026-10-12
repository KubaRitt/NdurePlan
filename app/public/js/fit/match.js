// NdurePlan - which session does each imported file belong to? (pure, tested)
//
//   1. Same day and sport, and a file of that session ended at most 90 min
//      before this one started (warm-up file + race file) -> that session.
//   2. Same day and sport, a planned session without a file -> the one whose
//      planned start is closest.
//   3. Another new file of this import, same day and sport, ended at most
//      90 min before -> goes into the same new session.
//   4. Otherwise -> a new (unplanned) session of the file's type.
// Files whose sport the app doesn't recognise always start as a new session.

export const JOIN_GAP_S = 90 * 60;

const minutes = hhmm => {
    if (!hhmm) return null;
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + (m || 0);
};

function fileEnd(a) {
    const start = Date.parse(a.start_time) / 1000;
    return start + Number(a.elapsed_s ?? a.duration_s ?? 0);
}

/**
 * @param items     import items ({ key, start, date, time, sport, discipline, sportKnown, totals })
 * @param sessions  sessions that may receive files
 * @param acts      Map sessionId -> activities already linked
 * @returns Map item key -> { kind: 'session', id } | { kind: 'new', discipline } | { kind: 'with', key }
 */
export function matchItems(items, sessions, acts = new Map()) {
    const targets = new Map();
    const batchEnds = new Map();   // sessionId -> [end] of files given to it in this import
    const roots = [];              // new sessions of this import: { key, date, sport, end }
    const ordered = items.filter(i => !i.error).slice().sort((a, b) => a.start - b.start);
    const joins = (start, end) => start >= end - 120 && start - end <= JOIN_GAP_S;

    for (const it of ordered) {
        const end = it.start + (it.totals.elapsed_s || 0);
        let target = null;
        if (it.sportKnown) {
            const sameDay = sessions.filter(s => s.date === it.date && s.sport_type === it.sport);
            for (const s of sameDay) {
                const ends = [...(acts.get(s.id) || []).map(fileEnd), ...(batchEnds.get(s.id) || [])];
                if (ends.some(e => joins(it.start, e))) { target = { kind: 'session', id: s.id }; break; }
            }
            if (!target) {
                const free = sameDay.filter(s => !(acts.get(s.id) || []).length && !batchEnds.has(s.id));
                if (free.length) {
                    const t = minutes(it.time);
                    const gap = s => (s.time ? Math.abs(minutes(s.time) - t) : 600);
                    free.sort((a, b) => gap(a) - gap(b));
                    target = { kind: 'session', id: free[0].id };
                }
            }
            if (!target) {
                const root = roots.find(r => r.date === it.date && r.sport === it.sport && joins(it.start, r.end));
                if (root) { target = { kind: 'with', key: root.key }; root.end = Math.max(root.end, end); }
            }
        }
        if (!target) {
            target = { kind: 'new', discipline: it.discipline };
            roots.push({ key: it.key, date: it.date, sport: it.sport, end });
        }
        if (target.kind === 'session') batchEnds.set(target.id, [...(batchEnds.get(target.id) || []), end]);
        targets.set(it.key, target);
    }
    return targets;
}
