-- 51_account_phone_format.sql — one person, one account, whichever way they sign in.   (2026-11-11)
-- Bug: owners (POS → staff, 35) and admins (Admin → Accounts, 44) saved the login number into auth.users.phone as "+961…",
-- while WhatsApp/SMS sign-in stores and looks it up as "961…" (digits only). The lookup missed, so the first phone sign-in
-- of such an account created a second account (seen with Elie: email account + new phone account).
-- Fix: (1) both functions store digits only; (2) existing "+"-spelled numbers are normalised (unless another account already
-- holds the digits form — those are duplicates, listed at the end, to merge); (3) the merge carries the phone sign-in across when
-- both accounts hold the same number in different spellings. Re-creates pos_staff_phone (35), admin_account_update (44),
-- admin_account_merge (47). Requires 25 (_digits), 35, 44, 45, 47.

-- (1) store the login number digits-only
create or replace function suqa.pos_staff_phone(p_shop uuid, p_user uuid, p_phone text)
returns text language plpgsql security definer set search_path = public as $$
declare v_digits text := suqa._digits(p_phone); v_e164 text; v_tenant uuid; v_old text;
begin
  if suqa.pos_role(p_shop) <> 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  if not exists (select 1 from suqa.shop_members where shop_id = p_shop and user_id = p_user) then raise exception 'not_member'; end if;
  if v_digits is null or length(v_digits) < 8 then raise exception 'bad_phone'; end if;
  v_e164 := '+' || v_digits;
  if exists (select 1 from auth.users where id <> p_user and suqa._digits(phone) = v_digits) then raise exception 'phone_taken' using errcode = 'unique_violation'; end if;
  select phone into v_old from auth.users where id = p_user;
  update auth.users set phone = v_digits, phone_confirmed_at = coalesce(phone_confirmed_at, now()), updated_at = now() where id = p_user;   -- digits only: the format WhatsApp/SMS sign-in looks up
  update suqa.profiles set phone = v_e164, updated_at = now() where id = p_user;
  select tenant_id into v_tenant from suqa.shops where id = p_shop;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, before, after)
  values (p_shop, v_tenant, auth.uid(), 'staff.phone', 'shop_members', p_user::text, jsonb_build_object('phone', v_old), jsonb_build_object('phone', v_e164));
  return v_e164;
end $$;
revoke all on function suqa.pos_staff_phone(uuid, uuid, text) from public;
grant execute on function suqa.pos_staff_phone(uuid, uuid, text) to authenticated;

create or replace function suqa.admin_account_update(p_tenant uuid, p_user uuid, p_name text default null, p_phone text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_digits text; v_e164 text; v_old_phone text; v_old_name text; v_touched boolean := false;
begin
  if not exists (select 1 from suqa.tenant_members tm where tm.tenant_id = p_tenant and tm.user_id = auth.uid() and tm.role = 'admin')
     and not suqa.is_platform_admin() then
    raise exception 'not_admin' using errcode = 'insufficient_privilege';
  end if;
  -- the account must belong to this association (same set as tenant_accounts)
  if not exists (
    select 1 from suqa.tenant_members tm where tm.tenant_id = p_tenant and tm.user_id = p_user
    union all select 1 from suqa.shop_members sm join suqa.shops s on s.id = sm.shop_id where s.tenant_id = p_tenant and sm.user_id = p_user
    union all select 1 from suqa.shop_drivers d where d.tenant_id = p_tenant and d.user_id = p_user
    union all select 1 from suqa.access_requests ar where ar.tenant_id = p_tenant and ar.user_id = p_user
    union all select 1 from suqa.orders o where o.tenant_id = p_tenant and o.customer_id = p_user
    union all select 1 from suqa.couriers cp where cp.tenant_id = p_tenant and cp.user_id = p_user
  ) then raise exception 'not_in_tenant'; end if;

  select phone, full_name into v_old_phone, v_old_name from suqa.profiles where id = p_user;

  if p_name is not null then
    update suqa.profiles set full_name = nullif(trim(p_name), ''), updated_at = now() where id = p_user;
    update suqa.shop_members set display_name = coalesce(display_name, nullif(trim(p_name), '')) where user_id = p_user and display_name is null;
    v_touched := true;
  end if;

  if p_phone is not null and trim(p_phone) <> '' then
    v_digits := suqa._digits(p_phone);
    if v_digits is null or length(v_digits) < 8 then raise exception 'bad_phone'; end if;
    v_e164 := '+' || v_digits;
    if exists (select 1 from auth.users where id <> p_user and suqa._digits(phone) = v_digits) then raise exception 'phone_taken' using errcode = 'unique_violation'; end if;
    update auth.users set phone = v_digits, phone_confirmed_at = coalesce(phone_confirmed_at, now()), updated_at = now() where id = p_user;   -- digits only (sign-in format)
    update suqa.profiles set phone = v_e164, updated_at = now() where id = p_user;
    -- keep the shop address books / driver links in step (they match by digits)
    update suqa.shop_drivers set user_id = p_user where tenant_id = p_tenant and user_id is null and phone_key = v_digits;
    v_touched := true;
  end if;

  if v_touched then
    insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, before, after, acting_as_admin)
    values ('00000000-0000-0000-0000-000000000000', p_tenant, auth.uid(), 'account.update', 'profiles', p_user::text,
            jsonb_build_object('name', v_old_name, 'phone', v_old_phone), jsonb_build_object('name', p_name, 'phone', v_e164), true);
  end if;
  return jsonb_build_object('ok', true, 'phone', coalesce(v_e164, v_old_phone));
end $$;
revoke all on function suqa.admin_account_update(uuid, uuid, text, text) from public;
grant execute on function suqa.admin_account_update(uuid, uuid, text, text) to authenticated;

-- (3) merge carries the phone sign-in for same-number duplicates
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
  -- phone: also when both hold the same number in different spellings ("+961…" vs "961…") — the duplicate is usually
  -- the account the phone sign-in created because it could not find the "+"-spelled one
  if d.phone is not null and (k.phone is null or suqa._digits(k.phone) = suqa._digits(d.phone)) then
    update auth.users set phone = null where id = p_dup;
    update auth.users set phone = suqa._digits(d.phone), phone_confirmed_at = coalesce(phone_confirmed_at, d.phone_confirmed_at, now()), updated_at = now() where id = p_keep;
    update suqa.profiles set phone = '+' || suqa._digits(d.phone), updated_at = now() where id = p_keep;
    update auth.identities set user_id = p_keep, provider_id = p_keep::text, identity_data = identity_data || jsonb_build_object('sub', p_keep::text), updated_at = now()
     where user_id = p_dup and provider = 'phone' and not exists (select 1 from auth.identities x where x.user_id = p_keep and x.provider = 'phone');
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

-- (2) normalise existing numbers; skip any that would collide with another account (a duplicate to merge)
update auth.users u set phone = suqa._digits(u.phone), updated_at = now()
 where u.phone like '+%'
   and not exists (select 1 from auth.users o where o.id <> u.id and o.phone = suqa._digits(u.phone));

-- duplicates left for Admin → Accounts → merge (keep the older account)
select u.id as keep_candidate, u.email, u.phone, o.id as duplicate, o.phone as duplicate_phone, o.created_at as duplicate_created
  from auth.users u join auth.users o on o.id <> u.id and o.phone = suqa._digits(u.phone)
 where u.phone like '+%';
select 'account phone format installed' as result;
