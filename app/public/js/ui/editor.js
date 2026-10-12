// Session editor: full screen on the phone, a dialog on the desktop.
// Typing never re-renders the form (so the keyboard and cursor stay put);
// only the preview and the edited block's summary line are refreshed.

import * as M from '../model.js';
import { state, createSession, updateSession, deleteSession, saveTemplate, zonesFor, select } from '../state.js';
import { DISCIPLINES, PARENT_SPORTS, SPORT_LABEL, getParentSportForDiscipline, isRunSport } from '../../sports.js';
import { BUILT_IN_TEMPLATES } from '../templates.js';
import { openOverlay, requestClose } from './overlay.js';
import { esc, icon, zoneText } from './util.js';
import { workoutGraph, zoneLegend } from './graph.js';
import { toast } from './toast.js';

let ed = null;
let keySeq = 0;

// ---------------------------------------------------------------------------
// Templates -> blocks with the athlete's own target HR
// ---------------------------------------------------------------------------

export function findTemplate({ tpl, userTpl }) {
    if (tpl) return BUILT_IN_TEMPLATES.find(t => t.id === tpl) || null;
    if (userTpl) return state.templates.find(t => String(t.id) === String(userTpl)) || null;
    return null;
}

export function templateBlocks(t) {
    const zones = zonesFor(t.sport_type);
    return (t.blocks || []).map(raw => {
        const b = JSON.parse(JSON.stringify(raw));
        if (M.HR_ZONE_KEYS.includes(b.intensity) && (b.target_hr === undefined || b.target_hr === null)) b.target_hr = zones[b.intensity] ?? null;
        if (b.repeat && b.repeat.rest_type === 'moving' && !b.repeat.rest_target_hr) b.repeat.rest_target_hr = zones[b.repeat.rest_intensity || 'easy'] ?? null;
        return M.serializeBlock(b);
    });
}

export function sessionFromTemplate(t, date) {
    return {
        sport_type: t.sport_type,
        discipline: t.discipline || DISCIPLINES[t.sport_type][0],
        date,
        time: null,
        description: t.description || t.name,
        blocks: templateBlocks(t)
    };
}

// ---------------------------------------------------------------------------
// Draft helpers
// ---------------------------------------------------------------------------

function draftBlock(b, open = false) {
    const n = M.normalizeBlock(b);
    const repeatOn = !!(b.repeat && Number(b.repeat.reps) > 1);
    return {
        ...n,
        repeat: {
            reps: n.repeat ? n.repeat.reps : 4,
            rest_sec: n.repeat ? n.repeat.rest_sec : 60,
            rest_type: n.repeat ? n.repeat.rest_type : 'moving',
            rest_intensity: n.repeat ? n.repeat.rest_intensity : 'easy',
            rest_target_hr: n.repeat ? n.repeat.rest_target_hr : null,
            start_with: n.repeat ? n.repeat.start_with : 'interval',
            end_with: n.repeat ? n.repeat.end_with : 'interval',
            customized: n.repeat ? n.repeat.customized : false,
            per_rep: n.repeat ? n.repeat.per_rep.map(p => ({ ...p })) : []
        },
        _repeatOn: repeatOn,
        _k: ++keySeq,
        _open: open,
        _txt: {},
        _err: {}
    };
}

// The block as it gets saved/computed (repeat only when switched on).
function cleanBlock(b) {
    return M.serializeBlock({
        type: b.type, intensity: b.intensity, duration_s: b.duration_s, distance_km: b.distance_km,
        target_hr: b.target_hr, rpe: b.rpe,
        repeat: b._repeatOn ? { ...b.repeat, per_rep: b.repeat.customized ? b.repeat.per_rep : [] } : null
    });
}

function payload() {
    const d = ed.draft;
    return {
        sport_type: d.sport_type,
        discipline: d.discipline,
        orienteering: d.sport_type === 'run' && (d.discipline === 'Orienteering' || !!d.orienteering),
        date: d.date,
        time: d.time || null,
        description: d.description.trim(),
        blocks: d.blocks.map(cleanBlock)
    };
}

function isDirty() {
    return JSON.stringify(payload()) !== ed.original;
}

function defaultHr(intensity) {
    return M.HR_ZONE_KEYS.includes(intensity) ? (zonesFor(ed.draft.sport_type)[intensity] ?? null) : null;
}

function newBlock() {
    if (ed.draft.sport_type === 'strength') {
        return draftBlock({ type: '', intensity: 'strength', duration_s: 600, rpe: M.DEFAULT_RPE }, true);
    }
    return draftBlock({ type: '', intensity: 'easy', duration_s: 600, target_hr: defaultHr('easy') }, true);
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/**
 * @param o.id        edit an existing session
 * @param o.date      date for a new session
 * @param o.template  template object to start from (new session)
 * @param o.layout    'phone' | 'desktop'
 */
export function openEditor({ id = null, date, template = null, layout = 'desktop' }) {
    let src;
    if (id) {
        src = state.sessions.get(id);
        if (!src) return;
    } else if (template) {
        src = sessionFromTemplate(template, date);
    } else {
        src = {
            sport_type: 'run', discipline: 'Road Run', date, time: null, description: '',
            blocks: [{ type: 'Easy', intensity: 'easy', duration_s: 2700, target_hr: zonesFor('run').easy }]
        };
    }
    const blocks = (src.blocks || []).map(b => draftBlock(b, !id));
    ed = {
        id,
        layout,
        draft: {
            sport_type: src.sport_type || getParentSportForDiscipline(src.discipline),
            discipline: src.discipline || DISCIPLINES[src.sport_type || 'run'][0],
            orienteering: !!src.orienteering,
            date: src.date || date,
            time: src.time ? M.fmtTime(src.time) : '',
            description: src.description || '',
            blocks: blocks.length ? blocks : []
        },
        showTemplateSave: false,
        error: ''
    };
    if (!ed.draft.blocks.length) ed.draft.blocks.push(newBlock());
    ed.original = JSON.stringify(payload());
    ed.entry = openOverlay({
        kind: layout === 'phone' ? 'full' : 'modal',
        label: id ? 'Edit session' : 'New session',
        render: panel => { ed.panel = panel; renderAll(); bind(panel); },
        canClose: () => !isDirty() || window.confirm('Discard your changes to this session?'),
        onClose: () => { ed = null; }
    });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function disciplineOptions(sel) {
    return PARENT_SPORTS.map(p => `<optgroup label="${esc(SPORT_LABEL[p])}">${DISCIPLINES[p].map(d =>
        `<option value="${esc(d)}"${d === sel ? ' selected' : ''}>${esc(d)}</option>`).join('')}</optgroup>`).join('');
}

function renderAll() {
    const d = ed.draft;
    ed.panel.innerHTML = `<form class="editor" novalidate>
        <header class="ed-head">
            <button type="button" class="btn ghost" data-ed="cancel">Cancel</button>
            <h2>${ed.id ? 'Edit session' : 'New session'}</h2>
            <button type="submit" class="btn primary">Save</button>
        </header>
        <div class="ed-body">
            <p class="form-error" data-ed-error role="alert"${ed.error ? '' : ' hidden'}>${esc(ed.error)}</p>
            ${ed.id ? '' : `<div class="add-row">
                <p class="label">Start from</p>
                <div class="chips">${BUILT_IN_TEMPLATES.map(t => `<button type="button" class="chip" data-ed="tpl" data-tpl="${t.id}">${esc(t.name)}</button>`).join('')}${state.templates.map(t => `<button type="button" class="chip" data-ed="tpl" data-user-tpl="${esc(t.id)}">${esc(t.name)}</button>`).join('')}</div>
            </div>`}
            <div class="ed-fields">
                <label class="field"><span>Type</span><select data-f="discipline">${disciplineOptions(d.discipline)}</select></label>
                <label class="field"><span>Date</span><input type="date" data-f="date" value="${esc(d.date)}" required></label>
                <label class="field"><span>Start <span class="muted">(optional)</span></span><input type="time" data-f="time" value="${esc(d.time)}"></label>
                <label class="field wide"><span>Title</span><input type="text" data-f="description" value="${esc(d.description)}" maxlength="120" placeholder="e.g. Threshold 4 × 6 min" autocomplete="off"></label>
                <div class="wide" data-ed-orient>${orientHTML()}</div>
            </div>
            <div class="ed-preview" data-ed-preview>${previewHTML()}</div>
            <h3 class="ed-sub">Blocks</h3>
            <div class="ed-blocks" data-ed-blocks>${d.blocks.map(blockHTML).join('')}</div>
            <button type="button" class="btn wide-btn" data-ed="add-block">${icon('plus', 18)} Add block</button>
            <div class="ed-extra">
                ${ed.showTemplateSave ? `<div class="tpl-save">
                    <label class="field"><span>Template name</span><input type="text" data-ed-tplname maxlength="60" value="${esc(d.description || '')}"></label>
                    <button type="button" class="btn" data-ed="tpl-save">Save template</button>
                </div>` : `<button type="button" class="link-btn" data-ed="tpl-open">Save as template</button>`}
                ${ed.id ? `<button type="button" class="link-btn danger" data-ed="delete">${icon('trash', 16)} Delete session</button>` : ''}
            </div>
        </div>
    </form>`;
}

function orientHTML() {
    const d = ed.draft;
    if (d.sport_type !== 'run') return '';
    const fixed = d.discipline === 'Orienteering';
    return `<label class="check-row"><input type="checkbox" data-f="orienteering"${fixed || d.orienteering ? ' checked' : ''}${fixed ? ' disabled' : ''}> Orienteering</label>`;
}

function previewHTML() {
    const blocks = ed.draft.blocks.map(cleanBlock);
    const p = M.summarizeBlocks(blocks, M.planCtx(payload(), state.zones));
    if (!p.duration_s) return '<p class="muted small">Add a time to a block to see the workout.</p>';
    const bits = [M.fmtDur(p.duration_s)];
    if (p.distance_km) bits.push(`${M.fmtKm(p.distance_km, 1)} km`);
    bits.push(`heart ${p.heart}`, `legs ${p.legs}`);
    return `${workoutGraph(blocks, { height: 64 })}
        <div class="ed-preview-line"><span class="legend">${zoneLegend(p.zones)}</span><b>${esc(bits.join(' · '))}</b></div>`;
}

function fieldVal(b, key, formatted) {
    return b._txt[key] !== undefined ? b._txt[key] : formatted;
}

function blockSummary(b) {
    return M.describeBlock(cleanBlock(b));
}

function blockHTML(b, i) {
    const n = ed.draft.blocks.length;
    const name = b.type || M.ZONE_LABEL[b.intensity];
    return `<section class="blk${b._open ? ' open' : ''}${Object.keys(b._err).length ? ' has-err' : ''}" data-k="${b._k}">
        <div class="blk-head">
            <button type="button" class="blk-toggle" data-ed="toggle" aria-expanded="${b._open}">
                <span class="blk-line1"><span class="blk-name">${esc(name)}</span><span class="blk-zone" style="color:${zoneText(b.intensity)}">${M.ZONE_LABEL[b.intensity]}</span></span>
                <span class="blk-sum" data-blk-sum>${esc(blockSummary(b))}</span>
            </button>
            <div class="blk-tools">
                <button type="button" class="icon-btn sm" data-ed="up" aria-label="Move block up"${i === 0 ? ' disabled' : ''}>${icon('up', 18)}</button>
                <button type="button" class="icon-btn sm" data-ed="down" aria-label="Move block down"${i === n - 1 ? ' disabled' : ''}>${icon('down', 18)}</button>
                <button type="button" class="icon-btn sm" data-ed="dup" aria-label="Duplicate block">${icon('copy', 18)}</button>
                <button type="button" class="icon-btn sm" data-ed="remove" aria-label="Remove block"${n === 1 ? ' disabled' : ''}>${icon('trash', 18)}</button>
            </div>
        </div>
        ${b._open ? blockBody(b) : ''}
    </section>`;
}

function err(b, key) {
    return b._err[key] ? `<span class="field-err">${esc(b._err[key])}</span>` : '';
}

function blockBody(b) {
    const reps = b._repeatOn;
    const r = b.repeat;
    const strength = b.intensity === 'strength';
    const sprint = b.intensity === 'sprint';
    const runSport = isRunSport(ed.draft.sport_type);
    const zonesAllowed = ed.draft.sport_type === 'strength' ? ['strength'] : M.ZONES.filter(z => z !== 'strength');
    const pace = runSport ? M.fmtPace(b.duration_s, b.distance_km) : '';
    return `<div class="blk-body">
        <label class="field wide"><span>Name</span><input type="text" data-bf="type" value="${esc(b.type)}" maxlength="80" placeholder="${strength ? 'e.g. Spanish squats 3 × 12' : 'e.g. Warm up'}" autocomplete="off"></label>
        ${zonesAllowed.length > 1 ? `<div class="field wide"><span class="label" id="zl-${b._k}">Zone</span>
            <div class="seg seg-zones" role="group" aria-labelledby="zl-${b._k}">${zonesAllowed.map(z =>
                `<button type="button" class="${b.intensity === z ? 'on' : ''}" data-ed="zone" data-z="${z}" aria-pressed="${b.intensity === z}"><span style="color:${zoneText(z)}">${M.ZONE_LABEL[z]}</span></button>`).join('')}</div>
        </div>` : ''}
        <div class="field-grid">
            <label class="field${b._err.dur ? ' invalid' : ''}"><span>${reps ? 'Time per rep' : 'Time'}</span>
                <input type="text" inputmode="text" autocomplete="off" data-bf="dur" value="${esc(fieldVal(b, 'dur', b.duration_s ? M.fmtClock(b.duration_s) : ''))}" placeholder="mm:ss"${b._err.dur ? ' aria-invalid="true"' : ''}>${err(b, 'dur')}
            </label>
            ${strength ? '' : `<label class="field${b._err.dist ? ' invalid' : ''}"><span>${reps ? 'Distance per rep' : 'Distance'} (km)</span>
                <input type="text" inputmode="decimal" autocomplete="off" data-bf="dist" value="${esc(fieldVal(b, 'dist', b.distance_km ?? ''))}" placeholder="optional"${b._err.dist ? ' aria-invalid="true"' : ''}>${err(b, 'dist')}
            </label>`}
            ${strength ? `<label class="field${b._err.rpe ? ' invalid' : ''}"><span>RPE (1–10)</span>
                <input type="text" inputmode="numeric" autocomplete="off" data-bf="rpe" value="${esc(fieldVal(b, 'rpe', b.rpe ?? M.DEFAULT_RPE))}"${b._err.rpe ? ' aria-invalid="true"' : ''}>${err(b, 'rpe')}
            </label>` : sprint ? '' : `<label class="field${b._err.hr ? ' invalid' : ''}"><span>Target HR</span>
                <input type="text" inputmode="numeric" autocomplete="off" data-bf="hr" value="${esc(fieldVal(b, 'hr', b.target_hr ?? ''))}" placeholder="bpm"${b._err.hr ? ' aria-invalid="true"' : ''}>${err(b, 'hr')}
            </label>`}
        </div>
        <p class="hint" data-blk-pace>${pace ? `Pace ${esc(pace)}${reps ? ' per rep' : ''}` : (b._err.dur ? '' : 'Time: 6:00, 0:35, 35s or 1:30:00')}</p>
        <label class="check-row"><input type="checkbox" data-bf="repeat"${reps ? ' checked' : ''}> Repeat</label>
        ${reps ? `<div class="repeat-box">
            <div class="field-grid">
                <label class="field${b._err.reps ? ' invalid' : ''}"><span>Reps</span><input type="text" inputmode="numeric" autocomplete="off" data-bf="reps" value="${esc(fieldVal(b, 'reps', r.reps))}">${err(b, 'reps')}</label>
                <label class="field${b._err.rest ? ' invalid' : ''}"><span>Rest</span><input type="text" inputmode="text" autocomplete="off" data-bf="rest" value="${esc(fieldVal(b, 'rest', M.fmtClock(r.rest_sec)))}" placeholder="1:00"${b._err.rest ? ' aria-invalid="true"' : ''}>${err(b, 'rest')}</label>
                <div class="field"><span class="label">Rest as</span>
                    <div class="seg">
                        <button type="button" class="${r.rest_type === 'moving' ? 'on' : ''}" data-ed="rest-type" data-v="moving" aria-pressed="${r.rest_type === 'moving'}">Jog</button>
                        <button type="button" class="${r.rest_type === 'standing' ? 'on' : ''}" data-ed="rest-type" data-v="standing" aria-pressed="${r.rest_type === 'standing'}">Stand</button>
                    </div>
                </div>
            </div>
            <details class="more"${r.customized || r.start_with === 'rest' || r.end_with === 'rest' ? ' open' : ''}>
                <summary>More options</summary>
                ${r.rest_type === 'moving' ? `<div class="field-grid">
                    <label class="field"><span>Rest zone</span><select data-bf="rest-zone">${M.HR_ZONE_KEYS.map(z => `<option value="${z}"${r.rest_intensity === z ? ' selected' : ''}>${M.ZONE_LABEL[z]}</option>`).join('')}</select></label>
                    <label class="field"><span>Rest HR</span><input type="text" inputmode="numeric" autocomplete="off" data-bf="rest-hr" value="${esc(fieldVal(b, 'rest-hr', r.rest_target_hr ?? ''))}" placeholder="bpm"></label>
                </div>` : ''}
                <label class="check-row"><input type="checkbox" data-bf="start-rest"${r.start_with === 'rest' ? ' checked' : ''}> Start with a rest</label>
                <label class="check-row"><input type="checkbox" data-bf="end-rest"${r.end_with === 'rest' ? ' checked' : ''}> End with a rest</label>
                <label class="check-row"><input type="checkbox" data-bf="custom"${r.customized ? ' checked' : ''}> Set each rep separately</label>
                ${r.customized ? perRepHTML(b) : ''}
            </details>
        </div>` : ''}
    </div>`;
}

function perRepHTML(b) {
    const r = b.repeat;
    const strength = b.intensity === 'strength';
    return `<div class="per-rep">
        <div class="pr-row pr-head" aria-hidden="true"><span>#</span><span>Time</span>${strength ? '' : '<span>km</span><span>HR</span>'}</div>
        ${r.per_rep.map((p, i) => `<div class="pr-row">
            <span>${i + 1}</span>
            <input type="text" inputmode="text" autocomplete="off" data-bf="pr-dur" data-r="${i}" value="${esc(fieldVal(b, `pr-dur-${i}`, M.fmtClock(p.duration_s)))}" aria-label="Rep ${i + 1} time">
            ${strength ? '' : `<input type="text" inputmode="decimal" autocomplete="off" data-bf="pr-dist" data-r="${i}" value="${esc(fieldVal(b, `pr-dist-${i}`, p.distance_km ?? ''))}" aria-label="Rep ${i + 1} distance in km">
            <input type="text" inputmode="numeric" autocomplete="off" data-bf="pr-hr" data-r="${i}" value="${esc(fieldVal(b, `pr-hr-${i}`, p.target_hr ?? ''))}" aria-label="Rep ${i + 1} target heart rate">`}
        </div>`).join('')}
    </div>`;
}

function syncPerRep(b) {
    const r = b.repeat;
    const reps = Math.max(1, r.reps || 1);
    while (r.per_rep.length < reps) r.per_rep.push({ duration_s: b.duration_s, distance_km: b.distance_km, target_hr: b.target_hr });
    r.per_rep.length = reps;
}

function rerenderBlock(b, focusSel) {
    const i = ed.draft.blocks.indexOf(b);
    const el = ed.panel.querySelector(`.blk[data-k="${b._k}"]`);
    if (!el) return;
    el.outerHTML = blockHTML(b, i);
    if (focusSel) {
        const f = ed.panel.querySelector(`.blk[data-k="${b._k}"] ${focusSel}`);
        if (f) f.focus();
    }
}

function rerenderBlocks() {
    ed.panel.querySelector('[data-ed-blocks]').innerHTML = ed.draft.blocks.map(blockHTML).join('');
}

function refreshPreview() {
    ed.panel.querySelector('[data-ed-preview]').innerHTML = previewHTML();
}

function refreshBlockLine(b) {
    const el = ed.panel.querySelector(`.blk[data-k="${b._k}"]`);
    if (!el) return;
    const sum = el.querySelector('[data-blk-sum]');
    if (sum) sum.textContent = blockSummary(b);
    const name = el.querySelector('.blk-name');
    if (name) name.textContent = b.type || M.ZONE_LABEL[b.intensity];
    const pace = el.querySelector('[data-blk-pace]');
    if (pace) {
        const p = isRunSport(ed.draft.sport_type) ? M.fmtPace(b.duration_s, b.distance_km) : '';
        pace.textContent = p ? `Pace ${p}${b._repeatOn ? ' per rep' : ''}` : 'Time: 6:00, 0:35, 35s or 1:30:00';
    }
    el.classList.toggle('has-err', Object.keys(b._err).length > 0);
}

function setFieldError(input, b, key, message) {
    if (message) b._err[key] = message; else delete b._err[key];
    const field = input.closest('.field');
    if (field) {
        field.classList.toggle('invalid', !!message);
        let e = field.querySelector('.field-err');
        if (message && !e) { e = document.createElement('span'); e.className = 'field-err'; field.appendChild(e); }
        if (e) { if (message) e.textContent = message; else e.remove(); }
    }
    if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function blockOf(el) {
    const sec = el.closest('.blk');
    if (!sec) return null;
    const k = Number(sec.dataset.k);
    return ed.draft.blocks.find(b => b._k === k) || null;
}

function bind(panel) {
    panel.addEventListener('submit', e => { e.preventDefault(); save(); });
    panel.addEventListener('click', onClick);
    panel.addEventListener('input', onInput);
    panel.addEventListener('change', onChange);
}

function onClick(e) {
    const t = e.target.closest('[data-ed]');
    if (!t || !ed) return;
    const act = t.dataset.ed;
    const b = blockOf(t);
    const blocks = ed.draft.blocks;
    switch (act) {
        case 'cancel': requestClose(ed.entry); break;
        case 'tpl': {
            const tpl = findTemplate({ tpl: t.dataset.tpl, userTpl: t.dataset.userTpl });
            if (!tpl) return;
            const s = sessionFromTemplate(tpl, ed.draft.date);
            ed.draft.sport_type = s.sport_type;
            ed.draft.discipline = s.discipline;
            ed.draft.description = s.description;
            ed.draft.blocks = s.blocks.map(x => draftBlock(x, false));
            renderAll();
            break;
        }
        case 'toggle': b._open = !b._open; rerenderBlock(b, b._open ? 'input[data-bf="type"]' : '.blk-toggle'); break;
        case 'up': case 'down': {
            const i = blocks.indexOf(b), j = act === 'up' ? i - 1 : i + 1;
            if (j < 0 || j >= blocks.length) return;
            [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
            rerenderBlocks(); refreshPreview();
            const btn = ed.panel.querySelector(`.blk[data-k="${b._k}"] [data-ed="${act}"]`);
            (btn && !btn.disabled ? btn : ed.panel.querySelector(`.blk[data-k="${b._k}"] .blk-toggle`)).focus();
            break;
        }
        case 'dup': {
            const copy = draftBlock(cleanBlock(b), false);
            blocks.splice(blocks.indexOf(b) + 1, 0, copy);
            rerenderBlocks(); refreshPreview();
            break;
        }
        case 'remove': {
            if (blocks.length <= 1) return;
            blocks.splice(blocks.indexOf(b), 1);
            rerenderBlocks(); refreshPreview();
            break;
        }
        case 'add-block': {
            const nb = newBlock();
            blocks.forEach(x => { x._open = false; });
            blocks.push(nb);
            rerenderBlocks(); refreshPreview();
            const f = ed.panel.querySelector(`.blk[data-k="${nb._k}"] input[data-bf="type"]`);
            if (f) f.focus();
            break;
        }
        case 'zone': {
            const z = t.dataset.z;
            const prevDefault = defaultHr(b.intensity);
            b.intensity = z;
            if (M.HR_ZONE_KEYS.includes(z)) {
                if (b.target_hr === null || b.target_hr === prevDefault) b.target_hr = defaultHr(z);
            } else if (z === 'sprint') {
                b.target_hr = null;
            }
            if (z === 'strength' && !b.rpe) b.rpe = M.DEFAULT_RPE;
            delete b._txt.hr; delete b._err.hr;
            rerenderBlock(b, `[data-ed="zone"][data-z="${z}"]`);
            refreshPreview();
            break;
        }
        case 'rest-type': {
            b.repeat.rest_type = t.dataset.v;
            if (b.repeat.rest_type === 'moving' && !b.repeat.rest_target_hr) b.repeat.rest_target_hr = zonesFor(ed.draft.sport_type)[b.repeat.rest_intensity] ?? null;
            rerenderBlock(b, `[data-ed="rest-type"][data-v="${t.dataset.v}"]`);
            refreshPreview();
            break;
        }
        case 'tpl-open': ed.showTemplateSave = true; renderAll(); { const f = ed.panel.querySelector('[data-ed-tplname]'); if (f) { f.focus(); f.select(); } } break;
        case 'tpl-save': {
            const name = (ed.panel.querySelector('[data-ed-tplname]').value || '').trim();
            if (!name) { showError('Give the template a name.'); return; }
            if (hasErrors()) { showError('Fix the highlighted fields first.'); return; }
            saveTemplate(name, payload()).then(row => { if (row && ed) { ed.showTemplateSave = false; renderAll(); } });
            break;
        }
        case 'delete': {
            const id = ed.id;
            requestClose(ed.entry, { force: true });
            deleteSession(id);
            break;
        }
    }
}

function onInput(e) {
    if (!ed) return;
    const el = e.target;
    if (el.dataset.f) {
        const f = el.dataset.f;
        if (f === 'description') ed.draft.description = el.value;
        if (f === 'time') ed.draft.time = el.value;
        if (f === 'date' && el.value) ed.draft.date = el.value;
        return;
    }
    const key = el.dataset.bf;
    if (!key) return;
    const b = blockOf(el);
    if (!b) return;
    const v = el.value;
    const r = b.repeat;
    switch (key) {
        case 'type': b.type = v; break;
        case 'dur': {
            b._txt.dur = v;
            const s = M.parseDuration(v, 'min');
            if (Number.isNaN(s)) { setFieldError(el, b, 'dur', 'Use mm:ss, e.g. 6:00 or 0:35'); break; }
            setFieldError(el, b, 'dur', null);
            b.duration_s = s ?? 0;
            break;
        }
        case 'dist': {
            b._txt.dist = v;
            const km = M.parseDistance(v);
            if (Number.isNaN(km)) { setFieldError(el, b, 'dist', 'Use km, e.g. 1.55 or 200m'); break; }
            setFieldError(el, b, 'dist', null);
            b.distance_km = km;
            break;
        }
        case 'hr': {
            b._txt.hr = v;
            const n = M.parseNumber(v);
            if (Number.isNaN(n) || (n !== null && (n < 40 || n > 240))) { setFieldError(el, b, 'hr', 'Heart rate in bpm'); break; }
            setFieldError(el, b, 'hr', null);
            b.target_hr = n === null ? null : Math.round(n);
            break;
        }
        case 'rpe': {
            b._txt.rpe = v;
            const n = M.parseNumber(v);
            if (n === null || Number.isNaN(n) || n < 1 || n > 10) { setFieldError(el, b, 'rpe', 'A number from 1 to 10'); break; }
            setFieldError(el, b, 'rpe', null);
            b.rpe = Math.round(n);
            break;
        }
        case 'reps': {
            b._txt.reps = v;
            const n = M.parseNumber(v);
            if (n === null || Number.isNaN(n) || n < 1 || n > 99 || Math.round(n) !== n) { setFieldError(el, b, 'reps', 'Whole number, 1–99'); break; }
            setFieldError(el, b, 'reps', null);
            r.reps = n;
            break;
        }
        case 'rest': {
            b._txt.rest = v;
            const s = M.parseDuration(v, 'sec');
            if (Number.isNaN(s)) { setFieldError(el, b, 'rest', 'Use mm:ss or seconds, e.g. 1:00 or 90'); break; }
            setFieldError(el, b, 'rest', null);
            r.rest_sec = s ?? 0;
            break;
        }
        case 'rest-hr': {
            b._txt['rest-hr'] = v;
            const n = M.parseNumber(v);
            r.rest_target_hr = n === null || Number.isNaN(n) ? null : Math.round(n);
            break;
        }
        case 'pr-dur': case 'pr-dist': case 'pr-hr': {
            const i = Number(el.dataset.r);
            const p = r.per_rep[i];
            if (!p) break;
            b._txt[`${key}-${i}`] = v;
            if (key === 'pr-dur') {
                const s = M.parseDuration(v, 'min');
                if (Number.isNaN(s)) { setFieldError(el, b, `pr-${i}`, 'mm:ss'); break; }
                setFieldError(el, b, `pr-${i}`, null);
                p.duration_s = s ?? 0;
            } else if (key === 'pr-dist') {
                const km = M.parseDistance(v);
                if (Number.isNaN(km)) { setFieldError(el, b, `prd-${i}`, 'km'); break; }
                setFieldError(el, b, `prd-${i}`, null);
                p.distance_km = km;
            } else {
                const n = M.parseNumber(v);
                p.target_hr = n === null || Number.isNaN(n) ? null : Math.round(n);
            }
            break;
        }
        default: return;
    }
    refreshBlockLine(b);
    refreshPreview();
}

function onChange(e) {
    if (!ed) return;
    const el = e.target;
    if (el.dataset.f === 'orienteering') {
        ed.draft.orienteering = el.checked;
        refreshPreview();
        return;
    }
    if (el.dataset.f === 'discipline') {
        const prevSport = ed.draft.sport_type;
        ed.draft.discipline = el.value;
        ed.draft.sport_type = getParentSportForDiscipline(el.value);
        const o = ed.panel.querySelector('[data-ed-orient]');
        if (o) o.innerHTML = orientHTML();
        refreshPreview();
        const toStrength = ed.draft.sport_type === 'strength';
        if (toStrength !== (prevSport === 'strength') || ed.draft.sport_type !== prevSport) {
            ed.draft.blocks.forEach(b => {
                if (toStrength) { b.intensity = 'strength'; b.target_hr = null; b.rpe = b.rpe || M.DEFAULT_RPE; }
                else if (b.intensity === 'strength') { b.intensity = 'easy'; b.target_hr = defaultHr('easy'); }
                else if (M.HR_ZONE_KEYS.includes(b.intensity)) {
                    const old = zonesFor(prevSport)[b.intensity];
                    if (b.target_hr === null || b.target_hr === old) b.target_hr = defaultHr(b.intensity);
                }
                delete b._txt.hr;
            });
            rerenderBlocks();
            refreshPreview();
        }
        return;
    }
    if (el.dataset.f === 'date' && el.value) { ed.draft.date = el.value; return; }
    const key = el.dataset.bf;
    if (!key) return;
    const b = blockOf(el);
    if (!b) return;
    const r = b.repeat;
    if (key === 'repeat') {
        b._repeatOn = el.checked;
        if (el.checked && (r.reps || 0) < 2) r.reps = 4;
        if (el.checked && r.rest_type === 'moving' && !r.rest_target_hr) r.rest_target_hr = zonesFor(ed.draft.sport_type)[r.rest_intensity] ?? null;
        delete b._txt.reps; delete b._err.reps;
        rerenderBlock(b, 'input[data-bf="repeat"]');
    } else if (key === 'rest-zone') {
        r.rest_intensity = el.value;
        r.rest_target_hr = zonesFor(ed.draft.sport_type)[el.value] ?? null;
        delete b._txt['rest-hr'];
        rerenderBlock(b, 'select[data-bf="rest-zone"]');
    } else if (key === 'start-rest' || key === 'end-rest') {
        r[key === 'start-rest' ? 'start_with' : 'end_with'] = el.checked ? 'rest' : 'interval';
    } else if (key === 'custom') {
        r.customized = el.checked;
        if (el.checked) syncPerRep(b);
        rerenderBlock(b, 'input[data-bf="custom"]');
    } else if (key === 'reps' && r.customized && !b._err.reps) {
        syncPerRep(b);
        rerenderBlock(b, 'input[data-bf="reps"]');
    } else {
        return;
    }
    refreshBlockLine(b);
    refreshPreview();
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

function hasErrors() {
    return ed.draft.blocks.some(b => Object.keys(b._err).length > 0);
}

function showError(msg) {
    ed.error = msg;
    const el = ed.panel.querySelector('[data-ed-error]');
    if (el) {
        el.textContent = msg;
        el.hidden = !msg;
        if (msg) el.scrollIntoView({ block: 'nearest' });
    }
}

async function save() {
    if (!ed) return;
    const firstBad = ed.draft.blocks.find(b => Object.keys(b._err).length > 0);
    if (firstBad) {
        if (!firstBad._open) { firstBad._open = true; rerenderBlock(firstBad); }
        showError('Fix the highlighted fields.');
        const f = ed.panel.querySelector(`.blk[data-k="${firstBad._k}"] [aria-invalid="true"]`);
        if (f) f.focus();
        return;
    }
    const p = payload();
    if (!p.date) { showError('Pick a date.'); return; }
    if (!M.summarizeBlocks(p.blocks).duration_s) { showError('Give at least one block a time.'); return; }
    const id = ed.id;
    const entry = ed.entry;
    // Close first so the list underneath shows the result right away.
    requestClose(entry, { force: true });
    if (id) {
        const row = await updateSession(id, p);
        if (row) toast({ text: 'Saved' });
    } else {
        await createSession(p);
    }
    if (p.date !== state.selected) select(p.date);
}
