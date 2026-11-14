-- 62_function_default_privileges.sql — new functions are private until a file opens them.   (2026-11-14)
-- Until now every function created in schema suqa was callable by everyone the moment it existed: Postgres grants EXECUTE to
-- PUBLIC by default, and 00 added a default grant to anon / authenticated. That is how the internal helpers closed by 58 and the
-- unguarded ones closed by 61 became reachable — and a new helper would have been open again until 58 was re-run.
-- From this file on, a function created by the database owner is callable by nobody but the owner and the service key; a file
-- that adds a function meant for the app must say so itself:   grant execute on function suqa.x(...) to authenticated;
-- (every public function added since 21 already does). Existing functions keep the rights they have — nothing changes for them,
-- and "create or replace" of an existing function keeps its rights too.
-- NOTE: 00 sets the old default (the functions of 01–61 rely on it on a fresh install). Run this file after 00 whenever 00 is
-- re-run. 58 stays useful as a check (it reports what is still reachable). Idempotent.

alter default privileges in schema suqa revoke all on functions from anon, authenticated;
alter default privileges revoke execute on functions from public;            -- the owner role's global default (PUBLIC)
alter default privileges in schema suqa grant execute on functions to service_role;

select 'new functions are private by default' as result;
