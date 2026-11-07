// Ndure · per-activity load results (HR load, body load, time in zone), saved in activity_metrics.
// Computed in the browser from the saved laps + your load settings; recalculated when those change.
(function (root) {
  const L = root.NdureLaps;

  function NdureMetrics(sb) {
    let settingsP = null;
    const settings = () => (settingsP ??= sb.from("user_settings").select("zones").maybeSingle().then((r) => r.data?.zones || {}));

    // One activity → metrics row (needs its garmin_activities row and, except for fixed-rate sports, the saved track)
    // rhr = that day's resting heart rate (Garmin), used by the HR load
    function compute(act, saved, zones, rhr) {
      const fam = act.family || "other";
      let res = saved && saved.series && saved.series.t ? L.analyse(saved.series, fam, zones, saved.laps) : null;
      if (!res) {
        // no track: only strength / HIIT can still be scored, from the duration
        const ld0 = L.load({ s: { dt: [act.duration_s || 0], n: 1 }, laps: [] }, fam, act.sport_key, zones, rhr);
        if (ld0.basis !== "fixed") return null;
        return row(act, ld0, null, zones, rhr);
      }
      return row(act, L.load(res, fam, act.sport_key, zones, rhr), res, zones, rhr);
    }
    const key = (zones, act, rhr) => L.calcKey(zones, act.family || "other") + "|" + (rhr ?? "");
    function row(act, ld, res, zones, rhr) {
      return {
        activity_id: act.activity_id, date: act.date, family: act.family,
        hr_load: ld.hr, body_load: ld.body, basis: ld.basis, descent_m: ld.descent ?? null,
        nm_reps: res ? res.counts.reps : 0, tiz: res ? Object.fromEntries(Object.entries(res.tiz).map(([k, v]) => [k, Math.round(v)])) : null,
        calc_key: key(zones, act, rhr), updated_at: new Date().toISOString(),
      };
    }
    async function save(rows) {
      rows = rows.filter(Boolean);
      if (rows.length) await sb.from("activity_metrics").upsert(rows);
      return rows;
    }

    // Make sure every activity in the list has an up-to-date metrics row. Returns { [activity_id]: row }.
    async function ensure(acts, onProgress) {
      const zones = await settings();
      const ids = acts.map((a) => a.activity_id);
      const out = {};
      for (let i = 0; i < ids.length; i += 200) {
        const { data } = await sb.from("activity_metrics").select("*").in("activity_id", ids.slice(i, i + 200));
        for (const r of data || []) out[r.activity_id] = r;
      }
      // resting HR per day
      const dates = [...new Set(acts.map((a) => a.date))].sort();
      const rhr = {};
      if (dates.length) {
        const { data: ds } = await sb.from("days").select("date, rhr").gte("date", dates[0]).lte("date", dates[dates.length - 1]);
        for (const d of ds || []) if (d.rhr) rhr[d.date] = d.rhr;
      }
      const stale = acts.filter((a) => !out[a.activity_id] || out[a.activity_id].calc_key !== key(zones, a, rhr[a.date]));
      for (let i = 0; i < stale.length; i += 6) {
        const batch = stale.slice(i, i + 6);
        onProgress && onProgress(i, stale.length);
        const { data: streams } = await sb.from("activity_streams").select("activity_id, series, laps").in("activity_id", batch.map((a) => a.activity_id));
        const byId = Object.fromEntries((streams || []).map((s) => [s.activity_id, s]));
        const rows = await save(batch.map((a) => compute(a, byId[a.activity_id], zones, rhr[a.date])));
        for (const r of rows) out[r.activity_id] = r;
      }
      return out;
    }

    return { settings, compute, save, ensure, reset: () => (settingsP = null) };
  }

  root.NdureMetrics = NdureMetrics;
})(window);
