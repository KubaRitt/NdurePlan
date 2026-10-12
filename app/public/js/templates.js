// Built-in session templates (the agreed weekly structure).
// Durations are in seconds, distances in km per rep. target_hr is filled in
// from the athlete's zones when the template is used.

const min = m => m * 60;

export const BUILT_IN_TEMPLATES = [
    {
        id: 'easy', name: 'Easy + strides', discipline: 'Road Run', sport_type: 'run',
        description: 'Easy + strides',
        blocks: [
            { type: 'Easy', intensity: 'easy', duration_s: min(40), distance_km: 8.5 },
            { type: 'Strides', intensity: 'sprint', duration_s: 20, repeat: { reps: 6, rest_sec: 60, rest_type: 'standing' } }
        ]
    },
    {
        id: 'threshold', name: 'Threshold', discipline: 'Road Run', sport_type: 'run',
        description: 'Threshold 4 × 6 min',
        blocks: [
            { type: 'Warm up', intensity: 'easy', duration_s: min(15), distance_km: 3 },
            { type: 'AP2', intensity: 'ap2', duration_s: min(6), distance_km: 1.55, repeat: { reps: 4, rest_sec: 60, rest_type: 'moving', rest_intensity: 'easy' } },
            { type: 'Cool down', intensity: 'easy', duration_s: min(15), distance_km: 3 }
        ]
    },
    {
        id: 'speed', name: 'Speed', discipline: 'Track', sport_type: 'run',
        description: 'Hill sprints + 200s',
        blocks: [
            { type: 'Warm up + drills', intensity: 'easy', duration_s: min(15), distance_km: 3 },
            { type: 'Hill sprints', intensity: 'sprint', duration_s: 10, repeat: { reps: 8, rest_sec: 90, rest_type: 'standing' } },
            { type: '200 m', intensity: 'ap3', duration_s: 35, distance_km: 0.2, repeat: { reps: 8, rest_sec: 120, rest_type: 'moving', rest_intensity: 'easy' } },
            { type: 'Cool down', intensity: 'easy', duration_s: min(12), distance_km: 2.5 }
        ]
    },
    {
        id: 'long', name: 'Long + AP1', discipline: 'Trail Run', sport_type: 'run',
        description: 'Long run with AP1',
        blocks: [
            { type: 'Easy on trails', intensity: 'easy', duration_s: min(45), distance_km: 9.5 },
            { type: 'AP1', intensity: 'ap1', duration_s: min(10), distance_km: 2.4, repeat: { reps: 2, rest_sec: 180, rest_type: 'moving', rest_intensity: 'easy' } },
            { type: 'Easy home', intensity: 'easy', duration_s: min(10), distance_km: 2 }
        ]
    },
    {
        id: 'map', name: 'Map training', discipline: 'Orienteering', sport_type: 'run',
        description: 'Map training',
        blocks: [
            { type: 'Technique, steady', intensity: 'easy', duration_s: min(45), distance_km: 7 }
        ]
    },
    {
        id: 'bike', name: 'Easy bike', discipline: 'Indoor Trainer', sport_type: 'bike',
        description: 'Easy bike',
        blocks: [
            { type: 'Easy spin', intensity: 'easy', duration_s: min(45) }
        ]
    },
    {
        id: 'strength', name: 'Strength', discipline: 'Strength', sport_type: 'strength',
        description: 'Strength: hips, knees, calves',
        blocks: [
            { type: 'Spanish squats, side planks, band walks, single-leg squats, calf raises', intensity: 'strength', duration_s: min(30), rpe: 6 }
        ]
    },
    {
        id: 'race', name: 'Race', discipline: 'Orienteering', sport_type: 'run',
        description: 'Race',
        blocks: [
            { type: 'Warm up', intensity: 'easy', duration_s: min(20), distance_km: 3.5 },
            { type: 'Race', intensity: 'ap3', duration_s: min(40), distance_km: 7 }
        ]
    }
];
