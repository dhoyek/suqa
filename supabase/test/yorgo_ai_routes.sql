-- 100: AI routes — platform admins only; a route without prices cannot be switched on; voice only on a provider that takes sound. Rolls back.
\set ON_ERROR_STOP on
begin;
\i supabase/schema/100_yorgo_ai_routes.sql
\i supabase/schema/100_yorgo_ai_routes.sql
create schema if not exists t_ar; grant usage on schema t_ar to authenticated, anon;
create or replace function t_ar.n() returns text language plpgsql as $$ begin return (select count(*) from suqa.yorgo_ai_routes)::text; exception when others then return sqlerrm; end $$;
create or replace function t_ar.upd(q text) returns text language plpgsql as $$ declare n int; begin execute q; get diagnostics n = row_count; return n::text; exception when others then return sqlerrm; end $$;
create or replace function t_ar.make_admin(p uuid) returns void language sql security definer as $$ insert into suqa.platform_admins (user_id) values (p) on conflict do nothing $$;
grant execute on all functions in schema t_ar to authenticated, anon;
do $$ begin
  assert (select count(*) from suqa.yorgo_ai_routes) = 2, 'seeded once';
  assert (select enabled = false and price_out_per_m is null from suqa.yorgo_ai_routes where task = 'voice'), 'voice ships off, unpriced';
end $$;
set local role anon;
do $$ begin assert t_ar.n() like '%permission denied%', 'a visitor reads nothing: ' || t_ar.n(); end $$;
reset role;
set local role authenticated;
do $$
declare r text;
begin
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);      -- a customer
  assert t_ar.n() = '0', 'a customer sees no route: ' || t_ar.n();
  assert t_ar.upd($q$update suqa.yorgo_ai_routes set notes = 'x'$q$) = '0', 'a customer changes nothing';
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);      -- a shop owner
  assert t_ar.n() = '0', 'a shop owner sees no route';
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);      -- the association admin: not the platform's
  assert t_ar.n() = '0', 'an association admin sees no route: ' || t_ar.n();
  r := t_ar.upd($q$insert into suqa.yorgo_ai_routes (task, provider, model) values ('photo_read', 'google', 'm')$q$);
  assert r like '%row-level security%', 'an association admin adds nothing: ' || r;
  perform t_ar.make_admin('33333333-3333-3333-3333-333333333333');                                -- now a platform admin
  assert t_ar.n() = '2', 'the platform admin reads them';
  r := t_ar.upd($q$update suqa.yorgo_ai_routes set enabled = true where task = 'voice'$q$);
  assert r like '%yorgo_ai_routes_priced%', 'no prices, no switch: ' || r;
  r := t_ar.upd($q$update suqa.yorgo_ai_routes set enabled = true, price_audio_per_m = 0.3 where task = 'voice'$q$);
  assert r like '%yorgo_ai_routes_priced%', 'an output price is needed too: ' || r;
  r := t_ar.upd($q$update suqa.yorgo_ai_routes set enabled = true, price_audio_per_m = 0.3, price_in_per_m = 0.3, price_out_per_m = 2.5, updated_by = '11111111-1111-1111-1111-111111111111' where task = 'voice'$q$);
  assert r = '1', 'priced: on — ' || r;
  assert (select updated_by = '33333333-3333-3333-3333-333333333333' and updated_at > now() - interval '1 minute' from suqa.yorgo_ai_routes where task = 'voice'), 'stamped with who really changed it';
  r := t_ar.upd($q$update suqa.yorgo_ai_routes set provider = 'anthropic', model = 'claude-haiku-5-5' where task = 'voice'$q$);
  assert r like '%yorgo_ai_routes_voice_provider%', 'voice stays on a provider that takes sound: ' || r;
  r := t_ar.upd($q$update suqa.yorgo_ai_routes set fallback_provider = 'google' where task = 'voice'$q$);
  assert r like '%yorgo_ai_routes_fallback_pair%', 'a fallback is a provider and a model: ' || r;
  r := t_ar.upd($q$update suqa.yorgo_ai_routes set fallback_provider = 'google', fallback_model = 'gemini-3.1-flash-lite' where task = 'voice'$q$);
  assert r = '1', 'fallback set: ' || r;
  r := t_ar.upd($q$delete from suqa.yorgo_ai_routes where task = 'voice'$q$);
  assert r like '%permission denied%', 'no delete, even for the platform admin: ' || r;
end $$;
reset role;
rollback;
select 'yorgo ai routes ok' as result;
