/**
 * NdurePlan - Sports Configuration
 *
 * PARENT_SPORTS: the 5 core sports used for HR zone storage (matches the
 * `hr_zones` JSONB shape in the profiles table and the `sport_type` column
 * in sessions). Do not add to this list without also updating the
 * profiles.hr_zones default in the database schema.
 *
 * DISCIPLINES: the specific session types selectable in the builder UI.
 * Each discipline maps to exactly one parent sport, whose HR zones it
 * borrows for target HR defaults. Disciplines are stored in the new
 * `discipline` column on sessions; `sport_type` continues to store only
 * the parent sport.
 */

export const PARENT_SPORTS = ['run', 'bike', 'swim', 'xc ski', 'backcountry ski'];

export const DISCIPLINES = {
    run: ['Road Run', 'Trail Run', 'Track', 'Treadmill'],
    bike: ['Road Bike', 'Gravel Bike', 'Indoor Trainer', 'Mountain Bike'],
    swim: ['Pool Swim', 'Open Water Swim'],
    'xc ski': ['Classic XC Ski', 'Skate XC Ski', 'Roller Ski'],
    'backcountry ski': ['Backcountry Ski', 'Ski Touring']
};

// Flat list of every discipline with its parent, useful for building a
// single <select> while still knowing which HR zones to apply.
export function getAllDisciplineOptions() {
    const options = [];
    PARENT_SPORTS.forEach(parent => {
        DISCIPLINES[parent].forEach(discipline => {
            options.push({ parent, discipline });
        });
    });
    return options;
}

// Given a discipline label, return its parent sport (for HR zone lookup).
// Falls back to 'run' if the discipline isn't recognized.
export function getParentSportForDiscipline(discipline) {
    for (const parent of PARENT_SPORTS) {
        if (DISCIPLINES[parent].includes(discipline)) return parent;
    }
    return 'run';
}
