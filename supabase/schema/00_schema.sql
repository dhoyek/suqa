-- 00_schema.sql — extensions, schema, grants            (2026-10-16)
create extension if not exists "pgcrypto";
create extension if not exists "postgis";
create extension if not exists "citext";

create schema if not exists suqa;

-- Supabase API roles need to see the schema. Also add "suqa" to
-- Project Settings → API → Exposed schemas.
grant usage on schema suqa to anon, authenticated, service_role;
alter default privileges in schema suqa grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema suqa grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema suqa grant all on functions to anon, authenticated, service_role;
