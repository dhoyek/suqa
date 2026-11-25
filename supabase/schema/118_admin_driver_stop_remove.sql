-- 118: the association's admin stops a driver in a shop, lets him work again, or removes him from a shop (Admin → Drivers).
--   admin_driver_active(driver, active)   association ADMIN only. One shop line of a driver: stopped (active = false, and not
--                                         "available") or working again (active = true). A stopped driver cannot be given orders
--                                         in that shop; his history, cash and settlements stay as they are.
--   admin_driver_remove(driver)           association ADMIN only. The same rule as the shop's own "remove driver":
--                                           · he never delivered for that shop and was never paid by it → his line is deleted;
--                                           · otherwise the line is KEPT and stopped (orders, cash and payouts hang on it) —
--                                             the answer says 'deactivated'.
--   Both are refused with 'driver_busy' while he holds an open delivery of that shop (accepted … on the way): finish or
--   reassign it first. Other shops' lines of the same person are not touched. Tills get the change by sync; audit log
--   'driver.active' / 'driver.remove'.
-- No table change. Safe to run twice.

create or replace function suqa.admin_driver_active(p_driver uuid, p_active boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare d suqa.shop_drivers;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if p_active is null then raise exception 'bad_value'; end if;
  select * into d from suqa.shop_drivers where id = p_driver for update;
  if not found then raise exception 'driver_not_found'; end if;
  if not suqa.is_tenant_admin(d.tenant_id) then raise exception 'not_allowed' using errcode = 'insufficient_privilege'; end if;
  if d.active = p_active then return jsonb_build_object('ok', true, 'noop', true, 'active', d.active); end if;
  if not p_active and exists (select 1 from suqa.orders o where o.shop_id = d.shop_id and o.driver_id = d.id and o.status in ('accepted', 'preparing', 'ready', 'out_for_delivery')) then
    raise exception 'driver_busy';
  end if;
  update suqa.shop_drivers set active = p_active, available = case when p_active then available else false end where id = d.id;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after)
  values (d.shop_id, d.tenant_id, auth.uid(), 'driver.active', 'shop_drivers', d.id::text, jsonb_build_object('name', d.name, 'active', p_active, 'by', 'association'));
  return jsonb_build_object('ok', true, 'active', p_active);
end $function$;
revoke all on function suqa.admin_driver_active(uuid, boolean) from public, anon;
grant execute on function suqa.admin_driver_active(uuid, boolean) to authenticated;

create or replace function suqa.admin_driver_remove(p_driver uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare d suqa.shop_drivers; v_used boolean;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  select * into d from suqa.shop_drivers where id = p_driver for update;
  if not found then return jsonb_build_object('ok', true, 'noop', true); end if;          -- a second tap, or the shop removed him
  if not suqa.is_tenant_admin(d.tenant_id) then raise exception 'not_allowed' using errcode = 'insufficient_privilege'; end if;
  if exists (select 1 from suqa.orders o where o.shop_id = d.shop_id and o.driver_id = d.id and o.status in ('accepted', 'preparing', 'ready', 'out_for_delivery')) then
    raise exception 'driver_busy';
  end if;
  v_used := exists (select 1 from suqa.orders o where o.driver_id = d.id) or exists (select 1 from suqa.driver_payouts p where p.driver_id = d.id);
  if v_used then
    update suqa.shop_drivers set active = false, available = false where id = d.id;
  else
    delete from suqa.shop_drivers where id = d.id;
  end if;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after)
  values (d.shop_id, d.tenant_id, auth.uid(), 'driver.remove', 'shop_drivers', d.id::text, jsonb_build_object('name', d.name, 'deleted', not v_used, 'deactivated', v_used, 'by', 'association'));
  return jsonb_build_object('ok', true, 'deleted', not v_used, 'deactivated', v_used);
end $function$;
revoke all on function suqa.admin_driver_remove(uuid) from public, anon;
grant execute on function suqa.admin_driver_remove(uuid) to authenticated;
