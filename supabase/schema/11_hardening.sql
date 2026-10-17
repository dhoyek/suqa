-- 11_hardening.sql — column guards & abuse limits                    (2026-10-17)
-- RLS says WHO may touch a row; these BEFORE UPDATE triggers say WHICH COLUMNS they may change.
-- Guards apply to end users only (PostgREST roles anon/authenticated). The SQL editor (postgres),
-- the service role and platform admins bypass them. The guard functions are deliberately NOT
-- security definer so that current_user is the real caller role.

create or replace function suqa._guards_apply() returns boolean
language sql stable as $$
  select current_user in ('anon', 'authenticated') and not suqa.is_platform_admin()
$$;

-- ---------- helper: which columns changed? ------------------------------------
create or replace function suqa._changed_cols(o jsonb, n jsonb) returns text[]
language sql immutable as $$
  select coalesce(array_agg(k order by k), '{}') from (
    select key as k from jsonb_each(n) where o -> key is distinct from n -> key
  ) s
$$;

-- ---------- orders: snapshot stays frozen; only workflow columns move ----------
-- NB: superseded by the version in 14_couriers.sql (adds courier rules); kept for readability.
create or replace function suqa.orders_guard_columns() returns trigger
language plpgsql set search_path = public as $$
declare
  v_changed text[];
  v_allowed text[];
  v_auto    text[] := array['updated_at','accepted_at','delivered_at','closed_at'];
begin
  if not suqa._guards_apply() then return new; end if;

  v_changed := suqa._changed_cols(to_jsonb(old), to_jsonb(new));
  v_changed := array(select unnest(v_changed) except select unnest(v_auto));

  if suqa.is_tenant_member(new.tenant_id) or suqa.is_shop_member(new.shop_id) then
    v_allowed := array['status','reject_reason','shop_notes','eta_minutes'];
  elsif auth.uid() = new.customer_id then
    v_allowed := array['status'];
  else
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from unnest(v_changed) c where c <> all (v_allowed)) then
    raise exception 'order_locked' using errcode = 'check_violation',
      detail = array_to_string(array(select unnest(v_changed) except select unnest(v_allowed)), ',');
  end if;
  return new;
end $$;
drop trigger if exists orders_0_guard on suqa.orders;
create trigger orders_0_guard before update on suqa.orders
  for each row execute function suqa.orders_guard_columns();   -- "0_" so it fires before orders_status_change

-- ---------- shops: merchants edit their storefront, not their contract --------
create or replace function suqa.shops_guard_columns() returns trigger
language plpgsql set search_path = public as $$
declare v_changed text[];
begin
  if not suqa._guards_apply() or suqa.is_tenant_member(new.tenant_id) then return new; end if;

  v_changed := suqa._changed_cols(to_jsonb(old), to_jsonb(new));
  if v_changed && array['tenant_id','slug','commission_rate','sort_order','category_id','created_at'] then
    raise exception 'shop_locked' using errcode = 'check_violation';
  end if;
  -- merchants may only flip between active and paused (never leave pending/disabled on their own)
  if new.status is distinct from old.status
     and not (old.status in ('active','paused') and new.status in ('active','paused')) then
    raise exception 'shop_status_locked' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists shops_guard on suqa.shops;
create trigger shops_guard before update on suqa.shops
  for each row execute function suqa.shops_guard_columns();

-- ---------- tenants: association admins brand & configure; identity is platform-owned
create or replace function suqa.tenants_guard_columns() returns trigger
language plpgsql set search_path = public as $$
declare v_changed text[];
begin
  if not suqa._guards_apply() then return new; end if;
  v_changed := suqa._changed_cols(to_jsonb(old), to_jsonb(new));
  if v_changed && array['id','slug','status','country_code','created_at'] then
    raise exception 'tenant_locked' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists tenants_guard on suqa.tenants;
create trigger tenants_guard before update on suqa.tenants
  for each row execute function suqa.tenants_guard_columns();

-- ---------- tenant_members: never remove / demote the last admin -------------
create or replace function suqa.tenant_members_keep_admin() returns trigger
language plpgsql set search_path = public as $$
declare v_tenant uuid := coalesce(old.tenant_id, new.tenant_id);
begin
  if current_user not in ('anon', 'authenticated') then return coalesce(new, old); end if;  -- platform/SQL editor may
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin') then
    if not exists (select 1 from suqa.tenant_members
                    where tenant_id = v_tenant and role = 'admin' and user_id <> old.user_id) then
      raise exception 'last_admin' using errcode = 'check_violation';
    end if;
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists tenant_members_keep_admin on suqa.tenant_members;
create trigger tenant_members_keep_admin before update or delete on suqa.tenant_members
  for each row execute function suqa.tenant_members_keep_admin();

-- ---------- profiles: users may not re-home themselves to another tenant ------
create or replace function suqa.profiles_guard_columns() returns trigger
language plpgsql set search_path = public as $$
begin
  if not suqa._guards_apply() then return new; end if;
  if new.home_tenant_id is distinct from old.home_tenant_id and old.home_tenant_id is not null then
    raise exception 'profile_locked' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard on suqa.profiles;
create trigger profiles_guard before update on suqa.profiles
  for each row execute function suqa.profiles_guard_columns();

-- ---------- order_events: notes only, from the people on the order -----------
-- (insert policy already restricts; make sure nobody edits history)
revoke update, delete on suqa.order_events from anon, authenticated;
revoke insert, update, delete on suqa.order_items from anon, authenticated;
revoke insert, delete on suqa.orders from anon, authenticated;
revoke all on suqa.order_counters from anon, authenticated;

select 'hardening installed' as result;
