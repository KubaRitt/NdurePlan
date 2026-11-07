// Ndure · lap engine
// Turns Garmin's second-by-second track into laps, classifies each lap into
// Easy / AP1 / AP2 / AP3 (heart-rate zones from Settings), Neuromuscular (short fast reps)
// or Rest, and counts time in zone. Runs in the browser (window.NdureLaps) and in Node (tests).
(function (root) {
  const ZONES = ["easy", "ap1", "ap2", "ap3"];
  const LABEL = { easy: "Easy", ap1: "AP1", ap2: "AP2", ap3: "AP3", nm: "Neuromuscular", rest: "Rest", none: "No zone" };
  const SHORT = { easy: "Easy", ap1: "AP1", ap2: "AP2", ap3: "AP3", nm: "NM", rest: "Rest", none: "–" };
  const ORDER = ["easy", "ap1", "ap2", "ap3", "nm", "rest", "none"];
  const ZONE_SPORTS = [["run", "Run"], ["bike", "Bike"], ["ski", "Ski"], ["swim", "Swim"], ["other", "Other"]];
  const DEFAULT_NM = { nm_max_s: 30, nm_min_speed: null }; // speed in m/s; null = 30 % faster than the session's typical speed

  // Which zone set a sport family uses
  const zoneKey = (family) => ({ run: "run", walk: "run", bike: "bike", ski: "ski", swim: "swim" }[family] || "other");
  // Lap length for steady stretches (metres), or seconds when there's no distance
  const CHUNK_M = { run: 1000, walk: 1000, ski: 2000, bike: 5000, swim: 500 };
  const CHUNK_S = 300;

  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const median = (a) => { const s = a.filter(isNum).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

  // Centered moving average over a time window (seconds), ignoring gaps
  function smooth(arr, t, win) {
    const n = arr.length, out = new Array(n).fill(null);
    let lo = 0, hi = 0, sum = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      while (hi < n && t[hi] - t[i] <= win / 2) { if (isNum(arr[hi])) { sum += arr[hi]; cnt++; } hi++; }
      while (t[i] - t[lo] > win / 2) { if (isNum(arr[lo])) { sum -= arr[lo]; cnt--; } lo++; }
      out[i] = cnt ? sum / cnt : null;
    }
    return out;
  }

  // Fill timer gaps and build per-sample durations
  function prep(series) {
    const raw = series.t || [];
    const idx = [];
    for (let i = 0; i < raw.length; i++) if (isNum(raw[i])) idx.push(i);
    const pick = (a) => (a ? idx.map((i) => a[i]) : null);
    const t = pick(raw);
    const s = { t, hr: pick(series.hr), v: pick(series.v), d: pick(series.d), p: pick(series.p), gap: pick(series.gap), e: pick(series.e) };
    const n = t.length;
    const step = median(t.slice(1).map((x, i) => x - t[i])) || 1;
    s.dt = t.map((x, i) => (i < n - 1 ? Math.min(Math.max(t[i + 1] - x, 0), 10 * step) : step));
    s.n = n;
    return s;
  }

  function hrZone(hr, z) {
    if (!isNum(hr) || !z || !isNum(z.easy)) return "none";
    if (hr <= z.easy) return "easy";
    if (isNum(z.ap1) && hr <= z.ap1) return "ap1";
    if (isNum(z.ap2) && hr <= z.ap2) return "ap2";
    return "ap3";
  }

  // ---- segmentation -------------------------------------------------------
  function runsOf(flags, s, minDur, maxGap) {
    // contiguous true runs, gaps <= maxGap seconds merged, runs shorter than minDur dropped
    const out = [];
    let start = -1;
    for (let i = 0; i <= s.n; i++) {
      const on = i < s.n && flags[i];
      if (on && start < 0) start = i;
      if (!on && start >= 0) { out.push([start, i]); start = -1; }
    }
    const merged = [];
    for (const r of out) {
      const last = merged[merged.length - 1];
      if (last && s.t[r[0]] - s.t[last[1] - 1] <= maxGap + 1) last[1] = r[1];
      else merged.push([...r]);
    }
    return merged.filter(([a, b]) => s.t[b - 1] - s.t[a] + s.dt[b - 1] >= minDur);
  }

  function segment(s, family) {
    const segs = [];
    const hasSpeed = !!s.v && s.v.filter((x) => isNum(x) && x > 0.3).length > s.n * 0.3;
    const hasPower = !!s.p && s.p.filter((x) => isNum(x) && x > 0).length > s.n * 0.3;
    const runLike = family === "run" || family === "walk";

    // 1) efforts: clearly faster (or harder, on a bike with power) than the session's typical level
    let efforts = [];
    const sig = family === "bike" ? (hasPower ? s.p : null) : (hasSpeed && family !== "swim" ? s.v : null);
    if (sig) {
      const sm = smooth(sig, s.t, 3);
      const typical = median(sig.filter((x) => isNum(x) && x > (family === "bike" ? 20 : 0.5)));
      if (typical) {
        const k = family === "bike" ? 1.5 : 1.3;
        efforts = runsOf(sm.map((x) => isNum(x) && x > typical * k), s, 5, 3)
          // keep only clear efforts: their average must also be well above typical
          .filter(([a, b]) => {
            let sum = 0, w = 0;
            for (let i = a; i < b; i++) if (isNum(sig[i])) { sum += sig[i] * s.dt[i]; w += s.dt[i]; }
            return w && sum / w >= typical * (k + 0.1);
          });
      }
    }

    // 2) the stretches between efforts
    const gaps = [];
    let cur = 0;
    for (const [a, b] of efforts) { if (a > cur) gaps.push([cur, a]); segs.push({ i0: a, i1: b, kind: "effort" }); cur = b; }
    if (cur < s.n) gaps.push([cur, s.n]);

    const v10 = hasSpeed ? smooth(s.v, s.t, 10) : null;
    for (const [a, b] of gaps) {
      if (runLike && v10) {
        // split by movement band: stopped / walking / running, pieces under 30 s fold into a neighbour
        const band = (i) => (!isNum(v10[i]) || v10[i] < 0.6 ? "stop" : v10[i] < 2.0 ? "walk" : "move");
        const parts = [];
        for (let i = a; i < b; i++) {
          const k = band(i), last = parts[parts.length - 1];
          if (last && last.kind === k) last.i1 = i + 1; else parts.push({ i0: i, i1: i + 1, kind: k });
        }
        const dur = (p) => s.t[p.i1 - 1] - s.t[p.i0] + s.dt[p.i1 - 1];
        let changed = true;
        while (changed && parts.length > 1) {
          changed = false;
          let k = -1, best = Infinity;
          parts.forEach((p, j) => { const d = dur(p); if (d < 30 && d < best) { best = d; k = j; } });
          if (k >= 0) {
            const p = parts[k], prev = parts[k - 1], next = parts[k + 1];
            const into = !prev ? next : !next ? prev : dur(prev) >= dur(next) ? prev : next;
            into.i0 = Math.min(into.i0, p.i0); into.i1 = Math.max(into.i1, p.i1);
            parts.splice(k, 1);
            for (let j = parts.length - 1; j > 0; j--) if (parts[j].kind === parts[j - 1].kind) { parts[j - 1].i1 = parts[j].i1; parts.splice(j, 1); }
            changed = true;
          }
        }
        segs.push(...parts);
      } else segs.push({ i0: a, i1: b, kind: "move" });
    }
    segs.sort((x, y) => x.i0 - y.i0);

    // 3) long steady stretches → auto laps (1 km run, 2 km ski, 5 km bike …, else 5 min)
    const out = [];
    const hasDist = !!s.d && s.d.filter(isNum).length > s.n * 0.5;
    const size = hasDist && CHUNK_M[family] ? CHUNK_M[family] : null;
    for (const g of segs) {
      if (g.kind !== "move") { out.push(g); continue; }
      const start = size ? s.d[g.i0] : s.t[g.i0];
      const total = size ? (s.d[g.i1 - 1] ?? start) - start : s.t[g.i1 - 1] - start;
      const unit = size || CHUNK_S;
      if (!isNum(start) || total < unit * 1.5) { out.push(g); continue; }
      let i0 = g.i0, mark = start + unit;
      for (let i = g.i0; i < g.i1; i++) {
        const x = size ? s.d[i] : s.t[i];
        if (isNum(x) && x >= mark && (size ? s.d[g.i1 - 1] : s.t[g.i1 - 1]) - x >= unit * 0.5) {
          out.push({ i0, i1: i, kind: "move" }); i0 = i; mark += unit;
        }
      }
      out.push({ i0, i1: g.i1, kind: "move" });
    }
    return { segs: out.filter((g) => g.i1 > g.i0), hasSpeed, hasPower };
  }

  // ---- watch laps (from the activity's .FIT file) -------------------------
  function fromWatch(s, family, fitLaps, z, nm) {
    const hasSpeed = !!s.v && s.v.filter((x) => isNum(x) && x > 0.3).length > s.n * 0.3;
    const hasPower = !!s.p && s.p.filter((x) => isNum(x) && x > 0).length > s.n * 0.3;
    const idxAt = (t) => { let lo = 0, hi = s.n; while (lo < hi) { const m = (lo + hi) >> 1; if (s.t[m] < t) lo = m + 1; else hi = m; } return lo; };
    const typical = median((s.v || []).filter((x) => isNum(x) && x > 0.5));
    const laps = fitLaps.map((f, k) => {
      const i0 = Math.min(idxAt(f.t0), s.n), i1 = Math.max(i0, Math.min(idxAt(f.t0 + f.dur), s.n));
      // speed sensor over the lap window (GPS distance lags on short reps); fall back to the watch's average
      let vSum = 0, vW = 0;
      if (hasSpeed) for (let i = i0; i < i1; i++) if (isNum(s.v[i])) { vSum += s.v[i] * s.dt[i]; vW += s.dt[i]; }
      return {
        n: k + 1, kind: "watch", intensity: f.intensity, trigger: f.trigger, i0, i1,
        t0: f.t0, t1: f.t0 + f.dur, dur: f.dur, dist: f.dist,
        speed: vW > f.dur * 0.5 ? vSum / vW : f.speed, hr: f.hr, hrMax: f.hrMax, power: f.power,
      };
    });
    laps.forEach((l) => {
      const fast = isNum(nm.nm_min_speed) ? (l.speed ?? 0) >= nm.nm_min_speed : typical ? (l.speed ?? 0) >= typical * 1.3 : false;
      const easyIntensity = l.intensity === "rest" || l.intensity === "recovery";
      if (!easyIntensity && l.dur <= nm.nm_max_s && fast) l.zone = "nm";
      else if (l.intensity === "rest" || (l.intensity === "recovery" && l.dur <= 180) || (hasSpeed && isNum(l.speed) && l.speed < 0.6)) l.zone = "rest";
      else l.zone = hrZone(l.hr, z);
      l.label = LABEL[l.zone];
      l.fast = l.zone === "nm";
    });
    return { laps, hasSpeed, hasPower, typical };
  }

  // ---- laps ---------------------------------------------------------------
  // fitLaps: laps recorded by the watch (preferred). Without them, laps are detected from the track.
  function analyse(series, family, settings, fitLaps) {
    if (!series || !series.t || series.t.length < 10) return null;
    const s = prep(series);
    const key = zoneKey(family);
    const z = (settings && settings[key]) || null;
    const nm = { ...DEFAULT_NM, ...(z || {}) };
    if (Array.isArray(fitLaps) && fitLaps.length) {
      const w = fromWatch(s, family, fitLaps, z, nm);
      return finish(s, w.laps, z, { hasSpeed: w.hasSpeed, hasPower: w.hasPower, typical: w.typical, key, source: "watch" });
    }
    const { segs, hasSpeed, hasPower } = segment(s, family);
    const end = (i1) => (i1 < s.n ? s.t[i1] : s.t[s.n - 1] + s.dt[s.n - 1]);

    const laps = segs.map((g, k) => {
      const t0 = s.t[g.i0], t1 = end(g.i1), dur = t1 - t0;
      let hrSum = 0, hrW = 0, hrMax = null, pSum = 0, pW = 0, vSum = 0, vW = 0;
      for (let i = g.i0; i < g.i1; i++) {
        const w = s.dt[i];
        if (s.hr && isNum(s.hr[i])) { hrSum += s.hr[i] * w; hrW += w; hrMax = Math.max(hrMax ?? 0, s.hr[i]); }
        if (s.p && isNum(s.p[i])) { pSum += s.p[i] * w; pW += w; }
        if (s.v && isNum(s.v[i])) { vSum += s.v[i] * w; vW += w; }
      }
      const d0 = s.d ? s.d[g.i0] : null, d1 = s.d ? s.d[Math.min(g.i1, s.n - 1)] : null;
      const dist = isNum(d0) && isNum(d1) ? Math.max(0, d1 - d0) : null;
      // speed sensor first: GPS distance lags on short reps
      const speed = vW ? vSum / vW : dist != null && dur > 0 ? dist / dur : null;
      return {
        n: k + 1, kind: g.kind, i0: g.i0, i1: g.i1, t0, t1, dur, dist, speed,
        hr: hrW ? Math.round(hrSum / hrW) : null, hrMax, power: pW ? Math.round(pSum / pW) : null,
      };
    });

    // classify
    const typical = median(laps.filter((l) => l.kind === "move").map((l) => l.speed)) || median(laps.map((l) => l.speed));
    laps.forEach((l, k) => {
      const prev = laps[k - 1];
      if (l.kind === "effort" && l.dur <= nm.nm_max_s &&
          (isNum(nm.nm_min_speed) ? (l.speed ?? 0) >= nm.nm_min_speed : true)) l.zone = "nm";
      else if (l.kind === "stop") l.zone = "rest";
      else if (l.kind === "walk" && prev && prev.kind === "effort" && l.dur <= 180) l.zone = "rest";
      else l.zone = hrZone(l.hr, z);
      l.label = LABEL[l.zone];
      l.fast = l.kind === "effort";
    });
    return finish(s, laps, z, { hasSpeed, hasPower, typical, key, source: "auto" });
  }

  // time in zone: heart rate per second, except neuromuscular reps count as NM
  function finish(s, laps, z, o) {
    const tiz = Object.fromEntries(ORDER.map((k) => [k, 0]));
    for (const l of laps) for (let i = l.i0; i < l.i1; i++) {
      const zone = l.zone === "nm" ? "nm" : hrZone(s.hr ? s.hr[i] : null, z);
      tiz[zone] += s.dt[i];
    }
    const counts = { reps: laps.filter((l) => l.zone === "nm").length };
    return { laps, tiz, hasSpeed: o.hasSpeed, hasPower: o.hasPower, hasZones: !!(z && isNum(z.easy)), typical: o.typical, s, counts, zoneKey: o.key, source: o.source };
  }

  // ---- load ---------------------------------------------------------------
  // HR load   = Banister TRIMP, second by second:
  //             minutes × x × 0.64 × e^(1.92·x),  x = (HR − resting HR) / (max HR − resting HR)
  //             resting HR = that day's Garmin value (fallback in Settings), max HR from Settings.
  // Body load = running-equivalent km (bones, tendons, muscles):
  //             km × speed factor (running/walking: your speed ÷ your easy pace, 0.4–2.5) + 1 km per 100 m of descent,
  //             then × sport factor: run/walk 1 · ski 0.4 · bike 0.1 · swim 0.
  // Strength / HIIT: HR load = half of what the same minutes of easy running would give
  //             (1 h ≈ 30 min easy running); body load 0.
  const LOAD_VERSION = 3;
  const DEFAULTS = { max_hr: 198, rest_hr: 48, easy_pace_s: 330 }; // 5:30 /km
  const BODY_SPORT = { run: 1, walk: 1, ski: 0.4, bike: 0.1, swim: 0, strength: 0, other: 0 };
  const FIXED_RE = /strength|hiit|crossfit|cardio|boulder|climb|functional|weight/;

  const loadCfg = (settings) => ({ ...DEFAULTS, ...((settings && settings.load) || {}) });
  function trimpRate(hr, rest, max) { // TRIMP points per minute at a heart rate
    if (!isNum(hr) || hr <= rest) return 0;
    const x = Math.min(1.05, (hr - rest) / (max - rest));
    return x * 0.64 * Math.exp(1.92 * x);
  }

  // Load for one activity. `res` = analyse() result, sportKey = Garmin activity type, rhr = that day's resting HR.
  function load(res, family, sportKey, settings, rhr) {
    const c = loadCfg(settings), s = res.s;
    const rest = isNum(rhr) && rhr > 25 ? rhr : c.rest_hr, max = c.max_hr;
    const dur = s.dt.reduce((a, b) => a + b, 0);
    if (FIXED_RE.test(String(sportKey || "").toLowerCase()) || family === "strength" && !/yoga|pilates|breath|mobility|stretch/.test(String(sportKey || ""))) {
      const easy = settings && settings.run && isNum(settings.run.easy) ? settings.run.easy - 10 : rest + 0.6 * (max - rest);
      const pts = 0.5 * (dur / 60) * trimpRate(easy, rest, max);
      return { hr: Math.round(pts), body: 0, km: 0, basis: "fixed", note: "strength/HIIT: 1 h ≈ 30 min easy running", laps: res.laps.map(() => null), version: LOAD_VERSION };
    }
    // per second
    const hrPer = new Array(s.n).fill(0), bodyPer = new Array(s.n).fill(0);
    let hasHr = false;
    if (s.hr) for (let i = 0; i < s.n; i++) { const r = trimpRate(s.hr[i], rest, max); if (r) { hrPer[i] = (r * s.dt[i]) / 60; hasHr = true; } }
    const sportF = BODY_SPORT[family] ?? 0;
    const vEasy = 1000 / c.easy_pace_s;
    let km = 0, descent = 0;
    if (sportF > 0 && s.v) {
      const v = smooth(s.v, s.t, 5);
      for (let i = 0; i < s.n; i++) {
        if (!isNum(v[i]) || v[i] <= 0.3) continue;
        const dk = (v[i] * s.dt[i]) / 1000;
        km += dk;
        const speedF = family === "run" || family === "walk" ? Math.min(2.5, Math.max(0.4, v[i] / vEasy)) : 1;
        bodyPer[i] = dk * speedF * sportF;
      }
      if (s.e && family !== "bike" && family !== "swim") {
        const e = smooth(s.e, s.t, 15);
        for (let i = 1; i < s.n; i++) if (isNum(e[i]) && isNum(e[i - 1]) && e[i] < e[i - 1]) {
          const dd = e[i - 1] - e[i]; descent += dd; bodyPer[i] += (dd / 100) * sportF;
        }
      }
    }
    const sum = (arr, a = 0, b = s.n) => { let x = 0; for (let i = a; i < b; i++) x += arr[i]; return x; };
    const laps = res.laps.map((l) => ({ hr: Math.round(sum(hrPer, l.i0, l.i1) * 10) / 10, body: Math.round(sum(bodyPer, l.i0, l.i1) * 10) / 10 }));
    return {
      hr: hasHr ? Math.round(sum(hrPer)) : null, body: Math.round(sum(bodyPer) * 10) / 10, km: Math.round(km * 10) / 10,
      descent: Math.round(descent), basis: "trimp", rest, max, laps, version: LOAD_VERSION,
    };
  }
  // identifies everything a load result depends on; when it changes, the load is recalculated
  function calcKey(settings, family) {
    const c = loadCfg(settings), z = (settings && settings[zoneKey(family)]) || {};
    return [LOAD_VERSION, c.max_hr, c.rest_hr, c.easy_pace_s, z.easy, z.ap1, z.ap2, z.ap3, z.nm_max_s, z.nm_min_speed].join("|");
  }

  const api = { analyse, load, trimpRate, calcKey, loadCfg, LOAD_VERSION, DEFAULTS, BODY_SPORT, hrZone, zoneKey, ZONES, LABEL, SHORT, ORDER, ZONE_SPORTS, DEFAULT_NM, smooth, median };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NdureLaps = api;
})(typeof window !== "undefined" ? window : globalThis);
