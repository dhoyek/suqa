-- 116: Admin → Drivers — who may read, no money in it, only an admin changes the scope. Rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare t uuid; s uuid; adm uuid := gen_random_uuid(); ops uuid := gen_random_uuid(); own uuid := gen_random_uuid(); d1 uuid := gen_random_uuid(); r jsonb; row jsonb; ok boolean; n int;
begin
  select tenant_id, id into t, s from suqa.shops limit 1;
  insert into auth.users (id, email) values (adm, 'adm116@test.local'), (ops, 'ops116@test.local'), (own, 'own116@test.local');
  insert into suqa.tenant_members (tenant_id, user_id, role) values (t, adm, 'admin'), (t, ops, 'ops');
  insert into suqa.shop_members (shop_id, user_id, role, active) values (s, own, 'owner', true);
  insert into suqa.shop_drivers (id, shop_id, tenant_id, name, phone, phone_key, active, scope, pay_mode, pay_cents)
  values (d1, s, t, 'driver 116', '+96170116001', suqa._phone_key('+96170116001'), true, 'shop', 'per_delivery', 150);

  perform set_config('request.jwt.claim.sub', own::text, true);            -- a shop owner is not the association
  begin perform suqa.admin_drivers(t); ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'a shop owner cannot read the list';
  begin perform suqa.admin_driver_scope(d1, 'association'); ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'a shop owner cannot change it here';

  perform set_config('request.jwt.claim.sub', ops::text, true);            -- ops: reads, does not change
  r := suqa.admin_drivers(t);
  select x into row from jsonb_array_elements(r->'drivers') x where x->>'id' = d1::text;
  assert row->>'scope' = 'shop' and row->>'name' = 'driver 116' and (row->>'active')::boolean, 'the driver is listed: ' || coalesce(row::text, 'null');
  assert not row ? 'pay_mode' and not row ? 'pay_cents' and r::text not like '%pay_%', 'no money in the list';
  assert r ? 'couriers', 'couriers key';
  begin perform suqa.admin_driver_scope(d1, 'association'); ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'ops cannot change the scope';

  perform set_config('request.jwt.claim.sub', adm::text, true);
  begin perform suqa.admin_driver_scope(d1, 'everyone'); ok := false; exception when others then ok := sqlerrm = 'bad_scope'; end;
  assert ok, 'bad scope refused';
  r := suqa.admin_driver_scope(d1, 'association');
  assert (r->>'ok')::boolean and (select scope = 'association' and pay_cents = 150 from suqa.shop_drivers where id = d1), 'shared now, pay untouched';
  r := suqa.admin_driver_scope(d1, 'association');
  assert (r->>'noop')::boolean, 'a second tap changes nothing';
  select count(*) into n from suqa.audit_log where action = 'driver.scope' and ref_id = d1::text;
  assert n = 1, 'one audit line';
  r := suqa.admin_driver_scope(d1, 'shop');
  assert (select scope = 'shop' from suqa.shop_drivers where id = d1), 'back to shop only';
end $$;
rollback;
\echo admin_drivers ok
