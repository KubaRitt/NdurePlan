// The prompt you paste into Claude (or another AI) together with photos / scans of your diary.
// It returns the JSON file that Ndure's "Import diary" accepts.
window.NDURE_PROMPT = `You convert a training diary into JSON for import into Ndure. I've attached my
diary (photos, scans or text). It can be in any language or layout. It may be the
Ndure template (marker "ndure-day/1" or "ndure-week/1"): then read the DATE /
WEEK OF line, the circled FEEL number, the ticked TAGS, the DAY box and the
TRAINING box.

For every date:
1. Date → YYYY-MM-DD. On the week template, take the year and month from WEEK OF.
   If the year is missing anywhere, infer it and set "date_inferred": true.
2. Day note: everything about the day as a whole. Original wording and language.
3. Sessions: split the training text wherever a new workout starts. For each one,
   extract only what is written:
   - sport_raw: my own word, exactly as written
   - sport_guess: best guess for matching to Garmin, one short lowercase word
     (run, bike, swim, xc_ski, strength, walk, …), or null if unclear
   - start (HH:MM), duration_min, distance_km, rpe (1–10), pain (0–10),
     pain_where, structure (e.g. "6×1 km @ 3:30, r 2 min") — null if not written
   - note: everything else about that session, original wording
4. feel: 1–5 if circled or stated (map other scales proportionally, keep the
   original in feel_raw). tags: only from [sick, sore, injury, travel, race, rest,
   altitude, heat].

Rules:
- Never invent or estimate numbers. Missing means null.
- Never drop text. Anything you can't place goes in that day's "unparsed".
- Keep sessions in the order they were written.
- Skip days that are completely empty.
- If you can't read a word, write [?] in its place rather than guessing.

Output: give me the result as a downloadable file named diary.json. If you can't
make files, reply with one JSON code block and nothing else. Use exactly this shape:

{ "version": 1, "days": [ { "date": "", "date_inferred": false,
  "feel": null, "feel_raw": null, "tags": [], "note": "",
  "sessions": [ { "sport_raw": "", "sport_guess": null, "start": null,
    "duration_min": null, "distance_km": null, "rpe": null, "pain": null,
    "pain_where": null, "structure": null, "note": "" } ],
  "unparsed": "" } ] }`;
