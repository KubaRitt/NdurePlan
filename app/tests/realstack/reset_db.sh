#!/bin/sh
set -e
cd "$(dirname "$0")"
P="psql -h /tmp -p 54329 -U postgres -v ON_ERROR_STOP=1 -q"
$P -c "drop database if exists t2" -c "create database t2" >/dev/null
$P -d t2 -f ../sql/fixture.sql >/dev/null
$P -d t2 -c "delete from public.sessions" >/dev/null
$P -d t2 -f ../../supabase/migrations/20261007_planner_diary.sql >/dev/null 2>&1
$P -d t2 -f ../../supabase/migrations/20261009_fit_activities.sql >/dev/null
$P -d t2 -f seed.sql >/dev/null
