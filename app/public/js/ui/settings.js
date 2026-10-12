// Settings: heart rate zones, templates, appearance, account.

import * as M from '../model.js';
import { state, saveZones, deleteTemplate, setTheme, setDensity, signOut } from '../state.js';
import { HR_SPORTS, SPORT_LABEL } from '../../sports.js';
import { esc, icon } from './util.js';

export function settingsView() {
    return `<div class="settings">
        <h1 class="page-title">Settings</h1>

        <section class="card" aria-labelledby="zones-h">
            <h2 id="zones-h">Heart rate zones</h2>
            <p class="muted">Target heart rate for each zone in bpm. New blocks start with these values,
                and both loads are measured against them. Saving recalculates every uploaded file.</p>
            <form class="zones" data-form="zones" novalidate>
                ${HR_SPORTS.map(sp => `<fieldset class="zone-sport">
                    <legend>${esc(SPORT_LABEL[sp])}</legend>
                    <div class="zone-inputs">
                        ${M.HR_ZONE_KEYS.map(z => `<label class="field"><span>${M.ZONE_LABEL[z]}</span>
                            <input type="text" inputmode="numeric" autocomplete="off" name="${esc(sp)}|${z}" value="${esc(state.zones[sp]?.[z] ?? '')}"></label>`).join('')}
                    </div>
                </fieldset>`).join('')}
                <p class="form-error" data-zones-error role="alert" hidden></p>
                <button type="submit" class="btn primary">Save zones</button>
            </form>
        </section>

        <section class="card" aria-labelledby="files-h">
            <h2 id="files-h">Activity files</h2>
            <p class="muted">Add the .fit file of a run, ride or race and the app reads time, distance, laps and heart rate from it.
                Garmin Connect website: open the activity, ⚙ › Export File (a .zip is fine). Strava website: ⋯ › Export Original.
                From the watch over USB: GARMIN/Activity. Pick many files at once to add a whole season.</p>
            <div><button type="button" class="btn" data-action="import-files">${icon('upload', 18)} Add FIT files</button></div>
        </section>

        <section class="card" aria-labelledby="loads-h">
            <h2 id="loads-h">How the loads are counted</h2>
            <dl class="explain">
                <div><dt>Heart</dt><dd>Every 10 seconds of heart rate, rising like a lactate curve: a minute at Easy = 1, at AP2 = 3, at AP3 about 6.</dd></div>
                <div><dt>Legs</dt><dd>Every moving minute counts, harder minutes (from heart rate) a bit more: 1.0 at Easy, 1.3 at AP3.
                    Road 1.0, track 0.95, treadmill and orienteering 0.9, trail 0.85. Downhill running counts extra.
                    Bike 0.25 per minute, XC ski 0.4, swim 0.1.</dd></div>
                <div><dt>Strength</dt><dd>Minutes × RPE: Heart ÷ 60, Legs ÷ 6. 30 minutes at RPE 6 = Heart 3, Legs 30.</dd></div>
                <div><dt>Stops</dt><dd>A paused watch never counts. Standing still up to 5 minutes counts for Heart (rest between reps, a control).
                    Longer stops aren’t counted at all.</dd></div>
                <div><dt>Plan</dt><dd>Planned loads use the target heart rate of each block, so plan and file sit on the same scale.</dd></div>
            </dl>
        </section>

        <section class="card" aria-labelledby="tpl-h">
            <h2 id="tpl-h">My templates</h2>
            ${state.templates.length ? `<ul class="tpl-list">${state.templates.map(t => `<li>
                <span><b>${esc(t.name)}</b><span class="muted small"> · ${esc(t.discipline || SPORT_LABEL[t.sport_type] || '')} · ${esc(M.fmtDur(M.summarizeBlocks(t.blocks).duration_s))}</span></span>
                <button type="button" class="icon-btn" data-action="delete-template" data-id="${esc(t.id)}" aria-label="Delete template ${esc(t.name)}">${icon('trash', 18)}</button>
            </li>`).join('')}</ul>` : '<p class="muted">None yet. In the session editor, use “Save as template”.</p>'}
        </section>

        <section class="card" aria-labelledby="look-h">
            <h2 id="look-h">Display</h2>
            <div class="field"><span class="label" id="theme-l">Theme</span>
                <div class="seg" role="group" aria-labelledby="theme-l">
                    ${[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<button type="button" class="${state.theme === v ? 'on' : ''}" data-action="set-theme" data-value="${v}" aria-pressed="${state.theme === v}">${l}</button>`).join('')}
                </div>
            </div>
            <div class="field"><span class="label" id="dens-l">Week list on a computer</span>
                <div class="seg" role="group" aria-labelledby="dens-l">
                    ${[['detailed', 'Detailed'], ['compact', 'Compact']].map(([v, l]) => `<button type="button" class="${state.density === v ? 'on' : ''}" data-action="set-density" data-value="${v}" aria-pressed="${state.density === v}">${l}</button>`).join('')}
                </div>
            </div>
        </section>

        <section class="card" aria-labelledby="acc-h">
            <h2 id="acc-h">Account</h2>
            <p>${state.email ? esc(state.email) : ''}</p>
            <button type="button" class="btn" data-action="sign-out">${icon('out', 18)} Sign out</button>
        </section>
    </div>`;
}

export function bindSettingsForm(root) {
    const form = root.querySelector('[data-form="zones"]');
    if (!form) return;
    form.addEventListener('submit', async e => {
        e.preventDefault();
        const errEl = form.querySelector('[data-zones-error]');
        const next = JSON.parse(JSON.stringify(state.zones));
        let bad = null;
        form.querySelectorAll('input').forEach(inp => {
            const [sp, z] = inp.name.split('|');
            const n = M.parseNumber(inp.value);
            const ok = n !== null && !Number.isNaN(n) && n >= 60 && n <= 240;
            inp.toggleAttribute('aria-invalid', !ok);
            inp.closest('.field').classList.toggle('invalid', !ok);
            if (!ok && !bad) bad = inp;
            if (ok) { next[sp] = next[sp] || {}; next[sp][z] = Math.round(n); }
        });
        if (bad) {
            errEl.textContent = 'Every zone needs a heart rate between 60 and 240.';
            errEl.hidden = false;
            bad.focus();
            return;
        }
        errEl.hidden = true;
        await saveZones(next);
    });
}

export { setTheme, setDensity, deleteTemplate, signOut };
