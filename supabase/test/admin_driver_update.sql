-- 117: the admin edits a driver once for all his shops. Rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare t uuid; s uuid; s2 uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); ops uuid := gen_random_uuid(); r jsonb; ok boolean; k text := suqa._phone_key('+96170117001'); k2 text := suqa._phone_key('+96170117002'); k3 text := suqa._phone_key('+96170117003');
begin
  select tenant_id, id into t, s from suqa.shops limit 1;
  insert into suqa.shops (id, tenant_id, slug, name, status) values (s2, t, 'drv117', '{"ar":"mahal 117","en":"shop 117"}', 'active');
  insert into auth.users (id, email) values (adm, 'adm117@test.local'), (ops, 'ops117@test.local');
  insert into suqa.tenant_members (tenant_id, user_id, role) values (t, adm, 'admin'), (t, ops, 'ops');
  insert into suqa.shop_drivers (id, shop_id, tenant_id, name, phone, phone_key, active, scope, pay_mode, pay_cents, vehicle) values
    (gen_random_uuid(), s,  t, 'Chhab',  '+96170117001', k,  true,  'shop', 'per_delivery', 150, 'Moto'),
    (gen_random_uuid(), s2, t, 'Chehab', '70117001',     k,  false, 'association', null, null, null),
    (gen_random_uuid(), s2, t, 'other',  '+96170117002', k2, true,  'shop', null, null, null);

  perform set_config('request.jwt.claim.sub', ops::text, true);
  begin perform suqa.admin_driver_update(t, k, '{"name":"x"}'); ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'ops cannot edit';

  perform set_config('request.jwt.claim.sub', adm::text, true);
  begin perform suqa.admin_driver_update(t, k, '{"name":"  "}'); ok := false; exception when others then ok := sqlerrm = 'bad_name'; end; assert ok, 'empty name refused';
  begin perform suqa.admin_driver_update(t, k, '{"phone":"12"}'); ok := false; exception when others then ok := sqlerrm = 'bad_phone'; end; assert ok, 'short phone refused';
  begin perform suqa.admin_driver_update(t, k, '{"phone":"+96170117002"}'); ok := false; exception when others then ok := sqlerrm = 'phone_taken'; end; assert ok, 'a number another driver of his shop has is refused';
  begin perform suqa.admin_driver_update(t, 'nobody', '{"name":"x"}'); ok := false; exception when others then ok := sqlerrm = 'driver_not_found'; end; assert ok, 'unknown driver';

  r := suqa.admin_driver_update(t, k, '{"name":" One Name "}');
  assert (r->>'rows')::int = 2 and (select count(*) = 2 from suqa.shop_drivers where phone_key = k and name = 'One Name'), 'renamed in both shops';
  assert (select vehicle = 'Moto' and pay_cents = 150 and scope = 'shop' and active from suqa.shop_drivers where shop_id = s and phone_key = k), 'vehicle, pay, scope, active untouched';
  assert (select not active and scope = 'association' from suqa.shop_drivers where shop_id = s2 and phone_key = k), 'the other line keeps its own state';
  assert (select name = 'other' from suqa.shop_drivers where phone_key = k2), 'another driver is not touched';

  r := suqa.admin_driver_update(t, k, '{"phone":"+961 70 117 003","vehicle":""}');
  assert r->>'phone_key' = k3 and (select count(*) = 2 from suqa.shop_drivers where phone_key = k3 and phone = '+961 70 117 003' and vehicle is null and name = 'One Name'), 'phone and vehicle changed on both lines';
  assert (select count(*) = 0 from suqa.shop_drivers where phone_key = k), 'old number gone';
  assert (select count(*) = 4 from suqa.audit_log where action = 'driver.edit' and tenant_id = t and user_id = adm), 'audit lines';
  assert not exists (select 1 from suqa.audit_log where action = 'driver.edit' and after ? 'phone'), 'no phone number in the audit log';
end $$;
rollback;
\echo admin_driver_update ok
