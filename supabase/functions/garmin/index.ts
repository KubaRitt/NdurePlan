// Ndure · garmin edge function
// Every call must come from a signed-in user (JWT verified by Supabase).
// The user's Garmin Personal API key is stored server-side only and never returned.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const TOKEN_URL =
  "https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function mintToken(userId: string, key: string) {
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { Authorization: `ApiKey ${key}` } });
  const text = await r.text();
  if (!r.ok) return { ok: false, status: r.status, body: text.slice(0, 2000) };
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text); } catch { /* keep empty */ }
  const token = (data.access_token ?? data.accessToken ?? data.token) as string | undefined;
  const ttl = Number(data.expires_in ?? data.expiresIn ?? 86400);
  if (!token) return { ok: false, status: r.status, body: "Token response had no access token field", fields: Object.keys(data) };
  const expires_at = new Date(Date.now() + (ttl - 300) * 1000).toISOString(); // refresh 5 min early
  await admin.from("garmin_credentials").update({ access_token: token, token_expires_at: expires_at }).eq("user_id", userId);
  return { ok: true, token, expires_at, fields: Object.keys(data) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // Identify the caller from their own JWT
  const auth = req.headers.get("Authorization") ?? "";
  const { data: { user }, error: authErr } = await admin.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  if (authErr || !user) return json({ error: "Not signed in" }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const action = String(body.action ?? "");

  if (action === "save_key") {
    const key = String(body.key ?? "").trim();
    if (key.length < 10 || key.length > 4000) return json({ error: "That doesn't look like a key" }, 400);
    const { error } = await admin.from("garmin_credentials").upsert({
      user_id: user.id, api_key: key, access_token: null, token_expires_at: null, updated_at: new Date().toISOString(),
    });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  const { data: cred } = await admin.from("garmin_credentials")
    .select("api_key, access_token, token_expires_at, updated_at").eq("user_id", user.id).maybeSingle();

  if (action === "status") {
    return json({
      has_key: !!cred,
      key_saved_at: cred?.updated_at ?? null,
      token_valid_until: cred?.token_expires_at && new Date(cred.token_expires_at) > new Date() ? cred.token_expires_at : null,
    });
  }

  if (action === "delete_key") {
    await admin.from("garmin_credentials").delete().eq("user_id", user.id);
    return json({ ok: true });
  }

  if (!cred) return json({ error: "No Garmin key saved yet" }, 400);

  if (action === "token") {
    const t = await mintToken(user.id, cred.api_key);
    return json(t.ok ? { ok: true, expires_at: t.expires_at, response_fields: t.fields } : t, t.ok ? 200 : 502);
  }

  if (action === "get") {
    // Test any Garmin GET endpoint. Only https Garmin hosts are allowed.
    let url: URL;
    try { url = new URL(String(body.url ?? "")); } catch { return json({ error: "Invalid URL" }, 400); }
    if (url.protocol !== "https:" || !(url.hostname === "garmin.com" || url.hostname.endsWith(".garmin.com")))
      return json({ error: "Only https://*.garmin.com URLs are allowed" }, 400);

    let token = cred.access_token as string | null;
    if (!token || !cred.token_expires_at || new Date(cred.token_expires_at) <= new Date()) {
      const t = await mintToken(user.id, cred.api_key);
      if (!t.ok) return json({ step: "token", ...t }, 502);
      token = t.token!;
    }
    const started = Date.now();
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, redirect: "manual" });
    const ct = r.headers.get("content-type") ?? "";
    const text = await r.text();
    let parsed: unknown = undefined;
    if (ct.includes("json")) { try { parsed = JSON.parse(text); } catch { /* raw */ } }
    return json({
      status: r.status, ms: Date.now() - started, content_type: ct, bytes: text.length,
      body: parsed ?? text.slice(0, 20000),
    });
  }

  return json({ error: "Unknown action" }, 400);
});
