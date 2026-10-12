// NdurePlan - the load formulas. Used for planned blocks and for recorded files,
// so plan and reality sit on one scale.
//
// Heart (per minute):  3 ^ ((HR - Easy) / (AP2 - Easy))
//     Easy = 1, AP2 = 3, rising like a lactate curve.
// Legs (per moving minute):  HR effort x surface (running) or x sport factor (other sports)
//     HR effort = 1.0 at Easy and 1.3 at AP3, a straight line between (never below 0.5).
//     Downhill running counts x (1 + 3.4 x grade); uphill shows in the HR.
// Strength (no useful HR):  Heart = minutes x RPE / 60, Legs = minutes x RPE / 6.

export const SURFACE = { road: 1.0, track: 0.95, treadmill: 0.9, orienteering: 0.9, trail: 0.85 };
export const SURFACE_LABEL = { road: 'Road', track: 'Track', treadmill: 'Treadmill', orienteering: 'Orienteering', trail: 'Trail' };

// Legs per minute for sports other than running (before HR effort).
export const SPORT_LEGS = { bike: 0.25, swim: 0.1, 'xc ski': 0.4, 'backcountry ski': 0.4 };
const OTHER_SPORT_LEGS = 0.25;

export const EFFORT_AT_AP3 = 1.3;
export const EFFORT_MIN = 0.5;
export const DOWNHILL_K = 3.4;
export const MAX_GRADE = 0.3;

function okZones(z) {
    return z && z.ap2 > z.easy && z.ap3 > z.easy;
}
const FALLBACK = { easy: 158, ap1: 172, ap2: 181, ap3: 195 };

/** Heart load per minute at this heart rate. */
export function heartPerMin(hr, zones) {
    const z = okZones(zones) ? zones : FALLBACK;
    return Math.pow(3, (hr - z.easy) / (z.ap2 - z.easy));
}

/** Legs effort per minute from heart rate: 1 at Easy, 1.3 at AP3. */
export function effort(hr, zones) {
    const z = okZones(zones) ? zones : FALLBACK;
    return Math.max(EFFORT_MIN, 1 + (EFFORT_AT_AP3 - 1) * (hr - z.easy) / (z.ap3 - z.easy));
}

/** Extra legs load for running downhill; grade is rise/run (-0.1 = 10 % down). */
export function downhillFactor(grade) {
    return grade < 0 ? 1 + DOWNHILL_K * Math.min(-grade, MAX_GRADE) : 1;
}

export function legsFactor(sport, surface) {
    if (sport === 'run') return SURFACE[surface] ?? SURFACE.road;
    return SPORT_LEGS[sport] ?? OTHER_SPORT_LEGS;
}

export function strengthHeart(minutes, rpe) { return minutes * rpe / 60; }
export function strengthLegs(minutes, rpe) { return minutes * rpe / 6; }

export function isOrienteering(session) {
    return !!(session && (session.orienteering || session.discipline === 'Orienteering'));
}

/** Running surface of a session: the Orienteering tick wins, then the session type. */
export function surfaceOf(session) {
    if (!session) return 'road';
    if (isOrienteering(session)) return 'orienteering';
    return { 'Trail Run': 'trail', Track: 'track', Treadmill: 'treadmill' }[session.discipline] || 'road';
}
