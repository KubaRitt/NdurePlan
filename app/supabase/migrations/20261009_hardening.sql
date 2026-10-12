-- NdurePlan: Supabase advisor fixes (9 Oct 2026). Same rules, faster and tighter; nothing is removed.
-- Applied to the live project on 9 Oct 2026.

-- Trigger functions: fixed search_path, and not callable through the REST API.
alter function public.handle_new_user() set search_path = '';
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

-- RLS: evaluate auth.uid() once per query instead of once per row.
alter policy "Allow users to view their own profile" on public.profiles using ((select auth.uid()) = id);
alter policy "Allow users to update their own profile" on public.profiles using ((select auth.uid()) = id);
alter policy "Allow users to view their own training sessions" on public.sessions using ((select auth.uid()) = user_id);
alter policy "Allow users to insert their own training sessions" on public.sessions with check ((select auth.uid()) = user_id);
alter policy "Allow users to update their own training sessions" on public.sessions using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "Allow users to delete their own training sessions" on public.sessions using ((select auth.uid()) = user_id);
alter policy "Users can view their own activities" on public.activities using ((select auth.uid()) = user_id);
alter policy "Users can view their own strava connection" on public.strava_tokens using ((select auth.uid()) = user_id);
alter policy "Users can disconnect their own strava connection" on public.strava_tokens using ((select auth.uid()) = user_id);
