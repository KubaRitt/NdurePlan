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
    const s = { t, hr: pick(series.hr), v: pick(series.v), d: pick(series.d), p: pick(series.p) };
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

  // ---- laps ---------------------------------------------------------------
  function analyse(series, family, settings) {
    if (!series || !series.t || series.t.length < 10) return null;
    const s = prep(series);
    const key = zoneKey(family);
    const z = (settings && settings[key]) || null;
    const nm = { ...DEFAULT_NM, ...(z || {}) };
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

    // time in zone: heart rate per second, except neuromuscular reps count as NM
    const tiz = Object.fromEntries(ORDER.map((k) => [k, 0]));
    for (const l of laps) for (let i = l.i0; i < l.i1; i++) {
      const zone = l.zone === "nm" ? "nm" : hrZone(s.hr ? s.hr[i] : null, z);
      tiz[zone] += s.dt[i];
    }
    const counts = { reps: laps.filter((l) => l.zone === "nm").length };
    return { laps, tiz, hasSpeed, hasPower, hasZones: !!(z && isNum(z.easy)), typical, s, counts, zoneKey: key };
  }

  const api = { analyse, hrZone, zoneKey, ZONES, LABEL, SHORT, ORDER, ZONE_SPORTS, DEFAULT_NM, smooth, median };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NdureLaps = api;
})(typeof window !== "undefined" ? window : globalThis);
