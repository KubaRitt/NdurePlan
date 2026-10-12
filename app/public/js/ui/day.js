// One day: Plan tab (sessions + add from template) and Diary tab (what happened).

import * as M from '../model.js';
import { state, sessionsOn, diaryOn, planOf, doneOf, activitiesFor } from '../state.js';
import { BUILT_IN_TEMPLATES } from '../templates.js';
import { esc, icon, zoneText } from './util.js';
import { workoutGraph } from './graph.js';
import { sessionMeta } from './week.js';
import { activityList } from './activity.js';

export function defaultTab(date, context) {
    if (state.dayTab[date]) return state.dayTab[date];
    if (context === 'today') return 'diary'; // the Today tab is for logging
    return date <= state.today && sessionsOn(date).length ? 'diary' : 'plan';
}

/**
 * @param date     'YYYY-MM-DD'
 * @param context  'sheet' (phone bottom sheet) | 'inline' (desktop right column) | 'today' (phone Today tab)
 */
export function dayPanel(date, context) {
    const tab = defaultTab(date, context);
    const title = context === 'today' ? 'Today' : M.fmtDayTitle(date);
    const sub = context === 'today' ? M.fmtDayTitle(date) : (date === state.today ? 'Today' : '');
    const head = context === 'sheet'
        ? `<header class="sheet-head">
                <div><h2 id="day-title">${esc(title)}</h2>${sub ? `<p class="muted small">${esc(sub)}</p>` : ''}</div>
                <button type="button" class="icon-btn" data-action="close-overlay" aria-label="Close">${icon('x')}</button>
           </header>`
        : `<header class="panel-head"><h2 id="day-title">${esc(title)}</h2>${sub ? `<p class="muted small">${esc(sub)}</p>` : ''}</header>`;
    return `<div class="day-panel" data-day="${date}" data-context="${context}">
        ${head}
        <div class="tabs" role="tablist" aria-label="Plan or diary">
            <button type="button" role="tab" class="tab${tab === 'plan' ? ' on' : ''}" aria-selected="${tab === 'plan'}" data-action="day-tab" data-tab="plan" data-date="${date}">Plan</button>
            <button type="button" role="tab" class="tab${tab === 'diary' ? ' on' : ''}" aria-selected="${tab === 'diary'}" data-action="day-tab" data-tab="diary" data-date="${date}">Diary</button>
        </div>
        <div class="day-body" role="tabpanel">
            ${tab === 'plan' ? planTab(date) : diaryTab(date)}
        </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Plan tab
// ---------------------------------------------------------------------------

export function templateChips(date, action = 'add-template') {
    const mine = state.templates.map(t => `<button type="button" class="chip" data-action="${action}" data-user-tpl="${esc(t.id)}" data-date="${date}">${esc(t.name)}</button>`);
    const built = BUILT_IN_TEMPLATES.map(t => `<button type="button" class="chip" data-action="${action}" data-tpl="${t.id}" data-date="${date}">${esc(t.name)}</button>`);
    return [...built, ...mine].join('');
}

function planTab(date) {
    const list = sessionsOn(date);
    return `
        <div class="add-row">
            <p class="label">Add a session</p>
            <div class="chips">
                ${templateChips(date)}
                <button type="button" class="chip chip-plain" data-action="new-session" data-date="${date}">${icon('plus', 16)} Custom</button>
            </div>
        </div>
        ${list.length ? list.map(sessionCard).join('') : '<p class="empty">Rest day. Pick a template above to plan a session.</p>'}
    `;
}

function sessionCard(s) {
    const blocks = (s.blocks || []).map(M.normalizeBlock);
    const plan = planOf(s);
    const done = s.done ? doneOf(s) : null;
    return `<article class="s-card" data-session="${esc(s.id)}">
        <header class="s-card-head">
            <div class="s-card-titles">
                <h3>${esc(M.sessionTitle(s))}</h3>
                <p class="muted small">${sessionMeta(s)}${plan.duration_s ? ` · heart ${plan.heart} · legs ${plan.legs}` : ''}</p>
            </div>
            <div class="s-card-actions">
                <button type="button" class="icon-btn" data-action="edit-session" data-id="${esc(s.id)}" aria-label="Edit “${esc(M.sessionTitle(s))}”">${icon('pencil', 18)}</button>
                <button type="button" class="icon-btn" data-action="duplicate-session" data-id="${esc(s.id)}" aria-label="Duplicate “${esc(M.sessionTitle(s))}”">${icon('copy', 18)}</button>
                <button type="button" class="icon-btn" data-action="delete-session" data-id="${esc(s.id)}" aria-label="Delete “${esc(M.sessionTitle(s))}”">${icon('trash', 18)}</button>
            </div>
        </header>
        ${workoutGraph(blocks)}
        <ol class="block-list">
            ${blocks.map(b => `<li>
                <div class="bl-top"><span class="bl-name">${esc(b.type || M.ZONE_LABEL[b.intensity])}</span><span class="bl-zone" style="color:${zoneText(b.intensity)}">${M.ZONE_LABEL[b.intensity]}</span></div>
                <div class="bl-desc">${esc(M.describeBlock(b))}</div>
            </li>`).join('')}
        </ol>
        ${done ? `<p class="done-note">${icon('check', 16)} Done${done.files ? ` · ${done.files === 1 ? 'file' : `${done.files} files`}` : ''} · heart ${done.heart} · legs ${done.legs}${s.rpe ? ` · RPE ${esc(s.rpe)}` : ''}${s.notes ? ` · “${esc(s.notes)}”` : ''}</p>` : ''}
    </article>`;
}

// ---------------------------------------------------------------------------
// Diary tab
// ---------------------------------------------------------------------------

const LEGS = [['fresh', 'Fresh'], ['normal', 'Normal'], ['heavy', 'Heavy'], ['very tired', 'Very tired']];

function val(v) { return v === null || v === undefined ? '' : esc(v); }

function sessionLog(s) {
    const plan = planOf(s);
    const a = s.actual || {};
    const id = esc(s.id);
    const showKm = s.sport_type !== 'strength';
    const hasFiles = activitiesFor(s.id).length > 0;
    const run = s.sport_type === 'run';
    const fixedO = s.discipline === 'Orienteering';
    return `<article class="log-card" data-session="${id}">
        <label class="switch-row">
            <input type="checkbox" data-log="done" data-id="${id}"${s.done ? ' checked' : ''}>
            <span class="switch" aria-hidden="true"></span>
            <span class="switch-text"><b>${esc(M.sessionTitle(s))}</b><span class="muted small">${plan.duration_s ? `${esc(M.fmtDur(plan.duration_s))} planned${plan.distance_km ? ` · ${esc(M.fmtKm(plan.distance_km, 1))} km` : ''}` : esc(s.discipline || 'Unplanned')}</span></span>
        </label>
        ${run ? `<label class="check-row o-check"><input type="checkbox" data-log="orienteering" data-id="${id}"${s.orienteering || fixedO ? ' checked' : ''}${fixedO ? ' disabled' : ''}> Orienteering</label>` : ''}
        ${activityList(s)}
        ${hasFiles ? '' : `<div class="field-grid">
            <label class="field"><span>Time</span>
                <input type="text" inputmode="numeric" autocomplete="off" data-log="duration" data-id="${id}" value="${a.duration_s ? esc(M.fmtClock(a.duration_s)) : ''}" placeholder="${esc(M.fmtClock(plan.duration_s))}">
            </label>
            ${showKm ? `<label class="field"><span>Distance (km)</span>
                <input type="text" inputmode="decimal" autocomplete="off" data-log="km" data-id="${id}" value="${val(a.km)}" placeholder="${plan.distance_km ? esc(M.fmtKm(plan.distance_km, 2)) : ''}">
            </label>` : ''}
            <label class="field"><span>Avg HR</span>
                <input type="text" inputmode="numeric" autocomplete="off" data-log="hr" data-id="${id}" value="${val(a.hr)}" placeholder="bpm">
            </label>
        </div>`}
        <fieldset class="rpe">
            <legend>How hard (RPE 1–10)</legend>
            <div class="seg seg-10">${Array.from({ length: 10 }, (_, i) => i + 1).map(n =>
                `<button type="button" class="${Number(s.rpe) === n ? 'on' : ''}" data-action="set-rpe" data-id="${id}" data-rpe="${n}" aria-pressed="${Number(s.rpe) === n}">${n}</button>`).join('')}</div>
        </fieldset>
        <label class="field"><span>Notes</span>
            <textarea rows="2" data-log="notes" data-id="${id}" placeholder="Terrain, map, how it felt">${val(s.notes)}</textarea>
        </label>
    </article>`;
}

function diaryTab(date) {
    const list = sessionsOn(date);
    const d = diaryOn(date) || {};
    const pain = d.pain === null || d.pain === undefined || d.pain === '' ? null : Number(d.pain);
    return `
        <div class="import-row">
            <button type="button" class="btn" data-action="import-files">${icon('upload', 18)} Add FIT files</button>
            <span class="hint">From your watch or Garmin Connect (.fit or .zip). They go to the right day by themselves.</span>
        </div>
        ${list.length ? `<p class="hint">Tick what you did. Add the watch file, or fill in time, distance or HR where it differed from the plan.</p>${list.map(sessionLog).join('')}` : '<p class="empty">Nothing planned. Add a FIT file, log how you feel below, or add a session in the Plan tab.</p>'}
        <article class="log-card day-log">
            <h3>The day</h3>
            <div class="field-grid">
                <label class="field"><span>Sleep (h)</span>
                    <input type="text" inputmode="decimal" autocomplete="off" data-diary="sleep_h" data-date="${date}" value="${val(d.sleep_h)}" placeholder="8">
                </label>
                <label class="field"><span>Resting HR</span>
                    <input type="text" inputmode="numeric" autocomplete="off" data-diary="rest_hr" data-date="${date}" value="${val(d.rest_hr)}" placeholder="bpm">
                </label>
            </div>
            <fieldset class="legs">
                <legend>Legs</legend>
                <div class="seg">${LEGS.map(([v, l]) =>
                    `<button type="button" class="${d.legs === v ? 'on' : ''}" data-action="set-legs" data-date="${date}" data-value="${v}" aria-pressed="${d.legs === v}">${l}</button>`).join('')}</div>
            </fieldset>
            <div class="field pain">
                <label for="pain-${date}">Knee / IT band pain <output data-pain-out="${date}">${pain === null ? 'not logged' : `${pain}/10`}</output></label>
                <input id="pain-${date}" type="range" min="0" max="10" step="1" data-diary="pain" data-date="${date}" value="${pain ?? 0}" aria-valuetext="${pain === null ? 'not logged' : `${pain} out of 10`}">
                <div class="range-ends muted small" aria-hidden="true"><span>0 none</span><span>10 severe</span></div>
                ${pain === null
                    ? `<button type="button" class="link-btn" data-action="set-pain" data-date="${date}" data-value="0">No pain today</button>`
                    : `<button type="button" class="link-btn" data-action="set-pain" data-date="${date}" data-value="">Clear</button>`}
                ${pain !== null && pain >= 3 ? '<p class="note note-pain">3 or more shows up in the week summary. If it’s still there tomorrow morning, swap the next run for the bike.</p>' : ''}
            </div>
            <label class="field"><span>Notes</span>
                <textarea rows="3" data-diary="notes" data-date="${date}" placeholder="How did the day feel?">${val(d.notes)}</textarea>
            </label>
        </article>
    `;
}
