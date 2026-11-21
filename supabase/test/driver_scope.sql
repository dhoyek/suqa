-- 98: a driver for the shop only or for the whole association; what the other shops see of him. Rolls back.
\set ON_ERROR_STOP on
begin;
\i supabase/schema/98_driver_scope.sql
\i supabase/schema/98_driver_scope.sql
create schema if not exists t_ds; grant usage on schema t_ds to authenticated;
create or replace function t_ds.try(p_shop uuid) returns text language plpgsql as $$ begin return jsonb_array_length(suqa.pos_association_drivers(p_shop))::text; exception when others then return sqlerrm; end $$;
create or replace function t_ds.make_admin(p uuid) returns void language sql security definer as $$ insert into suqa.platform_admins (user_id) values (p) on conflict do nothing $$;
grant execute on all functions in schema t_ds to authenticated;
do $$
declare t uuid := (select id from suqa.tenants where slug = 'batroun'); a uuid := (select id from suqa.shops where slug = 'abou-elie'); b uuid := gen_random_uuid();
        cols text := (select string_agg(quote_ident(column_name), ', ') from information_schema.columns where table_schema = 'suqa' and table_name = 'shops' and column_name not in ('id', 'slug') and is_generated = 'NEVER');
        da suqa.devices; db suqa.devices; r jsonb; l jsonb;
begin
  execute format('insert into suqa.shops (id, slug, %s) select $1, ''t98-b'', %s from suqa.shops where id = $2', cols, cols) using b, a;
  insert into suqa.devices (id, shop_id, tenant_id, name, prefix) values (gen_random_uuid(), a, t, 't98 a', 'Y') returning * into da;
  insert into suqa.devices (id, shop_id, tenant_id, name, prefix) values (gen_random_uuid(), b, t, 't98 b', 'Z') returning * into db;
  insert into suqa.shop_members (shop_id, user_id, role) values (b, '44444444-4444-4444-4444-444444444444', 'owner') on conflict do nothing;      -- the cashier of shop A is the owner of shop B here

  -- as before: no scope sent = for the shop only
  r := suqa._pos_driver_upsert(db, '{"name":"Samir","phone":"70 111 001"}', null);
  assert (select scope from suqa.shop_drivers where id = (r->>'id')::uuid) = 'shop', 'default scope';
  -- shared by shop B, with a pay rule of its own
  r := suqa._pos_driver_upsert(db, '{"name":"Walid","phone":"70 111 002","vehicle":"moto","scope":"association"}', null);
  update suqa.shop_drivers set pay_mode = 'per_delivery', pay_cents = 150 where id = (r->>'id')::uuid;
  assert (select scope from suqa.shop_drivers where id = (r->>'id')::uuid) = 'association', 'shared';
  -- an edit that does not send scope keeps it; a wrong value is ignored; it can be taken back
  perform suqa._pos_driver_upsert(db, '{"name":"Walid K","phone":"70 111 002","vehicle":"moto"}', null);
  assert (select scope = 'association' and name = 'Walid K' from suqa.shop_drivers where shop_id = b and phone_key = suqa._phone_key('70 111 002')), 'scope kept on an edit';
  perform suqa._pos_driver_upsert(db, '{"name":"Walid K","phone":"70 111 002","vehicle":"moto","scope":"everyone"}', null);
  assert (select scope from suqa.shop_drivers where shop_id = b and phone_key = suqa._phone_key('70 111 002')) = 'association', 'unknown scope ignored';
  create temp table t98 on commit drop as select a, b, t, to_jsonb(da) da, to_jsonb(db) db;
  grant select on t98 to authenticated;
end $$;

set local role authenticated; set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';   -- owner of shop A
do $$
declare r record; l jsonb;
begin
  select * into r from t98;
  l := suqa.pos_association_drivers(r.a);
  assert jsonb_array_length(l) = 1 and l->0->>'name' = 'Walid K' and l->0->>'vehicle' = 'moto', 'shop A sees the shared driver only: ' || l::text;
  assert not (l->0 ? 'pay_mode') and not (l->0 ? 'pay_cents') and not (l->0 ? 'id') and not (l->0 ? 'shop_id'), 'name, phone and vehicle only: ' || l::text;
end $$;
reset role;
do $$
declare r record; x jsonb;
begin
  select * into r from t98;
  -- shop A adds him: its own row, its own (default) rule; then he is no longer offered to A
  x := suqa._pos_driver_upsert(jsonb_populate_record(null::suqa.devices, r.da), '{"name":"Walid K","phone":"70 111 002","vehicle":"moto"}', null);
  assert (select scope = 'shop' and pay_mode is null and shop_id = r.a from suqa.shop_drivers where id = (x->>'id')::uuid), 'A''s own row';
  assert (select count(*) from suqa.shop_drivers where phone_key = suqa._phone_key('70 111 002')) = 2, 'two rows, one per shop';
end $$;
set local role authenticated;
do $$
declare r record;
begin
  select * into r from t98;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  assert t_ds.try(r.a) = '0', 'already added: not offered again (' || t_ds.try(r.a) || ')';
  assert t_ds.try(r.b) = 'not_staff', 'not on shop B''s staff: ' || t_ds.try(r.b);
  perform set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);      -- owner of B, cashier of A
  assert t_ds.try(r.b) = '0', 'B is not offered its own driver, nor A''s private copy: ' || t_ds.try(r.b);
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true); perform t_ds.make_admin('33333333-3333-3333-3333-333333333333');
  assert t_ds.try(r.a) = 'not_staff', 'a platform admin (setup) is refused: ' || t_ds.try(r.a);
  perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  assert t_ds.try(r.a) = 'not_staff', 'a stranger';
end $$;
reset role;
do $$
declare r record;
begin
  select * into r from t98;
  -- taken back by shop B: gone from the list for a shop that has not got him
  delete from suqa.shop_drivers where shop_id = r.a and phone_key = suqa._phone_key('70 111 002');
  perform suqa._pos_driver_upsert(jsonb_populate_record(null::suqa.devices, r.db), '{"name":"Walid K","phone":"70 111 002","scope":"shop"}', null);
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  assert jsonb_array_length((select suqa.pos_association_drivers(r.a) from (select set_config('role', 'authenticated', true)) s)) = 0, 'taken back';
end $$;
\echo driver_scope OK
rollback;
