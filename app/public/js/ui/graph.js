// Workout shape graph and zone bars.

import * as M from '../model.js';
import { esc, zoneColor, zoneText } from './util.js';

const HEIGHT = { easy: 0.32, ap1: 0.52, ap2: 0.74, ap3: 0.92, sprint: 1 };

/**
 * Bars in time order: width = duration, height = intensity.
 * Standing rest is a low grey bar so it reads as a pause.
 */
export function workoutGraph(blocks, { height = 56 } = {}) {
    const segs = [];
    (blocks || []).forEach(b => segs.push(...M.expandBlock(b)));
    const total = segs.reduce((a, s) => a + (s.duration_s || 0), 0);
    if (total <= 0) return '';
    const W = 400, H = height, pad = 2;
    const usable = W - pad * 2;
    let x = pad;
    let bars = '';
    segs.forEach(s => {
        const raw = (s.duration_s / total) * usable;
        const w = Math.max(raw - 1, 0.8);
        const standing = s.kind === 'rest' && !s.intensity;
        let frac = standing ? 0.12 : s.intensity === 'strength' ? Math.max(0.2, (s.rpe || M.DEFAULT_RPE) / 10) : (HEIGHT[s.intensity] || 0.32);
        const h = Math.max(frac * (H - pad * 2), 3);
        const y = H - pad - h;
        const fill = standing ? 'var(--rest)' : zoneColor(s.intensity);
        bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${fill}"${s.kind === 'rest' ? ' opacity="0.7"' : ''}/>`;
        x += raw;
    });
    return `<svg class="graph" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Workout shape">${bars}</svg>`;
}

/** Horizontal bar with one part per zone. `zones` in seconds. */
export function zoneBar(zones, cls = 'zbar') {
    const total = M.ZONES.reduce((a, z) => a + (zones[z] || 0), 0);
    if (!total) return '';
    return `<div class="${cls}" aria-hidden="true">${M.ZONES.filter(z => zones[z] > 0)
        .map(z => `<i style="width:${(zones[z] / total * 100).toFixed(2)}%;background:${zoneColor(z)}"></i>`).join('')}</div>`;
}

/** "Easy 3:36 h · AP2 18 min · …" with zone-coloured names. */
export function zoneLegend(zones) {
    return M.ZONES.filter(z => zones[z] > 0)
        .map(z => `<span class="zl"><span style="color:${zoneText(z)}">${esc(M.ZONE_LABEL[z])}</span> ${esc(M.fmtDur(zones[z]))}</span>`)
        .join('<span class="sep" aria-hidden="true">·</span>');
}
