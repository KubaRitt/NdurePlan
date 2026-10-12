// NdurePlan - app entry. Wires state, views and events together.

import { getAuthSession } from '../supabase_api.js';
import * as M from './model.js';
import * as S from './state.js';
import { state } from './state.js';
import { toast, initToast } from './ui/toast.js';
import { openOverlay, requestClose, topOverlay } from './ui/overlay.js';
import { esc, icon, $, $all } from './ui/util.js';
import * as W from './ui/week.js';
import { dayPanel } from './ui/day.js';
import { openEditor, findTemplate, sessionFromTemplate } from './ui/editor.js';
import { settingsView, bindSettingsForm } from './ui/settings.js';
import { openImport } from './ui/activity.js';

const desktopMQ = window.matchMedia('(min-width: 1024px)');
const layout = () => (desktopMQ.matches ? 'desktop' : 'phone');

const ui = {
    cal: null,          // { y, m } month shown in the desktop calendar
    tl: null,           // { from, to } Mondays rendered in the desktop timeline
    daySheet: null,     // { entry, date } open phone day sheet
    scrollToSelected: true,
    lastLayout: null
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTyping(root) {
    const a = document.activeElement;
    if (!a || !root || !root.contains(a)) return false;
    return a.matches('input[type=text], input:not([type]), input[type=number], textarea, select, input[type=range], input[type=date], input[type=time]');
}

// Re-render `el` and put focus back on the equivalent control.
function renderInto(el, html) {
    const a = document.activeElement;
    let key = null;
    if (a && el.contains(a) && a.dataset) {
        key = ['action', 'id', 'date', 'tab', 'value', 'rpe', 'tpl'].map(k => a.dataset[k] ? `[data-${k}="${CSS.escape(a.dataset[k])}"]` : '').join('');
    }
    el.innerHTML = html;
    if (key) {
        const again = el.querySelector(key);
        if (again) { try { again.focus({ preventScroll: true }); } catch { again.focus(); } }
    }
}

function applyTheme() {
    const root = document.documentElement;
    if (state.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = state.theme;
}

let statusTimer = null;
function setStatus(kind) {
    const el = $('#save-status');
    if (!el) return;
    clearTimeout(statusTimer);
    el.dataset.kind = kind;
    el.textContent = kind === 'saving' ? 'Saving…' : kind === 'error' ? 'Not saved' : 'Saved';
    if (kind === 'saved') statusTimer = setTimeout(() => { el.textContent = ''; }, 2000);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(kind = 'data') {
    applyTheme();
    const lay = layout();
    if (lay !== ui.lastLayout) {
        document.body.dataset.layout = lay;
        ui.lastLayout = lay;
        ui.scrollToSelected = true;
    }
    renderChrome();
    const view = state.view === 'today' && lay === 'desktop' ? 'plan' : state.view;
    $('#view-plan').hidden = view !== 'plan';
    $('#view-today').hidden = view !== 'today';
    $('#view-settings').hidden = view !== 'settings';

    if (state.loading) {
        $('#view-plan').innerHTML = '<p class="loading">Loading your plan…</p>';
        return;
    }
    if (view === 'settings') {
        if (kind !== 'passive' && !isTyping($('#view-settings'))) {
            renderInto($('#view-settings'), settingsView());
            bindSettingsForm($('#view-settings'));
        }
    } else if (view === 'today') {
        renderToday(kind);
    } else if (lay === 'phone') {
        renderPhoneWeek();
    } else {
        renderDesktop(kind);
    }
    refreshDaySheet(kind);
}

function renderChrome() {
    const email = $('#user-email');
    if (email) email.textContent = state.email || '';
    $all('[data-action="nav"]').forEach(b => {
        const v = b.dataset.view;
        const cur = state.view === v || (v === 'plan' && state.view === 'today' && layout() === 'desktop');
        b.classList.toggle('on', cur);
        if (cur) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    const banner = $('#banner');
    const msg = state.schemaError || state.loadError;
    banner.hidden = !msg;
    banner.textContent = msg || '';
}

// --- phone -----------------------------------------------------------------

function renderPhoneWeek() {
    const monday = M.mondayOf(state.selected);
    renderInto($('#view-plan'), `
        ${W.weekBar(monday)}
        ${W.weekStrip(monday)}
        ${W.weekSummary(monday)}
        <div class="tools">
            <button type="button" class="btn" data-action="import-files">${icon('upload', 18)} Add files</button>
            <button type="button" class="btn" data-action="copy-week">${icon('copy', 18)} Copy a week…</button>
        </div>
        <div class="day-cards">${M.weekDates(monday).map(W.dayCard).join('')}</div>
    `);
}

function renderToday(kind) {
    const el = $('#view-today');
    if (kind === 'passive' || isTyping(el)) return;
    const cur = el.querySelector('.day-panel');
    if (cur && cur.dataset.day !== state.today) ui.scrollToSelected = true;
    renderInto(el, dayPanel(state.today, 'today'));
}

function openDaySheet(date) {
    if (ui.daySheet) { ui.daySheet.date = date; refreshDaySheet('ui'); return; }
    const entry = openOverlay({
        kind: 'sheet',
        label: M.fmtDayTitle(date),
        render: panel => { panel.innerHTML = dayPanel(date, 'sheet'); },
        onClose: () => { if (ui.daySheet && ui.daySheet.entry === entry) ui.daySheet = null; S.flushPending(); }
    });
    ui.daySheet = { entry, date };
}

function refreshDaySheet(kind) {
    const ds = ui.daySheet;
    if (!ds) return;
    if (kind === 'passive' || isTyping(ds.entry.panel)) return;
    const body = ds.entry.panel.querySelector('.day-body');
    const scroll = body ? body.scrollTop : 0;
    renderInto(ds.entry.panel, dayPanel(ds.date, 'sheet'));
    const nb = ds.entry.panel.querySelector('.day-body');
    if (nb) nb.scrollTop = scroll;
}

// --- desktop ---------------------------------------------------------------

function ensureTimelineAround(date) {
    const monday = M.mondayOf(date);
    if (!ui.tl || monday < ui.tl.from || monday > ui.tl.to) {
        ui.tl = { from: M.addDays(monday, -7 * 4), to: M.addDays(monday, 7 * 8) };
        ui.scrollToSelected = true;
    }
    S.ensureRange(ui.tl.from, M.addDays(ui.tl.to, 6));
}

function timelineHTML() {
    const weeks = [];
    for (let m = ui.tl.from; m <= ui.tl.to; m = M.addDays(m, 7)) weeks.push(W.timelineWeek(m));
    return weeks.join('');
}

function renderDesktop(kind) {
    const root = $('#view-plan');
    if (!root.querySelector('.cols')) {
        root.innerHTML = `<div class="cols">
            <aside class="col col-left" aria-label="Calendar and week summary"><div data-region="cal"></div><div data-region="summary"></div></aside>
            <section class="col col-mid" aria-label="Weeks">
                <div class="tl-toolbar">
                    <h1 class="tl-title" data-region="tl-title"></h1>
                    <div class="tl-tools">
                        <button type="button" class="btn small" data-action="go-today">Today</button>
                        <button type="button" class="btn small" data-action="import-files">${icon('upload', 16)} Add files</button>
                        <button type="button" class="btn small" data-action="copy-week">${icon('copy', 16)} Copy a week…</button>
                        <button type="button" class="btn small" data-action="toggle-density" data-region="density"></button>
                    </div>
                </div>
                <div class="tl-scroll" data-region="timeline" tabindex="-1"></div>
            </section>
            <aside class="col col-right" data-region="day" aria-label="Selected day"></aside>
        </div>`;
        const sc = root.querySelector('[data-region="timeline"]');
        sc.addEventListener('scroll', onTimelineScroll, { passive: true });
    }
    if (!ui.tl) ensureTimelineAround(state.selected);
    const sel = state.selected;
    if (!ui.cal) ui.cal = { y: M.parseISODate(sel).getFullYear(), m: M.parseISODate(sel).getMonth() };

    renderInto(root.querySelector('[data-region="cal"]'), W.calendar(ui.cal.y, ui.cal.m));
    renderInto(root.querySelector('[data-region="summary"]'), W.weekSummary(M.mondayOf(sel)));
    root.querySelector('[data-region="tl-title"]').textContent = `${M.monthLong(M.parseISODate(sel).getMonth())} ${M.parseISODate(sel).getFullYear()}`;
    root.querySelector('[data-region="density"]').textContent = state.density === 'compact' ? 'Detailed' : 'Compact';

    const sc = root.querySelector('[data-region="timeline"]');
    const prevTop = sc.scrollTop;
    renderInto(sc, timelineHTML());
    sc.scrollTop = prevTop;
    if (ui.scrollToSelected) {
        ui.scrollToSelected = false;
        requestAnimationFrame(() => {
            const day = sc.querySelector(`.tl-day[data-date="${sel}"]`);
            const week = day && day.closest('.tl-week');
            if (week) sc.scrollTop += week.getBoundingClientRect().top - sc.getBoundingClientRect().top;
        });
    } else {
        const day = sc.querySelector(`.tl-day[data-date="${sel}"]`);
        if (day) {
            const r = day.getBoundingClientRect(), c = sc.getBoundingClientRect();
            if (r.top < c.top || r.bottom > c.bottom) day.scrollIntoView({ block: 'nearest' });
        }
    }

    const dayEl = root.querySelector('[data-region="day"]');
    const shown = dayEl.querySelector('.day-panel');
    const sameDay = shown && shown.dataset.day === sel;
    if (!(kind === 'passive' && sameDay) && !(sameDay && isTyping(dayEl))) {
        renderInto(dayEl, dayPanel(sel, 'inline'));
        if (!sameDay) dayEl.scrollTop = 0;
    }
}

let extending = false;
function onTimelineScroll(e) {
    const sc = e.currentTarget;
    if (extending) return;
    if (sc.scrollTop < 300) {
        extending = true;
        const before = sc.scrollHeight;
        ui.tl.from = M.addDays(ui.tl.from, -7 * 4);
        S.ensureRange(ui.tl.from, M.addDays(ui.tl.to, 6));
        renderInto(sc, timelineHTML());
        sc.scrollTop += sc.scrollHeight - before;
        requestAnimationFrame(() => { extending = false; });
    } else if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 300) {
        extending = true;
        ui.tl.to = M.addDays(ui.tl.to, 7 * 4);
        S.ensureRange(ui.tl.from, M.addDays(ui.tl.to, 6));
        renderInto(sc, timelineHTML());
        requestAnimationFrame(() => { extending = false; });
    }
}

// ---------------------------------------------------------------------------
// Copy a week
// ---------------------------------------------------------------------------

function openCopyWeek() {
    const dest = M.mondayOf(state.selected);
    const last = M.addDays(dest, -7);
    const count = m => S.allSessions().filter(s => s.date >= m && s.date <= M.addDays(m, 6)).length;
    let source = last;
    openOverlay({
        kind: layout() === 'phone' ? 'sheet' : 'modal',
        label: 'Copy a week',
        render: panel => {
            const draw = () => {
                const n = count(source);
                panel.innerHTML = `<form class="dialog" data-copy-form>
                    <header class="sheet-head"><h2>Copy a week</h2>
                        <button type="button" class="icon-btn" data-action="close-overlay" aria-label="Close">${icon('x')}</button></header>
                    <div class="dialog-body">
                        <p>Into <b>week ${M.isoWeek(dest)}</b> (${esc(M.fmtWeekRange(dest))}).</p>
                        <label class="field"><span>From the week of</span>
                            <input type="date" data-copy-date value="${source}"></label>
                        <div class="chips"><button type="button" class="chip" data-copy-last>Last week (${esc(M.fmtWeekRange(last))})</button></div>
                        <p class="muted" data-copy-preview>${source === dest ? 'That is the same week. Pick another one.' : `${n} session${n === 1 ? '' : 's'} in week ${M.isoWeek(source)} (${esc(M.fmtWeekRange(source))}).`}</p>
                        <label class="check-row"><input type="checkbox" data-copy-skip checked> Skip days that already have sessions</label>
                    </div>
                    <footer class="dialog-foot">
                        <button type="button" class="btn ghost" data-action="close-overlay">Cancel</button>
                        <button type="submit" class="btn primary"${source === dest || !n ? ' disabled' : ''}>Copy</button>
                    </footer>
                </form>`;
            };
            draw();
            panel.addEventListener('change', e => {
                if (e.target.matches('[data-copy-date]') && e.target.value) {
                    source = M.mondayOf(e.target.value);
                    S.ensureRange(source, M.addDays(source, 6)).then(() => { draw(); panel.querySelector('[data-copy-date]').focus(); });
                }
            });
            panel.addEventListener('click', e => {
                if (e.target.closest('[data-copy-last]')) { source = last; draw(); }
            });
            panel.addEventListener('submit', async e => {
                e.preventDefault();
                const skip = panel.querySelector('[data-copy-skip]').checked;
                requestClose(undefined, { force: true });
                await S.copyWeek(source, dest, { skipPlannedDays: skip });
            });
        }
    });
}

// ---------------------------------------------------------------------------
// FIT files: picker, drag and drop
// ---------------------------------------------------------------------------

let fileInput = null;
function pickFiles() {
    if (!fileInput) {
        fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.multiple = true; // no accept filter: iOS greys out .fit files when one is set
        fileInput.hidden = true;
        fileInput.addEventListener('change', () => {
            if (fileInput.files && fileInput.files.length) startImport(fileInput.files);
            fileInput.value = '';
        });
        document.body.appendChild(fileInput);
    }
    fileInput.click();
}

function startImport(files) {
    openImport(files, {
        layout: layout(),
        onDone: dates => {
            if (!dates.length) return;
            if (state.view === 'today' && dates.includes(state.today)) { render('ui'); return; }
            const last = dates[dates.length - 1];
            if (layout() === 'phone') {
                if (state.view !== 'plan') S.setView('plan');
                S.select(last);
                openDaySheet(last);
            } else {
                goToDate(last);
            }
        }
    });
}

function bindDrop() {
    const hint = document.createElement('div');
    hint.id = 'drop-hint';
    hint.setAttribute('aria-hidden', 'true');
    hint.innerHTML = `<div>${icon('upload', 28)}<p>Drop .fit or .zip files to add them</p></div>`;
    document.body.appendChild(hint);
    const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    let depth = 0;
    const off = () => { depth = 0; document.body.classList.remove('dropping'); };
    document.addEventListener('dragenter', e => { if (hasFiles(e) && !topOverlay()) { depth++; document.body.classList.add('dropping'); } });
    document.addEventListener('dragleave', e => { if (hasFiles(e)) { depth = Math.max(0, depth - 1); if (!depth) off(); } });
    document.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = topOverlay() ? 'none' : 'copy'; } });
    document.addEventListener('drop', e => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        off();
        if (!topOverlay() && e.dataTransfer.files.length) startImport(e.dataTransfer.files);
    });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function goToDate(date) {
    S.select(date);
    if (layout() === 'desktop') {
        ensureTimelineAround(date);
        const d = M.parseISODate(date);
        ui.cal = { y: d.getFullYear(), m: d.getMonth() };
        render('ui');
    }
}

function onClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;
    const date = el.dataset.date;
    const id = el.dataset.id;
    switch (a) {
        case 'toggle-done': e.preventDefault(); S.toggleDone(id); break;
        case 'open-day':
            if (el.dataset.tab) state.dayTab[date] = el.dataset.tab;
            S.select(date);
            openDaySheet(date);
            break;
        case 'select-day': goToDate(date); break;
        case 'week-prev': S.select(M.addDays(state.selected, -7)); break;
        case 'week-next': S.select(M.addDays(state.selected, 7)); break;
        case 'go-today': ui.scrollToSelected = true; goToDate(state.today); if (layout() === 'phone') window.scrollTo({ top: 0 }); break;
        case 'day-tab':
            state.dayTab[date] = el.dataset.tab;
            render('ui');
            { const panel = el.closest('.day-panel') || document; const t = panel.querySelector(`[data-action="day-tab"][data-tab="${el.dataset.tab}"]`); if (t) t.focus(); }
            break;
        case 'add-template': {
            const tpl = findTemplate({ tpl: el.dataset.tpl, userTpl: el.dataset.userTpl });
            if (tpl) S.createSession(sessionFromTemplate(tpl, date));
            break;
        }
        case 'new-session': openEditor({ date: date || state.selected, layout: layout() }); break;
        case 'edit-session': openEditor({ id, layout: layout() }); break;
        case 'duplicate-session': S.duplicateSession(id); break;
        case 'delete-session': S.deleteSession(id); break;
        case 'set-rpe': {
            const s = state.sessions.get(id);
            const n = Number(el.dataset.rpe);
            const next = s && Number(s.rpe) === n ? null : n;
            S.patchSessionLog(id, { rpe: next });
            $all(`[data-action="set-rpe"][data-id="${CSS.escape(id)}"]`).forEach(b => {
                const on = Number(b.dataset.rpe) === next;
                b.classList.toggle('on', on);
                b.setAttribute('aria-pressed', String(on));
            });
            break;
        }
        case 'set-legs': {
            const d = S.diaryOn(date);
            const next = d && d.legs === el.dataset.value ? null : el.dataset.value;
            S.patchDiary(date, { legs: next });
            $all(`[data-action="set-legs"][data-date="${date}"]`).forEach(b => {
                const on = b.dataset.value === next;
                b.classList.toggle('on', on);
                b.setAttribute('aria-pressed', String(on));
            });
            break;
        }
        case 'set-pain':
            S.patchDiary(date, { pain: el.dataset.value === '' ? null : Number(el.dataset.value) });
            render('ui');
            { const b = document.querySelector(`[data-action="set-pain"][data-date="${date}"]`); if (b) b.focus(); }
            break;
        case 'close-overlay': requestClose(); break;
        case 'copy-week': openCopyWeek(); break;
        case 'nav':
            S.setView(el.dataset.view);
            window.scrollTo({ top: 0 });
            break;
        case 'cal-prev': case 'cal-next': {
            const d = new Date(ui.cal.y, ui.cal.m + (a === 'cal-next' ? 1 : -1), 1);
            ui.cal = { y: d.getFullYear(), m: d.getMonth() };
            S.ensureRange(M.toISODate(new Date(ui.cal.y, ui.cal.m, 1, 12)), M.toISODate(new Date(ui.cal.y, ui.cal.m + 1, 0, 12)));
            render('ui');
            break;
        }
        case 'toggle-density': S.setDensity(state.density === 'compact' ? 'detailed' : 'compact'); break;
        case 'set-density': S.setDensity(el.dataset.value); break;
        case 'set-theme': S.setTheme(el.dataset.value); break;
        case 'delete-template': S.deleteTemplate(id); break;
        case 'import-files': pickFiles(); break;
        case 'remove-activity': S.removeActivity(id); break;
        case 'sign-out': S.signOut(); break;
    }
}

function setInvalid(el, bad) {
    el.toggleAttribute('aria-invalid', bad);
    const f = el.closest('.field');
    if (f) f.classList.toggle('invalid', bad);
}

function onInput(e) {
    const el = e.target;
    if (el.dataset.log && el.dataset.log !== 'done') {
        const id = el.dataset.id;
        const v = el.value;
        if (el.dataset.log === 'duration') {
            const s = M.parseDuration(v, 'min');
            setInvalid(el, Number.isNaN(s));
            if (!Number.isNaN(s)) S.patchSessionLog(id, { actual: { duration_s: s } });
        } else if (el.dataset.log === 'km') {
            const km = M.parseDistance(v);
            setInvalid(el, Number.isNaN(km));
            if (!Number.isNaN(km)) S.patchSessionLog(id, { actual: { km } });
        } else if (el.dataset.log === 'hr') {
            const n = M.parseNumber(v);
            const bad = Number.isNaN(n) || (n !== null && (n < 40 || n > 240));
            setInvalid(el, bad);
            if (!bad) S.patchSessionLog(id, { actual: { hr: n === null ? null : Math.round(n) } });
        } else if (el.dataset.log === 'notes') {
            S.patchSessionLog(id, { notes: v });
        }
        return;
    }
    if (el.dataset.diary) {
        const date = el.dataset.date;
        const f = el.dataset.diary;
        const v = el.value;
        if (f === 'sleep_h') {
            const n = M.parseNumber(v);
            const bad = Number.isNaN(n) || (n !== null && (n < 0 || n > 24));
            setInvalid(el, bad);
            if (!bad) S.patchDiary(date, { sleep_h: n });
        } else if (f === 'rest_hr') {
            const n = M.parseNumber(v);
            const bad = Number.isNaN(n) || (n !== null && (n < 20 || n > 150));
            setInvalid(el, bad);
            if (!bad) S.patchDiary(date, { rest_hr: n === null ? null : Math.round(n) });
        } else if (f === 'pain') {
            const n = Number(v);
            S.patchDiary(date, { pain: n });
            $all(`[data-pain-out="${date}"]`).forEach(o => { o.textContent = `${n}/10`; });
            el.setAttribute('aria-valuetext', `${n} out of 10`);
        } else if (f === 'notes') {
            S.patchDiary(date, { notes: v });
        }
    }
}

function onChange(e) {
    const el = e.target;
    if (el.dataset.log === 'done') {
        S.patchSessionLog(el.dataset.id, { done: el.checked });
    } else if (el.dataset.log === 'orienteering') {
        S.setOrienteering(el.dataset.id, el.checked);
    }
}

function onKey(e) {
    if (topOverlay() || layout() !== 'desktop' || state.view !== 'plan') return;
    if (e.target.closest('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, PageUp: -7, PageDown: 7 }[e.key];
    if (step) { e.preventDefault(); goToDate(M.addDays(state.selected, step)); return; }
    if (e.key === 't') { ui.scrollToSelected = true; goToDate(state.today); }
    if (e.key === 'n') openEditor({ date: state.selected, layout: 'desktop' });
}

// Swipe left/right on the phone week view changes the week.
function bindSwipe() {
    const el = $('#view-plan');
    let x0 = null, y0 = null;
    el.addEventListener('touchstart', e => {
        if (layout() !== 'phone' || topOverlay() || e.target.closest('.chips, input, textarea')) { x0 = null; return; }
        x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    }, { passive: true });
    el.addEventListener('touchend', e => {
        if (x0 === null) return;
        const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
        x0 = null;
        if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) S.select(M.addDays(state.selected, dx < 0 ? 7 : -7));
    }, { passive: true });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start() {
    const session = await getAuthSession();
    if (!session) { window.location.replace('login.html'); return; }
    state.email = session.user.email;
    S.setHooks({ toast, status: setStatus });
    initToast();
    S.onChange(render);
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
    document.addEventListener('keydown', onKey);
    bindSwipe();
    bindDrop();
    desktopMQ.addEventListener('change', () => { ui.tl = null; render('ui'); });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') S.flushPending();
        else S.refreshToday();
    });
    window.addEventListener('beforeunload', e => {
        if (S.hasPending()) { S.flushPending(); e.preventDefault(); e.returnValue = ''; }
    });
    render('ui');
    await S.init();
}

start().catch(err => {
    console.error(err);
    const el = document.getElementById('view-plan');
    if (el) el.innerHTML = `<p class="loading">Something went wrong while starting: ${esc(err.message || err)}</p>`;
});
