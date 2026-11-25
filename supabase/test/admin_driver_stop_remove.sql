-- 118: stop / resume / remove a driver's shop line. Rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare t uuid; s uuid; adm uuid := gen_random_uuid(); ops uuid := gen_random_uuid(); d_new uuid := gen_random_uuid(); d_used uuid := gen_random_uuid(); o uuid; st suqa.order_status; r jsonb; ok boolean;
begin
  select id, shop_id, tenant_id, status into o, s, t, st from suqa.orders where channel <> 'walkin' and not parked limit 1;
  assert o is not null, 'the test database needs one order';
  insert into auth.users (id, email) values (adm, 'adm118@test.local'), (ops, 'ops118@test.local');
  insert into suqa.tenant_members (tenant_id, user_id, role) values (t, adm, 'admin'), (t, ops, 'ops');
  insert into suqa.shop_drivers (id, shop_id, tenant_id, name, phone, phone_key, active, available, scope) values
    (d_new,  s, t, 'new 118',  '+96170118001', suqa._phone_key('+96170118001'), true, true, 'shop'),
    (d_used, s, t, 'used 118', '+96170118002', suqa._phone_key('+96170118002'), true, true, 'association');
  alter table suqa.orders disable trigger user;
  update suqa.orders set driver_id = d_used, status = 'out_for_delivery' where id = o;

  perform set_config('request.jwt.claim.sub', ops::text, true);
  begin perform suqa.admin_driver_active(d_new, false); ok := false; exception when insufficient_privilege then ok := true; end; assert ok, 'ops cannot stop';
  begin perform suqa.admin_driver_remove(d_new); ok := false; exception when insufficient_privilege then ok := true; end; assert ok, 'ops cannot remove';

  perform set_config('request.jwt.claim.sub', adm::text, true);
  begin perform suqa.admin_driver_active(d_used, false); ok := false; exception when others then ok := sqlerrm = 'driver_busy'; end; assert ok, 'busy: not stopped';
  begin perform suqa.admin_driver_remove(d_used); ok := false; exception when others then ok := sqlerrm = 'driver_busy'; end; assert ok, 'busy: not removed';
  update suqa.orders set status = 'delivered' where id = o;
  alter table suqa.orders enable trigger user;

  r := suqa.admin_driver_active(d_new, false);
  assert (select not active and not available and scope = 'shop' from suqa.shop_drivers where id = d_new), 'stopped';
  assert (suqa.admin_driver_active(d_new, false)->>'noop')::boolean, 'second tap';
  r := suqa.admin_driver_active(d_new, true);
  assert (select active and not available from suqa.shop_drivers where id = d_new), 'working again (availability is his own to switch on)';

  r := suqa.admin_driver_remove(d_used);
  assert (r->>'deactivated')::boolean and (select not active and scope = 'association' from suqa.shop_drivers where id = d_used), 'has history: kept and stopped';
  assert (select driver_id = d_used from suqa.orders where id = o), 'his order still points at him';
  r := suqa.admin_driver_remove(d_new);
  assert (r->>'deleted')::boolean and not exists (select 1 from suqa.shop_drivers where id = d_new), 'no history: deleted';
  assert (suqa.admin_driver_remove(d_new)->>'noop')::boolean, 'removing again changes nothing';
  assert (select count(*) from suqa.audit_log where action in ('driver.active', 'driver.remove') and user_id = adm) = 4, 'audit lines';
end $$;
rollback;
\echo admin_driver_stop_remove ok
