-- 99: demand report — Yorgo's stored searches + the search boxes; who may read it. Rolls back.
\set ON_ERROR_STOP on
begin;
\i supabase/schema/99_demand.sql
\i supabase/schema/99_demand.sql
create schema if not exists t_dm; grant usage on schema t_dm to authenticated, anon;
create or replace function t_dm.rep(p uuid) returns text language plpgsql as $$ begin return suqa.demand_report(p, 30)::text; exception when others then return sqlerrm; end $$;
create or replace function t_dm.ppl(p uuid, k text) returns text language plpgsql as $$ begin return suqa.demand_people(p, k, 30)::text; exception when others then return sqlerrm; end $$;
create or replace function t_dm.n() returns int language sql security definer as $$ select count(*)::int from suqa.search_log $$;
grant execute on all functions in schema t_dm to authenticated, anon;
do $$
declare t uuid := (select id from suqa.tenants where slug = 'batroun'); a uuid := (select id from suqa.shops where slug = 'abou-elie');
        c1 uuid := gen_random_uuid(); c2 uuid := gen_random_uuid(); c3 uuid := gen_random_uuid();
        res text := '[{"phrase":"khebez","candidates":[{"product_id":"x","score":0.92},{"product_id":"y","score":0.3}]},{"phrase":"kaak 3asrouniye","candidates":[{"product_id":"z","score":0.31}]},{"phrase":"zaatar","candidates":[]}]';
begin
  insert into suqa.yorgo_conversations (id, tenant_id, user_id, mode, channel) values (c1, t, '11111111-1111-1111-1111-111111111111', 'shopper', 'app');
  insert into suqa.yorgo_conversations (id, tenant_id, wa_phone, mode, channel) values (c2, t, '96170000004', 'shopper', 'whatsapp');     -- a phone that has an account (Cashier)
  insert into suqa.yorgo_conversations (id, tenant_id, user_id, shop_id, mode, channel) values (c3, t, '22222222-2222-2222-2222-222222222222', a, 'seller', 'pos');
  insert into suqa.yorgo_messages (conversation_id, tenant_id, role, content) values
    (c1, t, 'user', '[{"type":"text","text":"badde khebez w kaak"}]'),
    (c1, t, 'tool', jsonb_build_array(jsonb_build_object('type', 'tool_result', 'tool_use_id', 'a', 'content', res))),
    (c1, t, 'tool', jsonb_build_array(jsonb_build_object('type', 'tool_result', 'tool_use_id', 'b', 'content', '{"ok":true,"lines":1}'))),       -- a draft's answer: not a search
    (c1, t, 'tool', jsonb_build_array(jsonb_build_object('type', 'tool_result', 'tool_use_id', 'c', 'content', '[{"phrase":"broken', 'is_error', true))),
    (c1, t, 'tool', '[{"type":"text","text":"(app note)"}]'),
    (c2, t, 'tool', jsonb_build_array(jsonb_build_object('type', 'tool_result', 'tool_use_id', 'd', 'content', '[{"phrase":"Khebez","candidates":[{"score":1}]},{"phrase":"خبز","candidates":[{"score":0.9}]}]'))),
    (c3, t, 'tool', jsonb_build_array(jsonb_build_object('type', 'tool_result', 'tool_use_id', 'e', 'content', '[{"phrase":"khebez","candidates":[{"score":1}]}]')));   -- seller: not demand
  create temp table t99 on commit drop as select t, a, suqa.norm_text('khebez') kh, suqa.norm_text('zaatar') za, suqa.norm_text('kaak 3asrouniye') ka; grant select on t99 to authenticated, anon;
end $$;

-- the search boxes: a visitor typing on is one row; the same words again are not counted twice
set local role anon;
do $$
declare r record;
begin
  select * into r from t99;
  perform suqa.search_note(r.t, null, 'kh', false, 'tab-1');
  perform suqa.search_note(r.t, null, 'khe', true, 'tab-1');
  perform suqa.search_note(r.t, null, 'khebez', true, 'tab-1');
  perform suqa.search_note(r.t, null, 'khebe', true, 'tab-1');           -- a letter deleted: the longer words stay
  perform suqa.search_note(r.t, null, 'khebez', true, 'tab-1');
  assert t_dm.n() = 1, 'typing on = one row, got ' || t_dm.n();
  perform suqa.search_note(r.t, null, 'zaatar', false, 'tab-1');         -- other words: a new row
  perform suqa.search_note(null, r.a, 'zaatar', false, 'tab-2');         -- another visitor, on a shop page (the shop says which association)
  perform suqa.search_note(r.t, null, 'x', true, 'tab-1');               -- too short
  perform suqa.search_note(r.t, gen_random_uuid(), 'halib', true, 'tab-1');   -- a shop that is not the association's
  perform suqa.search_note(gen_random_uuid(), null, 'halib', true, 'tab-1');  -- no such association
  perform suqa.search_note(r.t, null, 'halib', true, null);              -- no visitor key: still counted
  assert t_dm.n() = 4, 'rows: ' || t_dm.n();
  assert t_dm.rep(r.t) like '%permission denied%' or t_dm.rep(r.t) = 'not_allowed', 'a visitor cannot read the report: ' || t_dm.rep(r.t);
end $$;
reset role;
set local role authenticated;
do $$
declare r record; j jsonb; k jsonb; p jsonb;
begin
  select * into r from t99;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);       -- a customer, signed in
  perform suqa.search_note(r.t, r.a, 'Zaatar', false, 'ignored');
  assert t_dm.rep(r.t) = 'not_allowed' and t_dm.ppl(r.t, r.kh) = 'not_allowed', 'a customer cannot read it';
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);       -- a shop owner
  assert t_dm.rep(r.t) = 'not_allowed' and t_dm.ppl(r.t, r.kh) = 'not_allowed', 'a shop owner cannot read it';
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);       -- the association admin
  j := suqa.demand_report(r.t, 30);
  -- yorgo: khebez (c1) + Khebez (c2) + kaak + zaatar + خبز = 5; search: khebez, zaatar ×3, halib = 5; the seller's search is not there
  assert (j->>'total')::int = 10, 'total ' || j::text;
  select x into k from jsonb_array_elements(j->'phrases') x where x->>'key' = r.kh;
  assert (k->>'times')::int = 3 and (k->>'found')::int = 3 and (k->>'yorgo_app')::int = 1 and (k->>'yorgo_whatsapp')::int = 1 and (k->>'search')::int = 1 and (k->>'people')::int = 3, 'khebez ' || k::text;
  select x into k from jsonb_array_elements(j->'phrases') x where x->>'key' = r.za;
  assert (k->>'times')::int = 4 and (k->>'not_found')::int = 4 and (k->>'people')::int = 3, 'zaatar: customer one in chat and in a shop search is one person ' || k::text;
  assert j->'phrases'->0->>'key' = r.za, 'most asked first';
  select x into k from jsonb_array_elements(j->'phrases') x where x->>'key' = r.ka;
  assert (k->>'not_found')::int = 1, 'a weak look-alike (0.31) is not found ' || k::text;
  assert (j->>'not_found')::int = 5, 'not found ' || j::text;
  -- who
  p := suqa.demand_people(r.t, r.kh, 30);
  assert jsonb_array_length(p) = 3, 'three askers ' || p::text;
  assert exists (select 1 from jsonb_array_elements(p) x where x->>'source' = 'yorgo_app' and x->>'name' = 'Customer One' and x->>'phone' = '+96170000001'), 'app: name and phone ' || p::text;
  assert exists (select 1 from jsonb_array_elements(p) x where x->>'source' = 'yorgo_whatsapp' and x->>'phone' = '+96170000004' and x->>'name' = 'Cashier'), 'whatsapp: phone, and the name of its account ' || p::text;
  assert exists (select 1 from jsonb_array_elements(p) x where x->>'source' = 'search' and x->>'name' is null and x->>'phone' is null), 'a visitor: no name ' || p::text;
  p := suqa.demand_people(r.t, r.za, 30);
  assert exists (select 1 from jsonb_array_elements(p) x where x->>'source' = 'search' and x->>'name' = 'Customer One' and x->>'shop_id' = r.a::text and x->>'as_written' = 'Zaatar'), 'signed-in search ' || p::text;
  assert (suqa.demand_report(r.t, 0)->>'days')::int = 1, 'days clamped';
end $$;
reset role;
rollback;
select 'demand ok' as result;
