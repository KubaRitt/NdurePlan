// FIT files in the UI: the files on a session's diary card (with laps) and the import dialog.

import * as M from '../model.js';
import * as S from '../state.js';
import { state, activitiesFor, zonesFor } from '../state.js';
import { DISCIPLINES, PARENT_SPORTS, getParentSportForDiscipline, isRunSport } from '../../sports.js';
import { surfaceOf } from '../loads.js';
import { loadsFromPieces } from '../fit/analyze.js';
import { matchItems } from '../fit/match.js';
import { openOverlay, requestClose } from './overlay.js';
import { esc, icon } from './util.js';

const n0 = v => (v === null || v === undefined ? null : Math.round(Number(v)));
const clock = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// Files on a session (diary card)
// ---------------------------------------------------------------------------

function speedText(sport, seconds, meters) {
    if (!(meters > 0) || !(seconds > 0)) return '';
    if (isRunSport(sport)) return M.fmtPace(seconds, meters / 1000).replace(' /km', '');
    if (sport === 'bike' || sport === 'xc ski' || sport === 'backcountry ski') return `${(meters / seconds * 3.6).toFixed(1)}`;
    return '';
}

// Planned segment names, used as lap names when the watch laps match the plan.
function lapNames(session, laps) {
    const segs = [];
    (session.blocks || []).forEach(b => {
        const n = M.normalizeBlock(b);
        M.expandBlock(b).forEach((seg, i, all) => {
            const reps = all.filter(x => x.kind === 'work').length;
            const name = seg.kind === 'rest' ? (seg.moving ? 'Jog' : 'Rest') : (n.type || M.ZONE_LABEL[n.intensity]);
            const k = seg.kind === 'work' && reps > 1 ? ` ${all.slice(0, i + 1).filter(x => x.kind === 'work').length}` : '';
            segs.push(name + k);
        });
    });
    return segs.length === laps.length ? segs : null;
}

function lapsTable(a, session) {
    const laps = Array.isArray(a.laps) ? a.laps : [];
    if (laps.length < 2) return '';
    const names = lapNames(session, laps);
    const paceHead = isRunSport(a.sport_type) ? 'Pace' : ['bike', 'xc ski', 'backcountry ski'].includes(a.sport_type) ? 'km/h' : '';
    const strength = a.sport_type === 'strength';
    return `<details class="laps">
        <summary>Laps (${laps.length})</summary>
        <div class="laps-scroll"><table class="laps-t">
            <thead><tr><th scope="col">Lap</th><th scope="col">Time</th>${a.distance_m > 0 ? '<th scope="col">km</th>' : ''}${paceHead && a.distance_m > 0 ? `<th scope="col">${paceHead}</th>` : ''}<th scope="col">HR</th><th scope="col">Heart</th>${strength ? '' : '<th scope="col">Legs</th>'}</tr></thead>
            <tbody>${laps.map((l, i) => `<tr>
                <th scope="row">${esc(names ? names[i] : String(i + 1))}</th>
                <td>${esc(M.fmtClock(l.counted ?? l.elapsed))}</td>
                ${a.distance_m > 0 ? `<td>${l.dist ? esc(M.fmtKm(l.dist / 1000, 2)) : ''}</td>` : ''}
                ${paceHead && a.distance_m > 0 ? `<td>${esc(speedText(a.sport_type, l.moving, l.dist))}</td>` : ''}
                <td>${l.hr ? esc(l.hr) : ''}</td>
                <td>${l.heart === null || l.heart === undefined ? '' : esc(n0(l.heart))}</td>
                ${strength ? '' : `<td>${l.legs === null || l.legs === undefined ? '' : esc(n0(l.legs))}</td>`}
            </tr>`).join('')}</tbody>
        </table></div>
    </details>`;
}

function fileNotes(a) {
    const notes = [];
    if (Number(a.excluded_s) >= 60) notes.push(`${M.fmtDur(a.excluded_s)} standing still not counted`);
    if (a.hr_quality === 'cadence') notes.push('Heart rate looked locked to your step rate, so Heart comes from the plan');
    else if (a.hr_quality === 'none') notes.push('No usable heart rate, so Heart comes from the plan');
    return notes;
}

function activityCard(a, session) {
    const bits = [M.fmtDur(a.duration_s)];
    if (Number(a.distance_m) > 0) bits.push(`${M.fmtKm(a.distance_m / 1000, 2)} km`);
    if (a.avg_hr) bits.push(`${a.avg_hr} bpm`);
    if (Number(a.elevation_gain_m) >= 10) bits.push(`+${n0(a.elevation_gain_m)} m`);
    const heart = a.hr_load === null || a.hr_load === undefined ? 'from plan' : n0(a.hr_load);
    const legs = session.sport_type === 'strength' ? 'from RPE' : n0(a.body_load);
    const notes = fileNotes(a);
    const label = [clock(a.start_time), a.device].filter(Boolean).join(' · ');
    return `<div class="act">
        <div class="act-head">
            <span class="act-icon" aria-hidden="true">${icon('file', 18)}</span>
            <div class="act-main">
                <p class="act-title"><b>${esc(label || 'FIT file')}</b> <span class="muted">${esc(bits.join(' · '))}</span></p>
                <p class="act-loads">Heart <b>${esc(heart)}</b> · Legs <b>${esc(legs)}</b></p>
                ${notes.map(t => `<p class="act-note">${esc(t)}</p>`).join('')}
            </div>
            <button type="button" class="icon-btn sm" data-action="remove-activity" data-id="${esc(a.id)}" aria-label="Remove this file from the session">${icon('x', 18)}</button>
        </div>
        ${lapsTable(a, session)}
    </div>`;
}

/** Files linked to a session, for its diary card. */
export function activityList(session) {
    const files = activitiesFor(session.id);
    if (!files.length) return '';
    const done = M.sessionDone({ ...session, done: true }, state.zones, files);
    return `<div class="acts">
        ${files.map(a => activityCard(a, session)).join('')}
        ${files.length > 1 ? `<p class="act-total">Together: ${esc(M.fmtDur(done.duration_s))} · Heart <b>${done.heart}</b> · Legs <b>${done.legs}</b></p>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------------
// Import dialog
// ---------------------------------------------------------------------------

function pseudoSession(discipline) {
    return { sport_type: getParentSportForDiscipline(discipline), discipline, orienteering: discipline === 'Orienteering', blocks: [] };
}

/**
 * @param fileList  FileList or File[] (.fit / .zip)
 * @param o.layout  'phone' | 'desktop'
 * @param o.onDone  called with the dates that got files
 */
export function openImport(fileList, { layout = 'desktop', onDone } = {}) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const ui = { phase: 'reading', progress: [0, files.length], items: [], fresh: [], dupes: [], errors: [], targets: new Map(), orphans: new Map(), problem: '' };
    let panel = null;
    let savedDates = null;

    const entry = openOverlay({
        kind: layout === 'phone' ? 'sheet' : 'modal',
        label: 'Add activity files',
        render: p => { panel = p; draw(); bind(); },
        canClose: () => ui.phase !== 'saving',
        // runs once the dialog (and its history entry) is gone, so a new sheet can open cleanly
        onClose: () => { if (savedDates && onDone) onDone(savedDates); }
    });

    const resolve = key => {
        // follow "together with" to the file that decides the session
        let t = ui.targets.get(key), guard = 0;
        while (t && t.kind === 'with' && guard++ < 50) {
            const root = ui.targets.get(t.key);
            if (!root || root.kind === 'skip') return { kind: 'new', discipline: ui.fresh.find(i => i.key === key).discipline };
            if (root.kind !== 'with') return root.kind === 'new' ? { kind: 'with', key: t.key } : root;
            t = root;
        }
        return t;
    };

    const ctxFor = item => {
        const t = resolve(item.key);
        if (!t || t.kind === 'skip') return null;
        if (t.kind === 'session') return state.sessions.get(t.id) || null;
        if (t.kind === 'new') return pseudoSession(t.discipline);
        const root = ui.targets.get(t.key);
        return root && root.kind === 'new' ? pseudoSession(root.discipline) : null;
    };

    const loadsText = item => {
        const s = ctxFor(item);
        if (!s) return 'Not imported';
        const fallbackEffort = s.id ? S.planEffort(s) : 1;
        const l = loadsFromPieces(item.pieces, item.laps, { sport: s.sport_type, zones: zonesFor(s.sport_type), surface: surfaceOf(s), hrQuality: item.hrQuality, fallbackEffort });
        const heart = l.heart === null ? 'from plan' : Math.round(l.heart);
        const legs = s.sport_type === 'strength' ? 'from RPE' : Math.round(l.legs);
        return `Heart <b>${esc(heart)}</b> · Legs <b>${esc(legs)}</b>`;
    };

    const targetValue = t => (!t ? 'x' : t.kind === 'session' ? `s:${t.id}` : t.kind === 'new' ? `n:${t.discipline}` : t.kind === 'with' ? `w:${t.key}` : 'x');

    function options(item) {
        const sel = targetValue(ui.targets.get(item.key));
        const opt = (v, label) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(label)}</option>`;
        const day = S.sessionsOn(item.date);
        const earlier = ui.fresh.filter(o => o.date === item.date && o.start < item.start);
        return `${day.length ? `<optgroup label="Planned on ${esc(M.fmtDayMonth(item.date))}">${day.map(s => opt(`s:${s.id}`,
                `${M.sessionTitle(s)}${s.time ? ` · ${M.fmtTime(s.time)}` : ''}${activitiesFor(s.id).length ? ' · has a file' : ''}`)).join('')}</optgroup>` : ''}
            ${earlier.length ? `<optgroup label="Same session as">${earlier.map(o => opt(`w:${o.key}`, `the ${o.time} file`)).join('')}</optgroup>` : ''}
            <optgroup label="New session">${PARENT_SPORTS.map(p => DISCIPLINES[p].map(d => opt(`n:${d}`, `New: ${d}`)).join('')).join('')}</optgroup>
            ${opt('x', 'Don’t import')}`;
    }

    function itemCard(item) {
        const T = item.totals;
        const bits = [M.fmtDur(T.counted_s)];
        if (T.distance_m > 0) bits.push(`${M.fmtKm(T.distance_m / 1000, 2)} km`);
        if (T.avg_hr) bits.push(`${T.avg_hr} bpm`);
        const notes = [];
        if (!item.sportKnown) notes.push('The watch didn’t say which sport this was. Check the session type.');
        if (T.excluded_s >= 60) notes.push(`${M.fmtDur(T.excluded_s)} standing still is not counted (stops over 5 min).`);
        if (item.hrQuality === 'cadence') notes.push('Heart rate looks locked to your step rate. Heart load will come from the plan.');
        else if (item.hrQuality === 'none') notes.push('No usable heart rate. Heart load will come from the plan.');
        if (item.truncated) notes.push('The file is cut off at the end; the part that’s there is used.');
        return `<article class="imp" data-key="${esc(item.key)}">
            <div class="imp-head">
                <b>${esc(M.dayShort(item.date))} ${esc(M.fmtDayMonth(item.date))} · ${esc(item.time)}</b>
                <span class="muted">${esc([item.label, item.device].filter(Boolean).join(' · '))}</span>
            </div>
            <p class="imp-line">${esc(bits.join(' · '))}${T.elapsed_s - T.counted_s >= 60 ? ` <span class="muted">(${esc(M.fmtDur(T.elapsed_s))} on the watch)</span>` : ''}</p>
            <p class="imp-loads" data-imp-loads>${loadsText(item)}</p>
            ${notes.map(t => `<p class="act-note">${esc(t)}</p>`).join('')}
            <label class="field"><span>Add to</span><select data-imp-target="${esc(item.key)}">${options(item)}</select></label>
        </article>`;
    }

    function draw() {
        if (!panel) return;
        const count = ui.fresh.filter(i => (ui.targets.get(i.key) || {}).kind !== 'skip').length;
        let body = '';
        if (ui.phase === 'reading') {
            body = `<p>Reading file ${Math.min(ui.progress[0] + 1, ui.progress[1])} of ${ui.progress[1]}…</p>
                <progress max="${ui.progress[1]}" value="${ui.progress[0]}" aria-label="Reading files"></progress>`;
        } else {
            if (ui.problem) body += `<p class="form-error" role="alert">${esc(ui.problem)}</p>`;
            if (ui.errors.length) {
                body += `<div class="note note-pain"><b>${ui.errors.length === 1 ? 'One file couldn’t be read' : `${ui.errors.length} files couldn’t be read`}</b>
                    <ul class="imp-errs">${ui.errors.map(e => `<li>${esc(e.fileName)}: ${esc(e.error)}</li>`).join('')}</ul></div>`;
            }
            if (ui.dupes.length) {
                body += `<p class="muted small">${ui.dupes.length === 1 ? 'One file is' : `${ui.dupes.length} files are`} already saved, so ${ui.dupes.length === 1 ? 'it’s' : 'they’re'} skipped.</p>`;
            }
            body += ui.fresh.length ? ui.fresh.map(itemCard).join('') : '<p class="empty">Nothing new to add.</p>';
        }
        panel.innerHTML = `<form class="dialog" data-import-form novalidate>
            <header class="sheet-head"><h2>Add activity files</h2>
                <button type="button" class="icon-btn" data-action="close-overlay" aria-label="Close">${icon('x')}</button></header>
            <div class="dialog-body">${body}</div>
            <footer class="dialog-foot">
                <button type="button" class="btn ghost" data-action="close-overlay">Cancel</button>
                <button type="submit" class="btn primary"${ui.phase !== 'review' || !count ? ' disabled' : ''}>${ui.phase === 'saving' ? 'Saving…' : count ? `Save ${count} file${count === 1 ? '' : 's'}` : 'Save'}</button>
            </footer>
        </form>`;
    }

    function bind() {
        panel.addEventListener('change', e => {
            const sel = e.target.closest('[data-imp-target]');
            if (!sel) return;
            const key = sel.dataset.impTarget;
            const v = sel.value;
            ui.targets.set(key, v === 'x' ? { kind: 'skip' }
                : v.startsWith('s:') ? { kind: 'session', id: v.slice(2) }
                : v.startsWith('w:') ? { kind: 'with', key: v.slice(2) }
                : { kind: 'new', discipline: v.slice(2) });
            // loads of every card can change (a "same session as" chain), the rest of the form stays put
            panel.querySelectorAll('.imp').forEach(card => {
                const item = ui.fresh.find(i => i.key === card.dataset.key);
                const out = card.querySelector('[data-imp-loads]');
                if (item && out) out.innerHTML = loadsText(item);
            });
            const btn = panel.querySelector('button[type=submit]');
            const count = ui.fresh.filter(i => (ui.targets.get(i.key) || {}).kind !== 'skip').length;
            btn.disabled = !count;
            btn.textContent = count ? `Save ${count} file${count === 1 ? '' : 's'}` : 'Save';
        });
        panel.addEventListener('submit', async e => {
            e.preventDefault();
            if (ui.phase !== 'review') return;
            ui.phase = 'saving';
            draw();
            const entries = ui.fresh.map(item => ({ item, target: resolve(item.key) }));
            const n = await S.importActivities(entries, { orphans: ui.orphans });
            ui.phase = 'review';
            if (n) {
                savedDates = [...new Set(entries.filter(x => x.target && x.target.kind !== 'skip').map(x => x.item.date))].sort();
                savedDates.forEach(d => { state.dayTab[d] = 'diary'; });
                requestClose(entry, { force: true });
            } else {
                draw();
            }
        });
    }

    (async () => {
        try {
            const { readFiles } = await import('../fit/importer.js');
            const items = await readFiles(files, { onProgress: (a, b) => { ui.progress = [a, b]; draw(); } });
            ui.errors = items.filter(i => i.error);
            const ok = items.filter(i => !i.error);
            // the same activity twice in one go (e.g. the .fit and its .zip)
            const seen = new Set();
            const unique = [];
            ok.forEach(i => { if (seen.has(i.uid)) ui.dupes.push(i); else { seen.add(i.uid); unique.push(i); } });
            if (unique.length) {
                const dates = unique.map(i => i.date).sort();
                await S.ensureRange(dates[0], dates[dates.length - 1]);
                const stored = await S.findStoredFiles(unique.map(i => i.uid));
                const linked = new Set(stored.filter(f => f.session_id).map(f => f.activity_uid));
                stored.filter(f => !f.session_id).forEach(f => ui.orphans.set(f.activity_uid, f.id));
                unique.forEach(i => { if (linked.has(i.uid)) ui.dupes.push(i); else ui.fresh.push(i); });
            }
            ui.fresh.sort((a, b) => a.start - b.start);
            const acts = new Map();
            state.activities.forEach(a => { if (a.session_id) acts.set(a.session_id, [...(acts.get(a.session_id) || []), a]); });
            ui.targets = matchItems(ui.fresh, S.allSessions(), acts);
        } catch (err) {
            console.error('import', err);
            ui.fresh = [];
            ui.problem = 'Couldn’t check your saved files. Check your connection and try again.';
        }
        ui.phase = 'review';
        draw();
    })();
}

