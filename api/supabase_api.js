/**
 * NdurePlan - Supabase JS API Library
 *
 * No bundler is used in this static project, so we import the ESM build
 * directly from a CDN. If you later add a bundler (Vite, webpack, etc.),
 * switch this back to: import { createClient } from '@supabase/supabase-js';
 * and run: npm install @supabase/supabase-js
 *
 * Replace placeholders with your actual Supabase URL & Public Anon key
 * found in your Supabase Account Dashboard (Project Settings -> API).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://ogikyrfnsaswqwsldkhr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9naWt5cmZuc2Fzd3F3c2xka2hyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0NDAwNzUsImV4cCI6MjA5NzAxNjA3NX0.a00mYAiTDWqm5R3VEoO3cUmwjbnXfePoHGSsfpVKLAE';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * 1. USER AUTHENTICATION API
 */

// Sign up new athlete and initialize default HR zones via database trigger
export async function signUpAthlete(email, password) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

// Sign in existing athlete
export async function signInAthlete(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

// Sign out
export async function signOutAthlete() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/**
 * 2. USER ATHLETIC HR ZONES API
 */

// Fetch active custom heart rate zones from user profile
export async function fetchAthleteProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("No active authenticated session.");

  const { data, error } = await supabase
    .from('profiles')
    .select('email, hr_zones')
    .eq('id', user.id)
    .single();

  if (error) throw error;
  return data;
}

// Update heart rate zones block (run, bike, swim, etc.)
export async function updateAthleteHRZones(updatedZonesObject) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("No active authenticated session.");

  const { data, error } = await supabase
    .from('profiles')
    .update({
      hr_zones: updatedZonesObject,
      updated_at: new Date()
    })
    .eq('id', user.id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * 3. ATHLETIC TRAINING SESSIONS API
 */

// Fetch sessions within a specific date range (useful for Week / Month views)
export async function fetchSessionsByDateRange(startDateStr, endDateStr) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("No active authenticated session.");

  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', user.id)
    .gte('date', startDateStr)
    .lte('date', endDateStr)
    .order('date', { ascending: true })
    .order('time', { ascending: true });

  if (error) throw error;
  return data;
}

// Insert new training session with workout blocks
export async function createTrainingSession({ sport_type, discipline = '', date, time, blocks, description = '' }) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("No active authenticated session.");

  const { data, error } = await supabase
    .from('sessions')
    .insert([
      {
        user_id: user.id,
        sport_type,
        discipline,
        date,
        time,
        blocks,
        description
      }
    ])
    .select();

  if (error) throw error;
  return data[0];
}

// Update existing training session blocks
export async function updateTrainingSession(sessionId, { sport_type, discipline = '', date, time, blocks, description = '' }) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("No active authenticated session.");

  const { data, error } = await supabase
    .from('sessions')
    .update({
      sport_type,
      discipline,
      date,
      time,
      blocks,
      description
    })
    .eq('id', sessionId)
    .eq('user_id', user.id)
    .select();

  if (error) throw error;
  return data[0];
}

// Delete training session
export async function deleteTrainingSession(sessionId) {
  const { error } = await supabase
    .from('sessions')
    .delete()
    .eq('id', sessionId);

  if (error) throw error;
  return true;
}

/**
 * 4. STRAVA INTEGRATION API
 */

// Whether the current athlete has a Strava connection on file. Only checks
// for the *existence* of a token row — never reads the tokens themselves,
// those stay server-side.
export async function getStravaConnectionStatus() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("No active authenticated session.");

  const { data, error } = await supabase
    .from('strava_tokens')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

// Builds the URL that kicks off the Strava OAuth flow for the current
// athlete. Navigate to this (e.g. window.location.href = url).
export async function getStravaConnectUrl() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("No active authenticated session.");
  return `/api/strava-connect?user_id=${encodeURIComponent(user.id)}`;
}

// Fetch synced Strava activities within a date range, including any
// linked planned session (activities.session_id).
export async function fetchActivitiesByDateRange(startDateStr, endDateStr) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("No active authenticated session.");

  const { data, error } = await supabase
    .from('activities')
    .select('*')
    .eq('user_id', user.id)
    .gte('date', startDateStr)
    .lte('date', endDateStr)
    .order('strava_start', { ascending: true });

  if (error) throw error;
  return data;
}

// Triggers a server-side sync: pulls recent Strava activities and computes
// loads. Activities come back unlinked — use linkActivityToSession() to
// manually pair one or more of them with a planned session.
export async function triggerStravaSync(dateFromStr, dateToStr) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("No active authenticated session.");

  const params = new URLSearchParams({ user_id: user.id });
  if (dateFromStr) params.set('date_from', dateFromStr);
  if (dateToStr) params.set('date_to', dateToStr);

  const res = await fetch(`/api/fetch-activities?${params.toString()}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Strava sync failed');
  return data;
}

// Manually link a synced Strava activity to a planned session. Call once
// per activity if linking several (e.g. a main set activity + a separate
// cooldown activity) to the same session.
export async function linkActivityToSession(activityId, sessionId) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("No active authenticated session.");

  const { data, error } = await supabase
    .from('activities')
    .update({ session_id: sessionId })
    .eq('id', activityId)
    .eq('user_id', user.id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Remove the link between a Strava activity and whatever session it's
// currently attached to (the activity itself is kept, just unlinked).
export async function unlinkActivity(activityId) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("No active authenticated session.");

  const { data, error } = await supabase
    .from('activities')
    .update({ session_id: null })
    .eq('id', activityId)
    .eq('user_id', user.id)
    .select()
    .single();

  if (error) throw error;
  return data;
}
