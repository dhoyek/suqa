-- 116: the association's admins see every driver of every shop and decide who is shared (Admin → Drivers).
--   admin_drivers(tenant)             association member (admin / ops) or platform admin: every shop's drivers — name, phone,
--                                     vehicle, his shop, active, scope ('shop' = for his shop only, 'association' = other shops may
--                                     add him), whether he has an account, when last used — and the association's own couriers.
--                                     NO money: not what a shop pays its driver, no settlements, no cash.
--   admin_driver_scope(driver, scope) association ADMIN only: sets one driver row to 'shop' or 'association'. The shop's tills
--                                     receive the change by sync (shop_drivers is in the sync log); written in the audit log.
--                                     Making a driver "shop only" does not remove him from shops that already added him.
-- No table change. Safe to run twice.

create or replace function suqa.admin_drivers(p_tenant uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is null or not suqa.is_tenant_member(p_tenant) then raise exception 'not_allowed' using errcode = 'insufficient_privilege'; end if;
  return jsonb_build_object(
    'drivers', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', d.id, 'shop_id', d.shop_id, 'shop', s.name, 'name', d.name, 'phone', d.phone, 'phone_key', d.phone_key, 'vehicle', d.vehicle,
                  'active', d.active, 'scope', d.scope, 'has_account', d.user_id is not null, 'last_used_at', d.last_used_at)
                  order by d.name, s.sort_order), '[]')
                  from suqa.shop_drivers d join suqa.shops s on s.id = d.shop_id where d.tenant_id = p_tenant),
    'couriers', (select coalesce(jsonb_agg(jsonb_build_object(
                  'user_id', c.user_id, 'name', coalesce(nullif(trim(pr.full_name), ''), pr.phone), 'phone', pr.phone, 'vehicle', c.vehicle, 'active', c.is_active)
                  order by pr.full_name), '[]')
                  from suqa.couriers c left join suqa.profiles pr on pr.id = c.user_id where c.tenant_id = p_tenant));
end $function$;
revoke all on function suqa.admin_drivers(uuid) from public, anon;
grant execute on function suqa.admin_drivers(uuid) to authenticated;

create or replace function suqa.admin_driver_scope(p_driver uuid, p_scope text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare d suqa.shop_drivers;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if p_scope is null or p_scope not in ('shop', 'association') then raise exception 'bad_scope'; end if;
  select * into d from suqa.shop_drivers where id = p_driver for update;
  if not found then raise exception 'driver_not_found'; end if;
  if not suqa.is_tenant_admin(d.tenant_id) then raise exception 'not_allowed' using errcode = 'insufficient_privilege'; end if;
  if d.scope = p_scope then return jsonb_build_object('ok', true, 'noop', true, 'scope', d.scope); end if;
  update suqa.shop_drivers set scope = p_scope where id = d.id;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after)
  values (d.shop_id, d.tenant_id, auth.uid(), 'driver.scope', 'shop_drivers', d.id::text,
          jsonb_build_object('name', d.name, 'from', d.scope, 'scope', p_scope, 'by', 'association'));
  return jsonb_build_object('ok', true, 'scope', p_scope);
end $function$;
revoke all on function suqa.admin_driver_scope(uuid, text) from public, anon;
grant execute on function suqa.admin_driver_scope(uuid, text) to authenticated;
