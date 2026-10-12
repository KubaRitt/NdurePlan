// Week strip, week summary, day cards (phone), week timeline (desktop), month calendar.

import * as M from '../model.js';
import { state, sessionsOn, diaryOn, weekStats, weekFlags, planOf } from '../state.js';
import { SPORT_LABEL } from '../../sports.js';
import { esc, icon } from './util.js';
import { zoneBar, zoneLegend } from './graph.js';

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function doneButton(s, { size = 'md' } = {}) {
    const label = s.done ? `Mark “${M.sessionTitle(s)}” as not done` : `Mark “${M.sessionTitle(s)}” as done`;
    return `<button type="button" class="done-btn ${size}${s.done ? ' on' : ''}" data-action="toggle-done" data-id="${esc(s.id)}" aria-pressed="${s.done ? 'true' : 'false'}" aria-label="${esc(label)}">${s.done ? icon('check', 18) : ''}</button>`;
}

export function sessionMeta(s, { withTime = true } = {}) {
    const p = planOf(s);
    const bits = [];
    bits.push(esc(s.discipline || SPORT_LABEL[s.sport_type] || ''));
    if (withTime && s.time) bits.push(esc(M.fmtTime(s.time)));
    if (p.duration_s) bits.push(esc(M.fmtDur(p.duration_s)));
    if (p.distance_km) bits.push(`${esc(M.fmtKm(p.distance_km, 1))} km`);
    return bits.filter(Boolean).join(' · ');
}

function diaryLine(date) {
    const d = diaryOn(date);
    const bits = [];
    if (d) {
        if (d.sleep_h !== null && d.sleep_h !== undefined && d.sleep_h !== '') bits.push(`Sleep ${esc(M.fmtKm(Number(d.sleep_h), 1))} h`);
        if (d.rest_hr) bits.push(`Rest HR ${esc(d.rest_hr)}`);
        if (d.legs) bits.push(`Legs ${esc(d.legs)}`);
        if (d.pain !== null && d.pain !== undefined && d.pain !== '') {
            const p = Number(d.pain);
            bits.push(p >= 3 ? `<span class="warn">Knee/ITB ${p}/10</span>` : `Knee/ITB ${p}/10`);
        }
        if (d.notes) bits.push(`“${esc(d.notes.length > 70 ? d.notes.slice(0, 70) + '…' : d.notes)}”`);
    }
    return bits.length ? `<p class="diary-line">${bits.join(' · ')}</p>` : '';
}

// ---------------------------------------------------------------------------
// Week summary (phone top, desktop left column)
// ---------------------------------------------------------------------------

export function weekSummary(monday) {
    const st = weekStats(monday);
    const flags = weekFlags(monday);
    const hasPlan = st.count > 0;
    const ratio = (a, b, f) => b > 0 ? `<b>${f(a)}</b> <span class="of">of ${f(b)}</span>` : `<b>${f(a)}</b>`;
    const km = v => `${M.fmtKm(v, 1)} km`;
    const easy = st.easyShare === null ? '' : `${Math.round(st.easyShare * 100)}% of endurance time easy`;
    const hard = st.hardCount ? `${st.hardCount} hard session${st.hardCount === 1 ? '' : 's'}` : '';
    return `<section class="summary" aria-label="Week ${M.isoWeek(monday)} summary">
        <div class="summary-head">
            <h2>This week</h2>
            <span class="muted">Week ${M.isoWeek(monday)} · ${esc(M.fmtWeekRange(monday))}</span>
        </div>
        ${hasPlan ? `
        <dl class="stats">
            <div><dt>Time</dt><dd>${ratio(st.done.duration_s, st.planned.duration_s, M.fmtHours)}</dd></div>
            <div><dt>Running</dt><dd>${ratio(st.done.km, st.planned.km, km)}</dd></div>
            <div><dt>Heart load</dt><dd>${ratio(st.done.heart, st.planned.heart, v => String(Math.round(v)))}</dd></div>
            <div><dt>Legs load</dt><dd>${ratio(st.done.legs, st.planned.legs, v => String(Math.round(v)))}</dd></div>
        </dl>
        ${zoneBar(st.zones)}
        <p class="legend">${zoneLegend(st.zones)}</p>
        ${easy || hard ? `<p class="muted small">${[easy, hard].filter(Boolean).join(' · ')}</p>` : ''}
        ${st.orienteering.count ? `<p class="o-share"><b>Orienteering</b> ${esc(M.fmtHours(st.orienteering.done_s))} <span class="of">of ${esc(M.fmtHours(st.orienteering.planned_s))}</span>${st.orienteering.km ? ` · ${esc(M.fmtKm(st.orienteering.km, 1))} km` : ''}${st.orienteering.legs ? ` · legs ${Math.round(st.orienteering.legs)}` : ''}${st.done.duration_s && st.orienteering.done_s ? ` <span class="of">· ${Math.round(st.orienteering.done_s / st.done.duration_s * 100)}% of your time</span>` : ''}</p>` : ''}
        ` : `<p class="muted">Nothing planned yet. Pick a day to add a session, or copy a week.</p>`}
        ${flags.map(f => `<p class="note note-${f.kind}">${esc(f.text)}</p>`).join('')}
    </section>`;
}

// ---------------------------------------------------------------------------
// Phone: week bar, strip and day cards
// ---------------------------------------------------------------------------

export function weekBar(monday) {
    return `<div class="weekbar">
        <button type="button" class="icon-btn" data-action="week-prev" aria-label="Previous week">${icon('left')}</button>
        <h1 class="weekbar-title"><span>${esc(M.fmtWeekRange(monday))}</span> <span class="muted">Week ${M.isoWeek(monday)}</span></h1>
        <button type="button" class="btn small" data-action="go-today">Today</button>
        <button type="button" class="icon-btn" data-action="week-next" aria-label="Next week">${icon('right')}</button>
    </div>`;
}

export function weekStrip(monday) {
    const st = weekStats(monday);
    return `<nav class="strip" aria-label="Days">${M.weekDates(monday).map(date => {
        const d = st.perDay[date];
        const isToday = date === state.today;
        const pain = diaryOn(date) && Number(diaryOn(date).pain) >= 3;
        const pct = d.planned_s ? Math.min(100, Math.round(d.done_s / d.planned_s * 100)) : 0;
        const label = `${M.dayLong(date)} ${M.dayNum(date)}${d.planned_s ? `, ${M.fmtDur(d.planned_s)} planned` : ', rest'}${d.done ? `, ${d.done} of ${d.sessions} done` : ''}${pain ? ', pain logged' : ''}`;
        return `<button type="button" class="strip-day${isToday ? ' today' : ''}${date === state.selected ? ' selected' : ''}" data-action="open-day" data-date="${date}" aria-label="${esc(label)}">
            <span class="sd-name">${M.dayShort(date).slice(0, 2)}</span>
            <span class="sd-num${pain ? ' warn' : ''}">${M.dayNum(date)}</span>
            <span class="sd-time">${d.planned_s ? esc(shortDur(d.planned_s)) : '–'}</span>
            <span class="sd-bar" aria-hidden="true"><i style="width:${pct}%"></i></span>
        </button>`;
    }).join('')}</nav>`;
}

function shortDur(sec) {
    const m = Math.round(sec / 60);
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : `${m}′`;
}

export function dayCard(date) {
    const list = sessionsOn(date);
    const isToday = date === state.today;
    const planned = list.reduce((a, s) => a + planOf(s).duration_s, 0);
    return `<article class="day-card${isToday ? ' today' : ''}" data-date="${date}">
        <button type="button" class="day-card-head" data-action="open-day" data-date="${date}" aria-label="Open ${esc(M.fmtDayTitle(date))}">
            <span class="dc-date"><b>${M.dayShort(date)} ${M.dayNum(date)}</b>${isToday ? ' <span class="muted">today</span>' : ''}</span>
            <span class="muted">${list.length ? esc(M.fmtDur(planned)) : 'Rest'}</span>
        </button>
        ${list.map(s => `
            <div class="dc-session">
                <button type="button" class="dc-main" data-action="open-day" data-date="${date}" data-focus="${esc(s.id)}">
                    <span class="dc-title">${esc(M.sessionTitle(s))}</span>
                    <span class="dc-meta">${sessionMeta(s)}</span>
                    ${zoneBar(planOf(s).zones, 'zbar mini')}
                </button>
                ${doneButton(s)}
            </div>`).join('')}
        ${diaryLine(date)}
        ${list.length ? '' : `<button type="button" class="link-btn" data-action="open-day" data-date="${date}" data-tab="plan">${icon('plus', 16)} Plan a session</button>`}
    </article>`;
}

// ---------------------------------------------------------------------------
// Desktop: timeline of weeks
// ---------------------------------------------------------------------------

export function timelineWeek(monday) {
    const st = weekStats(monday);
    const compact = state.density === 'compact';
    const totals = st.count
        ? `${M.fmtHours(st.done.duration_s)} <span class="of">of ${M.fmtHours(st.planned.duration_s)}</span> · ${M.fmtKm(st.done.km, 1)} <span class="of">of ${M.fmtKm(st.planned.km, 1)} km</span> · heart ${Math.round(st.done.heart)} <span class="of">of ${Math.round(st.planned.heart)}</span> · legs ${Math.round(st.done.legs)} <span class="of">of ${Math.round(st.planned.legs)}</span>`
        : '<span class="of">nothing planned</span>';
    return `<section class="tl-week" data-week="${monday}" aria-label="Week ${M.isoWeek(monday)}">
        <header class="tl-week-head">
            <h3>Week ${M.isoWeek(monday)} <span class="muted">${esc(M.fmtWeekRange(monday))}</span></h3>
            <span class="tl-totals">${totals}</span>
        </header>
        ${M.weekDates(monday).map(date => {
            const list = sessionsOn(date);
            const isToday = date === state.today;
            const sel = date === state.selected;
            const weekend = M.weekdayIndex(date) >= 5;
            return `<div class="tl-day${sel ? ' selected' : ''}${isToday ? ' today' : ''}${weekend ? ' weekend' : ''}" data-action="select-day" data-date="${date}">
                <button type="button" class="tl-date" data-action="select-day" data-date="${date}" aria-label="${esc(M.fmtDayTitle(date))}"${sel ? ' aria-current="date"' : ''}><span class="muted">${M.dayShort(date)}</span><b>${M.dayNum(date)}</b>${isToday ? '<span class="tl-today">today</span>' : ''}</button>
                <div class="tl-sessions">
                    ${list.map(s => `<div class="tl-chip${s.done ? ' done' : ''}" data-action="select-day" data-date="${date}" data-focus="${esc(s.id)}" title="${esc(M.sessionTitle(s))}">
                        ${doneButton(s, { size: 'sm' })}
                        <span class="tl-chip-text"><span class="tl-chip-title">${esc(M.sessionTitle(s))}</span>${compact ? '' : `<span class="tl-chip-meta">${sessionMeta(s, { withTime: false })}</span>`}</span>
                    </div>`).join('')}
                    <button type="button" class="add-btn" data-action="new-session" data-date="${date}" aria-label="Add a session on ${esc(M.fmtDayTitle(date))}">${icon('plus', 16)}</button>
                </div>
            </div>`;
        }).join('')}
    </section>`;
}

// ---------------------------------------------------------------------------
// Desktop: month calendar
// ---------------------------------------------------------------------------

export function calendar(year, month) {
    const cells = M.monthGrid(year, month);
    const selWeek = new Set(M.weekDates(M.mondayOf(state.selected)));
    const withSessions = new Set(Array.from(state.sessions.values()).map(s => s.date));
    return `<section class="cal" aria-label="Calendar">
        <div class="cal-head">
            <h2>${M.monthLong(month)} ${year}</h2>
            <div class="cal-nav">
                <button type="button" class="icon-btn sm" data-action="cal-prev" aria-label="Previous month">${icon('left', 18)}</button>
                <button type="button" class="icon-btn sm" data-action="cal-next" aria-label="Next month">${icon('right', 18)}</button>
            </div>
        </div>
        <div class="cal-grid" role="grid">
            ${['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(d => `<span class="cal-dow" aria-hidden="true">${d}</span>`).join('')}
            ${cells.map(date => {
                if (!date) return '<span></span>';
                const cls = ['cal-day'];
                if (withSessions.has(date)) cls.push('has');
                if (date === state.selected) cls.push('selected');
                else if (selWeek.has(date)) cls.push('inweek');
                if (date === state.today) cls.push('today');
                return `<button type="button" class="${cls.join(' ')}" data-action="select-day" data-date="${date}" aria-label="${esc(M.fmtDayTitle(date))}"${date === state.selected ? ' aria-current="date"' : ''}>${M.dayNum(date)}</button>`;
            }).join('')}
        </div>
    </section>`;
}
