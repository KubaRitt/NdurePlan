/**
 * NdurePlan - sports and session types
 *
 * PARENT_SPORTS: stored in sessions.sport_type. Must match the
 * sessions_sport_type_check constraint (see supabase/migrations).
 *
 * HR_SPORTS: sports that have heart rate zones (profiles.hr_zones).
 * Strength has none; its load comes from RPE.
 *
 * DISCIPLINES: the session types shown in the editor. Each one belongs to
 * exactly one parent sport and is stored in sessions.discipline.
 */

export const PARENT_SPORTS = ['run', 'bike', 'swim', 'xc ski', 'backcountry ski', 'strength'];

export const HR_SPORTS = ['run', 'bike', 'swim', 'xc ski', 'backcountry ski'];

export const SPORT_LABEL = {
    run: 'Run',
    bike: 'Bike',
    swim: 'Swim',
    'xc ski': 'XC ski',
    'backcountry ski': 'Backcountry ski',
    strength: 'Strength'
};

export const DISCIPLINES = {
    run: ['Road Run', 'Trail Run', 'Orienteering', 'Track', 'Treadmill'],
    bike: ['Road Bike', 'Gravel Bike', 'Indoor Trainer', 'Mountain Bike'],
    swim: ['Pool Swim', 'Open Water Swim'],
    'xc ski': ['Classic XC Ski', 'Skate XC Ski', 'Roller Ski'],
    'backcountry ski': ['Backcountry Ski', 'Ski Touring'],
    strength: ['Strength', 'Core / mobility']
};

export const DEFAULT_HR_ZONES = {
    run: { easy: 158, ap1: 172, ap2: 181, ap3: 195 },
    bike: { easy: 150, ap1: 163, ap2: 172, ap3: 185 },
    swim: { easy: 145, ap1: 158, ap2: 167, ap3: 180 },
    'xc ski': { easy: 155, ap1: 168, ap2: 178, ap3: 190 },
    'backcountry ski': { easy: 150, ap1: 163, ap2: 172, ap3: 185 }
};

// Flat list of every discipline with its parent.
export function getAllDisciplineOptions() {
    const options = [];
    PARENT_SPORTS.forEach(parent => {
        DISCIPLINES[parent].forEach(discipline => options.push({ parent, discipline }));
    });
    return options;
}

// Parent sport for a discipline label; 'run' if unknown.
export function getParentSportForDiscipline(discipline) {
    for (const parent of PARENT_SPORTS) {
        if (DISCIPLINES[parent].includes(discipline)) return parent;
    }
    return 'run';
}

// Running kilometres are counted for weekly volume (orienteering included).
export function isRunSport(sport) {
    return sport === 'run';
}
