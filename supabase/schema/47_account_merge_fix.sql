-- 47_account_merge_fix.sql — merge actually completes, and carries sign-in credentials across.
-- Bug: admin_account_merge moved every row off the duplicate and then called admin_account_delete, whose
-- "is this account in the tenant" check no longer passed → exception → whole merge rolled back.
-- Fix: the delete body becomes _account_delete_impl (no membership check); admin_account_delete wraps it with the checks.
-- Also: when the kept account has no email (or no phone) and the duplicate has one, the identity moves over, so after a
-- merge the person can sign in both by WhatsApp number and by email + password. Requires 45.

create or replace function suqa._account_delete_impl(p_tenant uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_before jsonb;
begin
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
  delete from auth.refresh_tokens where user_id = p_user::text;
  delete from auth.sessions where user_id = p_user;
  perform suqa._account_audit(p_tenant, 'account.delete', p_user, v_before, null);
end $$;

create or replace function suqa.admin_account_delete(p_tenant uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform suqa._admin_guard(p_tenant);
  if not suqa._account_in_tenant(p_tenant, p_user) then raise exception 'not_in_tenant'; end if;
  if p_user = auth.uid() then raise exception 'cannot_delete_self'; end if;
  if exists (select 1 from suqa.platform_admins where user_id = p_user) then raise exception 'cannot_delete_platform_admin'; end if;
  perform suqa._account_delete_impl(p_tenant, p_user);
  return jsonb_build_object('ok', true);
end $$;

create or replace function suqa.admin_account_merge(p_tenant uuid, p_keep uuid, p_dup uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; v_rank jsonb := '{"owner":3,"cashier":2,"staff":2,"stock":1}'::jsonb; v_moved jsonb; k auth.users; d auth.users; v_cred text[] := '{}';
begin
  perform suqa._admin_guard(p_tenant);
  if p_keep = p_dup then raise exception 'same_account'; end if;
  if not suqa._account_in_tenant(p_tenant, p_keep) or not suqa._account_in_tenant(p_tenant, p_dup) then raise exception 'not_in_tenant'; end if;
  if p_dup = auth.uid() then raise exception 'cannot_merge_self'; end if;
  if exists (select 1 from suqa.platform_admins where user_id = p_dup) then raise exception 'cannot_merge_platform_admin'; end if;
  select * into k from auth.users where id = p_keep; select * into d from auth.users where id = p_dup;

  -- credentials: the kept account inherits whichever sign-in method it lacks
  if k.email is null and d.email is not null then
    update auth.users set email = null where id = p_dup;                                    -- unique(email): free it first
    update auth.users set email = d.email, encrypted_password = coalesce(encrypted_password, d.encrypted_password),
           email_confirmed_at = coalesce(email_confirmed_at, d.email_confirmed_at), updated_at = now() where id = p_keep;
    update auth.identities set user_id = p_keep, provider_id = p_keep::text, identity_data = identity_data || jsonb_build_object('sub', p_keep::text), updated_at = now()
     where user_id = p_dup and provider = 'email';
    v_cred := array_append(v_cred, 'email');
  end if;
  if k.phone is null and d.phone is not null then
    update auth.users set phone = null where id = p_dup;
    update auth.users set phone = d.phone, phone_confirmed_at = coalesce(phone_confirmed_at, d.phone_confirmed_at), updated_at = now() where id = p_keep;
    update suqa.profiles set phone = d.phone where id = p_keep and phone is null;
    update auth.identities set user_id = p_keep, provider_id = p_keep::text, identity_data = identity_data || jsonb_build_object('sub', p_keep::text), updated_at = now()
     where user_id = p_dup and provider = 'phone';
    v_cred := array_append(v_cred, 'phone');
  end if;

  -- history
  update suqa.orders set customer_id = p_keep where tenant_id = p_tenant and customer_id = p_dup;
  v_moved := jsonb_build_object('orders', (select count(*) from suqa.orders where tenant_id = p_tenant and customer_id = p_keep), 'credentials', to_jsonb(v_cred));
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
  -- drivers / couriers / requests / devices
  update suqa.shop_drivers set user_id = p_keep where tenant_id = p_tenant and user_id = p_dup;
  update suqa.couriers set user_id = p_keep where tenant_id = p_tenant and user_id = p_dup
     and not exists (select 1 from suqa.couriers c2 where c2.tenant_id = p_tenant and c2.user_id = p_keep);
  delete from suqa.couriers where tenant_id = p_tenant and user_id = p_dup;
  update suqa.access_requests set user_id = p_keep where tenant_id = p_tenant and user_id = p_dup
     and not exists (select 1 from suqa.access_requests a2 where a2.shop_id = suqa.access_requests.shop_id and a2.user_id = p_keep and a2.status = 'pending');
  delete from suqa.access_requests where tenant_id = p_tenant and user_id = p_dup;
  update suqa.devices set registered_by = p_keep where tenant_id = p_tenant and registered_by = p_dup;
  -- name: keep's unless empty
  update suqa.profiles kp set full_name = coalesce(nullif(kp.full_name, ''), dp.full_name) from suqa.profiles dp where kp.id = p_keep and dp.id = p_dup;

  perform suqa._account_audit(p_tenant, 'account.merge', p_keep, jsonb_build_object('merged_from', p_dup), v_moved);
  perform suqa._account_delete_impl(p_tenant, p_dup);
  return jsonb_build_object('ok', true, 'kept', p_keep, 'merged', p_dup) || v_moved;
end $$;

grant execute on function suqa._account_in_tenant(uuid, uuid) to authenticated;   -- used by the admin credentials route

select 'merge fix installed' as result;
