-- 46_account_ops.sql — more account operations for Admin → Accounts:
--   admin_account_signout(tenant, user)              sign out everywhere (sessions + refresh tokens dropped)
--   admin_account_reset_pin(tenant, user)            clears the POS PIN in every shop of the association; set anew on next unlock
--   admin_account_activity(tenant, user)             sign-ins, sessions, devices registered, recent orders, audit trail about them
--   admin_account_invite(tenant, phone, name, tenant_role, shop, shop_role)
--                                                    pre-register a number: association role and/or shop role applied on first sign-in
--   account_invites                                  tenant-level invites (shop-level ones reuse staff_invites from 25)
--   tenant_accounts_export(tenant)                   flat rows for the CSV export
-- Requires 45. "View as" (read-only) is an app route that reads with these same RPCs; every use is audit-logged there.

-- ------------------------------------------------------------------------------------------------- sign out everywhere
create or replace function suqa.admin_account_signout(p_tenant uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform suqa._admin_guard(p_tenant);
  if not suqa._account_in_tenant(p_tenant, p_user) then raise exception 'not_in_tenant'; end if;
  delete from auth.refresh_tokens where user_id = p_user::text;
  delete from auth.sessions where user_id = p_user; get diagnostics n = row_count;
  perform suqa._account_audit(p_tenant, 'account.signout_all', p_user, null, jsonb_build_object('sessions', n));
  return jsonb_build_object('ok', true, 'sessions', n);
end $$;
grant execute on function suqa.admin_account_signout(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------------------------------- reset POS PIN
create or replace function suqa.admin_account_reset_pin(p_tenant uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform suqa._admin_guard(p_tenant);
  update suqa.shop_members sm set pin_hash = null, pin_salt = null, pin_set_at = null, updated_at = now()
    from suqa.shops s where s.id = sm.shop_id and s.tenant_id = p_tenant and sm.user_id = p_user;
  get diagnostics n = row_count;
  perform suqa._account_audit(p_tenant, 'account.reset_pin', p_user, null, jsonb_build_object('shops', n));
  return jsonb_build_object('ok', true, 'shops', n);
end $$;
grant execute on function suqa.admin_account_reset_pin(uuid, uuid) to authenticated;

-- ------------------------------------------------------------------------------------------------------- activity
create or replace function suqa.admin_account_activity(p_tenant uuid, p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform suqa._admin_guard(p_tenant);
  if not suqa._account_in_tenant(p_tenant, p_user) then raise exception 'not_in_tenant'; end if;
  return jsonb_build_object(
    'user', (select jsonb_build_object('id', u.id, 'name', p.full_name, 'phone', u.phone, 'email', u.email, 'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at,
                                       'blocked', coalesce(u.banned_until > now(), false), 'deleted', (u.raw_user_meta_data ? 'deleted_at'), 'locale', p.locale)
               from auth.users u left join suqa.profiles p on p.id = u.id where u.id = p_user),
    'sessions', (select coalesce(jsonb_agg(jsonb_build_object('created_at', s.created_at, 'updated_at', s.updated_at, 'user_agent', s.user_agent, 'ip', s.ip::text) order by s.updated_at desc), '[]')
                   from (select * from auth.sessions where user_id = p_user order by updated_at desc limit 10) s),
    'devices', (select coalesce(jsonb_agg(jsonb_build_object('name', d.name, 'shop', s.name, 'registered_at', d.registered_at, 'last_sync_at', d.last_sync_at, 'revoked', d.revoked_at is not null) order by d.registered_at desc), '[]')
                  from suqa.devices d join suqa.shops s on s.id = d.shop_id where d.registered_by = p_user and d.tenant_id = p_tenant),
    'orders', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'number', o.number, 'shop', s.name, 'status', o.status, 'total_usd', o.total_usd, 'placed_at', o.placed_at) order by o.placed_at desc), '[]')
                 from (select * from suqa.orders where customer_id = p_user and tenant_id = p_tenant order by placed_at desc limit 20) o join suqa.shops s on s.id = o.shop_id),
    'orders_total', (select count(*) from suqa.orders where customer_id = p_user and tenant_id = p_tenant),
    'audit', (select coalesce(jsonb_agg(jsonb_build_object('at', a.at, 'action', a.action, 'by', coalesce(pb.full_name, a.user_id::text), 'before', a.before, 'after', a.after) order by a.at desc), '[]')
                from (select * from suqa.audit_log where tenant_id = p_tenant and ((ref_tbl in ('auth.users','profiles','shop_members') and ref_id = p_user::text) or user_id = p_user) order by at desc limit 50) a
                left join suqa.profiles pb on pb.id = a.user_id),
    'roles', (select jsonb_build_object(
                'tenant_role', (select tm.role::text from suqa.tenant_members tm where tm.tenant_id = p_tenant and tm.user_id = p_user),
                'shops', (select coalesce(jsonb_agg(jsonb_build_object('shop', s.name, 'role', sm.role::text, 'active', sm.active, 'pin_set', sm.pin_hash is not null)), '[]')
                            from suqa.shop_members sm join suqa.shops s on s.id = sm.shop_id where sm.user_id = p_user and s.tenant_id = p_tenant),
                'driver_for', (select coalesce(jsonb_agg(s.name), '[]') from suqa.shop_drivers d join suqa.shops s on s.id = d.shop_id where d.user_id = p_user and d.tenant_id = p_tenant),
                'courier', exists (select 1 from suqa.couriers c where c.user_id = p_user and c.tenant_id = p_tenant)))
  );
end $$;
grant execute on function suqa.admin_account_activity(uuid, uuid) to authenticated;

-- --------------------------------------------------------------------------------------------------------- invites
create table if not exists suqa.account_invites (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references suqa.tenants(id) on delete cascade,
  phone       text not null,                          -- digits only
  name        text,
  tenant_role suqa.tenant_role,                       -- null = no association role
  invited_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  claimed_by  uuid references auth.users(id) on delete set null
);
create index if not exists account_invites_phone_idx on suqa.account_invites(phone) where claimed_at is null;
alter table suqa.account_invites enable row level security;

-- One call pre-registers a number: optional association role (account_invites) and/or a shop role (staff_invites, 25).
-- If the account already exists, both are applied immediately.
create or replace function suqa.admin_account_invite(p_tenant uuid, p_phone text, p_name text default null, p_tenant_role text default null, p_shop uuid default null, p_shop_role text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_digits text; v_user uuid; v_name text := nullif(trim(coalesce(p_name, '')), '');
begin
  perform suqa._admin_guard(p_tenant);
  v_digits := suqa._digits(p_phone);
  if v_digits is null or length(v_digits) < 8 then raise exception 'bad_phone'; end if;
  if p_tenant_role is not null and p_tenant_role not in ('admin','ops') then raise exception 'bad_role'; end if;
  if p_shop is not null then
    if not exists (select 1 from suqa.shops where id = p_shop and tenant_id = p_tenant) then raise exception 'shop_not_found'; end if;
    if p_shop_role is null or p_shop_role not in ('owner','cashier','stock') then raise exception 'bad_role'; end if;
  end if;
  if p_tenant_role is null and p_shop is null then raise exception 'nothing_to_invite'; end if;
  select id into v_user from auth.users where suqa._digits(phone) = v_digits limit 1;

  if v_user is not null then
    if p_tenant_role is not null then perform suqa.admin_account_set_tenant_role(p_tenant, v_user, p_tenant_role); end if;
    if p_shop is not null then perform suqa.admin_account_set_shop_role(p_tenant, v_user, p_shop, p_shop_role); end if;
    if v_name is not null then update suqa.profiles set full_name = coalesce(full_name, v_name) where id = v_user; end if;
    return jsonb_build_object('status', 'applied', 'user_id', v_user);
  end if;

  if p_tenant_role is not null then
    insert into suqa.account_invites (tenant_id, phone, name, tenant_role, invited_by) values (p_tenant, v_digits, v_name, p_tenant_role::suqa.tenant_role, auth.uid());
  end if;
  if p_shop is not null then
    insert into suqa.staff_invites (shop_id, tenant_id, phone, display_name, role, invited_by) values (p_shop, p_tenant, v_digits, v_name, p_shop_role::suqa.shop_role, auth.uid());
  end if;
  perform suqa._account_audit(p_tenant, 'account.invite', auth.uid(), null, jsonb_build_object('phone', v_digits, 'name', v_name, 'tenant_role', p_tenant_role, 'shop', p_shop, 'shop_role', p_shop_role));
  return jsonb_build_object('status', 'invited', 'phone', v_digits);
end $$;
grant execute on function suqa.admin_account_invite(uuid, text, text, text, uuid, text) to authenticated;

-- pending invites (for the list), and cancel
create or replace function suqa.admin_account_invites(p_tenant uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform suqa._admin_guard(p_tenant);
  return (select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]') from (
    select jsonb_build_object('id', i.id, 'kind', 'tenant', 'phone', i.phone, 'name', i.name, 'role', i.tenant_role::text, 'created_at', i.created_at) x
      from suqa.account_invites i where i.tenant_id = p_tenant and i.claimed_at is null
    union all
    select jsonb_build_object('id', i.id, 'kind', 'shop', 'phone', i.phone, 'name', i.display_name, 'role', i.role::text, 'shop', s.name, 'created_at', i.created_at)
      from suqa.staff_invites i join suqa.shops s on s.id = i.shop_id where i.tenant_id = p_tenant and i.claimed_at is null) q);
end $$;
grant execute on function suqa.admin_account_invites(uuid) to authenticated;

create or replace function suqa.admin_account_invite_cancel(p_tenant uuid, p_kind text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform suqa._admin_guard(p_tenant);
  if p_kind = 'tenant' then delete from suqa.account_invites where id = p_id and tenant_id = p_tenant and claimed_at is null;
  else delete from suqa.staff_invites where id = p_id and tenant_id = p_tenant and claimed_at is null; end if;
end $$;
grant execute on function suqa.admin_account_invite_cancel(uuid, text, uuid) to authenticated;

-- Claim tenant-level invites on first sign-in / phone change (shop invites are claimed by the 25 triggers).
create or replace function suqa.claim_account_invites() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.phone is null or (tg_op = 'UPDATE' and new.phone is not distinct from old.phone) then return new; end if;
  insert into suqa.tenant_members (tenant_id, user_id, role)
  select i.tenant_id, new.id, i.tenant_role from suqa.account_invites i where i.phone = suqa._digits(new.phone) and i.claimed_at is null and i.tenant_role is not null
  on conflict (tenant_id, user_id) do update set role = case when excluded.role = 'admin' then 'admin' else suqa.tenant_members.role end;
  update suqa.profiles p set full_name = coalesce(p.full_name, i.name) from suqa.account_invites i where p.id = new.id and i.phone = suqa._digits(new.phone) and i.claimed_at is null;
  update suqa.account_invites set claimed_at = now(), claimed_by = new.id where phone = suqa._digits(new.phone) and claimed_at is null;
  return new;
end $$;
drop trigger if exists on_auth_user_account_invites on auth.users;
create trigger on_auth_user_account_invites after insert or update of phone on auth.users
  for each row execute function suqa.claim_account_invites();

-- ---------------------------------------------------------------------------------------------------------- export
create or replace function suqa.tenant_accounts_export(p_tenant uuid)
returns table (name text, phone text, email text, created_at timestamptz, last_sign_in_at timestamptz, tenant_role text, shop_roles text, driver_for text, courier boolean, orders bigint, blocked boolean, deleted boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform suqa._admin_guard(p_tenant);
  return query
    select (a->>'name'), (a->>'phone'), (a->>'email'), (a->>'created_at')::timestamptz, (a->>'last_sign_in_at')::timestamptz, (a->>'tenant_role'),
           (select string_agg((s->'name'->>'ar') || ':' || (s->>'role'), '; ') from jsonb_array_elements(a->'shops') s where (s->>'active')::boolean),
           (select string_agg(d->>'ar', '; ') from jsonb_array_elements(a->'driver_for') d),
           (a->>'courier')::boolean, (a->>'orders')::bigint, (a->>'blocked')::boolean, (a->>'deleted')::boolean
      from jsonb_array_elements(suqa.tenant_accounts(p_tenant)) a;
end $$;
grant execute on function suqa.tenant_accounts_export(uuid) to authenticated;


-- "view as": the activity page logs every open so support access is traceable
create or replace function suqa.admin_account_view_log(p_tenant uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform suqa._admin_guard(p_tenant);
  perform suqa._account_audit(p_tenant, 'account.view', p_user, null, null);
end $$;
grant execute on function suqa.admin_account_view_log(uuid, uuid) to authenticated;

select 'account ops installed' as result;
