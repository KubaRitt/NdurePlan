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
  // Both loads are "points per minute", shaped like a lactate curve: almost flat through Easy,
  // 1.0 at the Easy limit (≈ LT1), 3.0 at the AP2 limit (≈ LT2, "4 mmol"), then exponential.
  //   w(x) = 0.8 + 0.2 · e^(ln 11 · (x − easy) / (lt2 − easy))
  // HR load uses heart rate for x; body load (running) uses grade-adjusted pace, with pace anchors
  // fitted from the last 30 days, plus downhill metres. One hour of easy running ≈ 55–60 points.
  const LOAD_VERSION = 1;
  const LN11 = Math.log(11);
  const W_CAP = 10;               // max points per minute (sprints can't explode the score)
  const HR_FLOOR = 100;           // below this heart rate nothing counts …
  const HR_RAMP = 30;             // … and it ramps in over the next 30 bpm
  const DESCENT_PTS = 0.1;        // body load per metre of descent (1 point per 10 m)
  const IMPACT = { bike: 0.4, ski: 0.7, swim: 0.3, other: 0.5 }; // body load = HR load × factor
  const FIXED = [                 // sports where heart rate doesn't represent the work
    [/yoga|pilates|breath|mobility|stretch|meditat/, 0.1, "recovery session"],
    [/strength|hiit|crossfit|cardio|boulder|climb|functional|weight/, 0.5, "1 h ≈ 30 min easy running"],
  ];

  // your own paces (Settings) win over the fitted ones
  const paceAnchors = (settings) => {
    const r = settings && settings.run;
    if (!r) return null;
    if (r.pace_manual && isNum(r.pace_manual.v_easy) && isNum(r.pace_manual.v_lt2)) return r.pace_manual;
    return r.pace && isNum(r.pace.v_easy) ? r.pace : null;
  };
  // identifies everything a load result depends on; when it changes, the load is recalculated
  function calcKey(settings, family) {
    const key = zoneKey(family), z = (settings && settings[key]) || {};
    const parts = [LOAD_VERSION, z.easy, z.ap1, z.ap2, z.ap3, z.nm_max_s, z.nm_min_speed];
    if (family === "run" || family === "walk") { const p = paceAnchors(settings); parts.push(p && p.v_easy, p && p.v_lt2); }
    return parts.map((x) => (x == null ? "" : x)).join("|");
  }
  const curve = (x, easy, lt2) => Math.min(W_CAP, 0.8 + 0.2 * Math.exp((LN11 * (x - easy)) / (lt2 - easy)));
  function hrWeight(hr, z) {
    if (!isNum(hr) || !z || !isNum(z.easy) || !isNum(z.ap2) || z.ap2 <= z.easy) return null;
    const ramp = Math.min(1, Math.max(0, (hr - HR_FLOOR) / HR_RAMP));
    return ramp * curve(hr, z.easy, z.ap2);
  }
  function paceWeight(v, pz) {
    if (!isNum(v) || !pz || !isNum(pz.v_easy) || !isNum(pz.v_lt2) || pz.v_lt2 <= pz.v_easy) return null;
    if (v <= 0.3) return 0;
    if (v < pz.v_easy) return (v / pz.v_easy) ** 2; // walking ≈ 0.2, slow jog ≈ 0.7
    return curve(v, pz.v_easy, pz.v_lt2);
  }

  // Load for one activity. `res` is the result of analyse(); sportKey is Garmin's activity type.
  function load(res, family, sportKey, settings) {
    const s = res.s, key = zoneKey(family), z = (settings && settings[key]) || null;
    const dur = s.dt.reduce((a, b) => a + b, 0);
    const fixed = FIXED.find(([re]) => re.test(String(sportKey || "").toLowerCase()));
    if (fixed || family === "strength") {
      const per = fixed ? fixed[1] : 0.5;
      const pts = (per * dur) / 60;
      return { hr: Math.round(pts), body: Math.round(pts), basis: "fixed", note: fixed ? fixed[2] : "1 h ≈ 30 min easy running", version: LOAD_VERSION };
    }
    // HR load
    let hrPts = null;
    if (s.hr && z && isNum(z.easy) && isNum(z.ap2)) {
      hrPts = 0;
      for (let i = 0; i < s.n; i++) { const w = hrWeight(s.hr[i], z); if (w) hrPts += (w * s.dt[i]) / 60; }
    }
    // Body load
    let body = null, descent = 0, nmPts = 0, basis = "impact";
    const pz = paceAnchors(settings);
    const runLike = family === "run" || family === "walk";
    if (runLike && pz && (s.gap || s.v)) {
      const sig = smooth(s.gap && s.gap.some(isNum) ? s.gap : s.v, s.t, 5);
      body = 0; basis = "pace";
      const nmIdx = new Set();
      res.laps.filter((l) => l.zone === "nm").forEach((l) => { for (let i = l.i0; i < l.i1; i++) nmIdx.add(i); });
      for (let i = 0; i < s.n; i++) {
        const w = paceWeight(sig[i], pz);
        if (w) { const p = (w * s.dt[i]) / 60; body += p; if (nmIdx.has(i)) nmPts += p; }
      }
      if (s.e) {
        const e = smooth(s.e, s.t, 15);
        for (let i = 1; i < s.n; i++) if (isNum(e[i]) && isNum(e[i - 1]) && e[i] < e[i - 1]) descent += e[i - 1] - e[i];
        body += descent * DESCENT_PTS;
      }
    } else if (hrPts != null) {
      body = hrPts * (IMPACT[family] ?? (runLike ? 1 : IMPACT.other));
    }
    return {
      hr: hrPts == null ? null : Math.round(hrPts), body: body == null ? null : Math.round(body),
      basis, descent: Math.round(descent), descentPts: Math.round(descent * DESCENT_PTS), nmPts: Math.round(nmPts),
      version: LOAD_VERSION,
    };
  }

  // Pace anchors from recent runs: cut each run into 3-minute blocks (after the first 5 min), keep the
  // steady ones, regress heart rate (shifted 30 s for lag) on grade-adjusted speed, and read off the
  // speed at the Easy and AP2 limits.
  function fitPace(seriesList, z) {
    if (!z || !isNum(z.easy) || !isNum(z.ap2)) return null;
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, runs = 0;
    for (const raw of seriesList) {
      if (!raw || !raw.t || !raw.hr || !(raw.gap || raw.v)) continue;
      const s = prep(raw);
      const vs = raw.gap && raw.gap.some(isNum) ? s.gap : s.v;
      let used = false;
      for (let b0 = 300; b0 + 180 <= s.t[s.n - 1]; b0 += 180) {
        let vSum = 0, vSq = 0, vW = 0, hSum = 0, hW = 0;
        for (let i = 0; i < s.n; i++) {
          const t = s.t[i];
          if (t >= b0 && t < b0 + 180 && isNum(vs[i])) { vSum += vs[i] * s.dt[i]; vSq += vs[i] * vs[i] * s.dt[i]; vW += s.dt[i]; }
          if (t >= b0 + 30 && t < b0 + 210 && isNum(s.hr[i])) { hSum += s.hr[i] * s.dt[i]; hW += s.dt[i]; }
        }
        if (vW < 150 || hW < 150) continue;
        const x = vSum / vW, y = hSum / hW, sd = Math.sqrt(Math.max(0, vSq / vW - x * x));
        if (x < 2.2 || x > 6 || y < 110 || sd / x > 0.12) continue; // steady running only
        n++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; used = true;
      }
      if (used) runs++;
    }
    if (n < 12 || runs < 3) return null;
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a = (sy - b * sx) / n;
    const r2 = ((n * sxy - sx * sy) ** 2) / ((n * sxx - sx * sx) * (n * syy - sy * sy));
    if (!(b > 3)) return null; // heart rate must clearly rise with speed
    const v_easy = (z.easy - a) / b, v_lt2 = (z.ap2 - a) / b;
    if (!(v_easy > 1.5 && v_lt2 > v_easy && v_lt2 < 7)) return null;
    return { v_easy: Math.round(v_easy * 1000) / 1000, v_lt2: Math.round(v_lt2 * 1000) / 1000, r2: Math.round(r2 * 100) / 100, n, runs, fitted_at: new Date().toISOString().slice(0, 10), auto: true };
  }

  const api = { analyse, load, fitPace, hrWeight, paceWeight, paceAnchors, calcKey, LOAD_VERSION, hrZone, zoneKey, ZONES, LABEL, SHORT, ORDER, ZONE_SPORTS, DEFAULT_NM, smooth, median };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NdureLaps = api;
})(typeof window !== "undefined" ? window : globalThis);
