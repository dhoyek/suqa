-- 45_account_admin.sql — Admin → Accounts is the one place to manage people:
--   admin_account_block(tenant, user, block, reason)      sign-in blocked (auth.users.banned_until) / unblocked; memberships kept
--   admin_account_delete(tenant, user)                    anonymised + blocked, roles and driver links removed; orders/debts kept
--   admin_account_merge(tenant, keep, dup)                everything on the duplicate moves to the kept account; duplicate deleted as above
--   admin_account_set_shop_role(tenant, user, shop, role) add / change / remove (role null) a shop membership
--   admin_account_set_tenant_role(tenant, user, role)     add / change / remove (role null) the association role
-- All admin-only (association admin or platform admin), all audit-logged. tenant_accounts (43) re-created to expose
-- blocked / deleted so the list can show them. Requires 43, 44.

create or replace function suqa._admin_guard(p_tenant uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from suqa.tenant_members tm where tm.tenant_id = p_tenant and tm.user_id = auth.uid() and tm.role = 'admin')
     and not suqa.is_platform_admin() then
    raise exception 'not_admin' using errcode = 'insufficient_privilege';
  end if;
end $$;

create or replace function suqa._account_in_tenant(p_tenant uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from suqa.tenant_members tm where tm.tenant_id = p_tenant and tm.user_id = p_user
    union all select 1 from suqa.shop_members sm join suqa.shops s on s.id = sm.shop_id where s.tenant_id = p_tenant and sm.user_id = p_user
    union all select 1 from suqa.shop_drivers d where d.tenant_id = p_tenant and d.user_id = p_user
    union all select 1 from suqa.access_requests ar where ar.tenant_id = p_tenant and ar.user_id = p_user
    union all select 1 from suqa.orders o where o.tenant_id = p_tenant and o.customer_id = p_user
    union all select 1 from suqa.couriers cp where cp.tenant_id = p_tenant and cp.user_id = p_user)
$$;

create or replace function suqa._account_audit(p_tenant uuid, p_action text, p_user uuid, p_before jsonb, p_after jsonb) returns void
language sql security definer set search_path = public as $$
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, before, after, acting_as_admin)
  values ('00000000-0000-0000-0000-000000000000', p_tenant, auth.uid(), p_action, 'auth.users', p_user::text, p_before, p_after, true)
$$;

-- ---------------------------------------------------------------------------------------------------------- block
create or replace function suqa.admin_account_block(p_tenant uuid, p_user uuid, p_block boolean, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform suqa._admin_guard(p_tenant);
  if not suqa._account_in_tenant(p_tenant, p_user) then raise exception 'not_in_tenant'; end if;
  if p_user = auth.uid() then raise exception 'cannot_block_self'; end if;
  update auth.users set banned_until = case when p_block then 'infinity'::timestamptz else null end, updated_at = now() where id = p_user;
  update suqa.profiles set updated_at = now() where id = p_user;
  perform suqa._account_audit(p_tenant, case when p_block then 'account.block' else 'account.unblock' end, p_user, null, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('ok', true, 'blocked', p_block);
end $$;
grant execute on function suqa.admin_account_block(uuid, uuid, boolean, text) to authenticated;

-- --------------------------------------------------------------------------------------------------------- delete
-- "Delete" keeps the row (orders, payments and debts reference it) but removes everything personal and every role:
-- name → '[deleted]', phone/email freed, sign-in blocked, memberships/driver/courier/admin rows gone.
create or replace function suqa.admin_account_delete(p_tenant uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_before jsonb;
begin
  perform suqa._admin_guard(p_tenant);
  if not suqa._account_in_tenant(p_tenant, p_user) then raise exception 'not_in_tenant'; end if;
  if p_user = auth.uid() then raise exception 'cannot_delete_self'; end if;
  if exists (select 1 from suqa.platform_admins where user_id = p_user) then raise exception 'cannot_delete_platform_admin'; end if;
  select jsonb_build_object('name', p.full_name, 'phone', u.phone, 'email', u.email) into v_before from auth.users u left join suqa.profiles p on p.id = u.id where u.id = p_user;
  delete from suqa.tenant_members where tenant_id = p_tenant and user_id = p_user;
  update suqa.shop_members sm set active = false, updated_at = now() from suqa.shops s where s.id = sm.shop_id and s.tenant_id = p_tenant and sm.user_id = p_user;
  update suqa.shop_drivers set user_id = null where tenant_id = p_tenant and user_id = p_user;
  delete from suqa.couriers where tenant_id = p_tenant and user_id = p_user;
  update suqa.access_requests set status = 'rejected', decided_at = now(), decided_by = auth.uid() where tenant_id = p_tenant and user_id = p_user and status = 'pending';
  update suqa.profiles set full_name = '[deleted]', phone = null, updated_at = now() where id = p_user;
  update auth.users set phone = null, email = null, banned_until = 'infinity'::timestamptz,
         raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('deleted_at', now(), 'deleted_by', auth.uid()), updated_at = now()
   where id = p_user;
  delete from auth.identities where user_id = p_user;
  delete from auth.sessions where user_id = p_user;
  perform suqa._account_audit(p_tenant, 'account.delete', p_user, v_before, null);
  return jsonb_build_object('ok', true);
end $$;
grant execute on function suqa.admin_account_delete(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------- merge
-- Move everything from p_dup onto p_keep, then delete p_dup as above. Shop memberships: union, higher role wins.
create or replace function suqa.admin_account_merge(p_tenant uuid, p_keep uuid, p_dup uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; v_rank jsonb := '{"owner":3,"cashier":2,"staff":2,"stock":1}'::jsonb; v_moved jsonb;
begin
  perform suqa._admin_guard(p_tenant);
  if p_keep = p_dup then raise exception 'same_account'; end if;
  if not suqa._account_in_tenant(p_tenant, p_keep) or not suqa._account_in_tenant(p_tenant, p_dup) then raise exception 'not_in_tenant'; end if;
  if p_dup = auth.uid() then raise exception 'cannot_merge_self'; end if;
  if exists (select 1 from suqa.platform_admins where user_id = p_dup) then raise exception 'cannot_merge_platform_admin'; end if;

  -- history
  update suqa.orders set customer_id = p_keep where tenant_id = p_tenant and customer_id = p_dup;
  v_moved := jsonb_build_object('orders', (select count(*) from suqa.orders where tenant_id = p_tenant and customer_id = p_keep));
  -- shop memberships (union, highest role, active if either was)
  for r in select sm.shop_id, sm.role, sm.active, sm.display_name, sm.pin_hash, sm.pin_salt, sm.pin_set_at from suqa.shop_members sm join suqa.shops s on s.id = sm.shop_id where s.tenant_id = p_tenant and sm.user_id = p_dup loop
    insert into suqa.shop_members (shop_id, user_id, role, display_name, active, pin_hash, pin_salt, pin_set_at)
    values (r.shop_id, p_keep, r.role, r.display_name, r.active, r.pin_hash, r.pin_salt, r.pin_set_at)
    on conflict (shop_id, user_id) do update
      set role = case when (v_rank->>excluded.role::text)::int > (v_rank->>suqa.shop_members.role::text)::int then excluded.role else suqa.shop_members.role end,
          active = suqa.shop_members.active or excluded.active,
          display_name = coalesce(suqa.shop_members.display_name, excluded.display_name),
          pin_hash = coalesce(suqa.shop_members.pin_hash, excluded.pin_hash), pin_salt = coalesce(suqa.shop_members.pin_salt, excluded.pin_salt),
          pin_set_at = coalesce(suqa.shop_members.pin_set_at, excluded.pin_set_at), updated_at = now();
  end loop;
  delete from suqa.shop_members sm using suqa.shops s where s.id = sm.shop_id and s.tenant_id = p_tenant and sm.user_id = p_dup;
  -- association role: keep the higher of the two
  insert into suqa.tenant_members (tenant_id, user_id, role)
  select tenant_id, p_keep, role from suqa.tenant_members where tenant_id = p_tenant and user_id = p_dup
  on conflict (tenant_id, user_id) do update set role = case when excluded.role = 'admin' then 'admin' else suqa.tenant_members.role end;
  delete from suqa.tenant_members where tenant_id = p_tenant and user_id = p_dup;
  -- drivers / couriers / requests
  update suqa.shop_drivers set user_id = p_keep where tenant_id = p_tenant and user_id = p_dup;
  update suqa.couriers set user_id = p_keep where tenant_id = p_tenant and user_id = p_dup
     and not exists (select 1 from suqa.couriers c2 where c2.tenant_id = p_tenant and c2.user_id = p_keep);
  delete from suqa.couriers where tenant_id = p_tenant and user_id = p_dup;
  update suqa.access_requests set user_id = p_keep where tenant_id = p_tenant and user_id = p_dup
     and not exists (select 1 from suqa.access_requests a2 where a2.shop_id = suqa.access_requests.shop_id and a2.user_id = p_keep and a2.status = 'pending');
  delete from suqa.access_requests where tenant_id = p_tenant and user_id = p_dup;
  -- name: keep's unless empty
  update suqa.profiles k set full_name = coalesce(nullif(k.full_name, ''), d.full_name) from suqa.profiles d where k.id = p_keep and d.id = p_dup;

  perform suqa._account_audit(p_tenant, 'account.merge', p_keep, jsonb_build_object('merged_from', p_dup), v_moved);
  perform suqa.admin_account_delete(p_tenant, p_dup);
  return jsonb_build_object('ok', true, 'kept', p_keep, 'merged', p_dup) || v_moved;
end $$;
grant execute on function suqa.admin_account_merge(uuid, uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------------------------------------- roles
create or replace function suqa.admin_account_set_shop_role(p_tenant uuid, p_user uuid, p_shop uuid, p_role text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_before text;
begin
  perform suqa._admin_guard(p_tenant);
  if not exists (select 1 from suqa.shops where id = p_shop and tenant_id = p_tenant) then raise exception 'shop_not_found'; end if;
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'user_not_found'; end if;
  select role::text into v_before from suqa.shop_members where shop_id = p_shop and user_id = p_user and active;
  if p_role is null then
    update suqa.shop_members set active = false, updated_at = now() where shop_id = p_shop and user_id = p_user;
  else
    if p_role not in ('owner','cashier','stock') then raise exception 'bad_role'; end if;
    insert into suqa.shop_members (shop_id, user_id, role, display_name, active)
    values (p_shop, p_user, p_role::suqa.shop_role, (select full_name from suqa.profiles where id = p_user), true)
    on conflict (shop_id, user_id) do update set role = excluded.role, active = true, updated_at = now();
  end if;
  perform suqa._account_audit(p_tenant, 'account.shop_role', p_user, jsonb_build_object('shop', p_shop, 'role', v_before), jsonb_build_object('shop', p_shop, 'role', p_role));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function suqa.admin_account_set_shop_role(uuid, uuid, uuid, text) to authenticated;

create or replace function suqa.admin_account_set_tenant_role(p_tenant uuid, p_user uuid, p_role text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_before text;
begin
  perform suqa._admin_guard(p_tenant);
  if p_user = auth.uid() and (p_role is null or p_role <> 'admin') then raise exception 'cannot_demote_self'; end if;
  select role::text into v_before from suqa.tenant_members where tenant_id = p_tenant and user_id = p_user;
  if p_role is null then
    delete from suqa.tenant_members where tenant_id = p_tenant and user_id = p_user;
  else
    if p_role not in ('admin','ops') then raise exception 'bad_role'; end if;
    insert into suqa.tenant_members (tenant_id, user_id, role) values (p_tenant, p_user, p_role::suqa.tenant_role)
    on conflict (tenant_id, user_id) do update set role = excluded.role;
  end if;
  perform suqa._account_audit(p_tenant, 'account.tenant_role', p_user, jsonb_build_object('role', v_before), jsonb_build_object('role', p_role));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function suqa.admin_account_set_tenant_role(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------- list (re-created)
create or replace function suqa.tenant_accounts(p_tenant uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not suqa.is_tenant_member(p_tenant) then raise exception 'not allowed' using errcode = 'insufficient_privilege'; end if;
  return (
    with people as (
      select tm.user_id from suqa.tenant_members tm where tm.tenant_id = p_tenant
      union select sm.user_id from suqa.shop_members sm join suqa.shops s on s.id = sm.shop_id where s.tenant_id = p_tenant
      union select d.user_id from suqa.shop_drivers d where d.tenant_id = p_tenant and d.user_id is not null
      union select ar.user_id from suqa.access_requests ar where ar.tenant_id = p_tenant
      union select o.customer_id from suqa.orders o where o.tenant_id = p_tenant and o.customer_id is not null
      union select cp.user_id from suqa.couriers cp where cp.tenant_id = p_tenant
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', u.id, 'name', p.full_name, 'phone', u.phone, 'email', u.email,
             'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at,
             'blocked', coalesce(u.banned_until > now(), false),
             'deleted', (u.raw_user_meta_data ? 'deleted_at'),
             'tenant_role', (select tm.role::text from suqa.tenant_members tm where tm.tenant_id = p_tenant and tm.user_id = u.id),
             'shops', (select coalesce(jsonb_agg(jsonb_build_object('shop_id', s.id, 'name', s.name, 'role', sm.role::text, 'active', sm.active) order by s.sort_order), '[]')
                         from suqa.shop_members sm join suqa.shops s on s.id = sm.shop_id where sm.user_id = u.id and s.tenant_id = p_tenant),
             'driver_for', (select coalesce(jsonb_agg(s.name order by s.sort_order), '[]') from suqa.shop_drivers d join suqa.shops s on s.id = d.shop_id where d.user_id = u.id and d.tenant_id = p_tenant and d.active),
             'courier', exists (select 1 from suqa.couriers cp where cp.user_id = u.id and cp.tenant_id = p_tenant),
             'orders', (select count(*) from suqa.orders o where o.customer_id = u.id and o.tenant_id = p_tenant),
             'pending_requests', (select count(*) from suqa.access_requests ar where ar.user_id = u.id and ar.tenant_id = p_tenant and ar.status = 'pending')
           ) order by coalesce(u.last_sign_in_at, u.created_at) desc), '[]')
      from people pe join auth.users u on u.id = pe.user_id left join suqa.profiles p on p.id = u.id
  );
end $$;
grant execute on function suqa.tenant_accounts(uuid) to authenticated;

-- shops the admin can assign (id + name), for the role editor
create or replace function suqa.tenant_shops_brief(p_tenant uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when suqa.is_tenant_member(p_tenant)
    then (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'pos', s.pos_enabled) order by s.sort_order), '[]') from suqa.shops s where s.tenant_id = p_tenant)
    else '[]'::jsonb end
$$;
grant execute on function suqa.tenant_shops_brief(uuid) to authenticated;

select 'account admin installed' as result;
