// Ndure · per-activity load results (HR load, body load, time in zone), saved in activity_metrics.
// Computed in the browser from the saved track + your zones; recalculated when zones or pace anchors change.
(function (root) {
  const L = root.NdureLaps;

  function NdureMetrics(sb) {
    let settingsP = null;
    const settings = () => (settingsP ??= sb.from("user_settings").select("zones").maybeSingle().then((r) => r.data?.zones || {}));

    // One activity → metrics row (needs its garmin_activities row and, except for fixed-rate sports, the saved track)
    function compute(act, saved, zones) {
      const fam = act.family || "other";
      let res = saved && saved.series && saved.series.t ? L.analyse(saved.series, fam, zones, saved.laps) : null;
      if (!res) {
        // no track: only fixed-rate sports (strength, HIIT, yoga …) can still be scored, from the duration
        const ld0 = L.load({ s: { dt: [act.duration_s || 0], n: 1 }, laps: [] }, fam, act.sport_key, zones);
        if (ld0.basis !== "fixed") return null;
        return row(act, ld0, null, zones);
      }
      return row(act, L.load(res, fam, act.sport_key, zones), res, zones);
    }
    function row(act, ld, res, zones) {
      return {
        activity_id: act.activity_id, date: act.date, family: act.family,
        hr_load: ld.hr, body_load: ld.body, basis: ld.basis, descent_m: ld.descent ?? null,
        nm_reps: res ? res.counts.reps : 0, tiz: res ? Object.fromEntries(Object.entries(res.tiz).map(([k, v]) => [k, Math.round(v)])) : null,
        calc_key: L.calcKey(zones, act.family || "other"), updated_at: new Date().toISOString(),
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
      const stale = acts.filter((a) => !out[a.activity_id] || out[a.activity_id].calc_key !== L.calcKey(zones, a.family || "other"));
      for (let i = 0; i < stale.length; i += 6) {
        const batch = stale.slice(i, i + 6);
        onProgress && onProgress(i, stale.length);
        const { data: streams } = await sb.from("activity_streams").select("activity_id, series, laps").in("activity_id", batch.map((a) => a.activity_id));
        const byId = Object.fromEntries((streams || []).map((s) => [s.activity_id, s]));
        const rows = await save(batch.map((a) => compute(a, byId[a.activity_id], zones)));
        for (const r of rows) out[r.activity_id] = r;
      }
      return out;
    }

    // Refit running pace anchors from the last 30 days of saved runs (kept unless you set your own)
    async function refitPace() {
      const zones = await settings();
      const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      const { data: runs } = await sb.from("garmin_activities").select("activity_id").eq("family", "run").gte("date", since);
      const ids = (runs || []).map((r) => r.activity_id);
      const list = [];
      for (let i = 0; i < ids.length; i += 8) {
        const { data } = await sb.from("activity_streams").select("series").in("activity_id", ids.slice(i, i + 8));
        for (const s of data || []) list.push(s.series);
      }
      const fit = L.fitPace(list, zones.run);
      if (!fit) return { fit: null, runs: ids.length };
      const next = { ...zones, run: { ...(zones.run || {}), pace: fit } };
      const { data: { user } } = await sb.auth.getUser();
      await sb.from("user_settings").upsert({ user_id: user.id, zones: next, updated_at: new Date().toISOString() });
      settingsP = Promise.resolve(next);
      return { fit, runs: ids.length };
    }

    return { settings, compute, save, ensure, refitPace, reset: () => (settingsP = null) };
  }

  root.NdureMetrics = NdureMetrics;
})(window);
