-- 44_admin_accounts.sql — association admins can correct an account's name and phone number from Admin → Accounts.
-- Same rules as the shop-owner version (35): the number must not belong to another account; nothing is merged.
-- Requires 10 (is_tenant_member, tenant_role), 43 (tenant_accounts).

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
    update auth.users set phone = v_e164, phone_confirmed_at = coalesce(phone_confirmed_at, now()), updated_at = now() where id = p_user;
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

select 'admin accounts installed' as result;
