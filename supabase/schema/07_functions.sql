-- 07_functions.sql — helpers, triggers, order numbering, state machine, place_order   (2026-10-16)

-- ---------- generic -------------------------------------------------------
create or replace function suqa.set_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

do $$ declare t text; begin
  foreach t in array array['tenants','profiles','shops','products','delivery_zones','addresses','orders'] loop
    execute format('drop trigger if exists set_updated_at on suqa.%I', t);
    execute format('create trigger set_updated_at before update on suqa.%I
                    for each row execute function suqa.set_updated_at()', t);
  end loop;
end $$;

-- ---------- auth → profile -----------------------------------------------
-- Sign-up passes { tenant_id, full_name, locale } in user metadata.
create or replace function suqa.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into suqa.profiles (id, home_tenant_id, full_name, phone, locale)
  values (
    new.id,
    nullif(new.raw_user_meta_data->>'tenant_id','')::uuid,
    new.raw_user_meta_data->>'full_name',
    new.phone,
    coalesce(new.raw_user_meta_data->>'locale','ar'))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function suqa.handle_new_user();

-- ---------- role checks (used by RLS; STABLE so they are evaluated once per query) ----
create or replace function suqa.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from suqa.platform_admins where user_id = auth.uid())
$$;

create or replace function suqa.is_tenant_member(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select suqa.is_platform_admin()
      or exists (select 1 from suqa.tenant_members
                  where tenant_id = p_tenant and user_id = auth.uid())
$$;

create or replace function suqa.is_tenant_admin(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select suqa.is_platform_admin()
      or exists (select 1 from suqa.tenant_members
                  where tenant_id = p_tenant and user_id = auth.uid() and role = 'admin')
$$;

create or replace function suqa.is_shop_member(p_shop uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from suqa.shop_members
                  where shop_id = p_shop and user_id = auth.uid())
$$;

create or replace function suqa.is_shop_owner(p_shop uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from suqa.shop_members
                  where shop_id = p_shop and user_id = auth.uid() and role = 'owner')
$$;

-- ---------- order numbering ------------------------------------------------
create or replace function suqa.next_order_number(p_tenant uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_prefix text; v_val bigint;
begin
  insert into suqa.order_counters (tenant_id, prefix, last_value)
    select id, upper(left(slug, 3)), 0 from suqa.tenants where id = p_tenant
  on conflict (tenant_id) do nothing;

  update suqa.order_counters set last_value = last_value + 1
   where tenant_id = p_tenant returning prefix, last_value into v_prefix, v_val;
  return v_prefix || '-' || lpad(v_val::text, 6, '0');
end $$;

-- ---------- order state machine --------------------------------------------
create or replace function suqa.order_transition_allowed(f suqa.order_status, t suqa.order_status)
returns boolean language sql immutable as $$
  select (f, t) in (
    ('pending','accepted'), ('pending','rejected'), ('pending','cancelled'),
    ('accepted','preparing'), ('accepted','cancelled'),
    ('preparing','ready'), ('preparing','cancelled'),
    ('ready','out_for_delivery'), ('ready','delivered'), ('ready','cancelled'),
    ('out_for_delivery','delivered'), ('out_for_delivery','cancelled'))
$$;

-- First event on insert (AFTER, so the order row exists for the FK).
create or replace function suqa.orders_on_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into suqa.order_events(order_id, tenant_id, from_status, to_status, actor_kind, actor_id)
  values (new.id, new.tenant_id, null, new.status, 'customer', new.customer_id);
  return new;
end $$;
drop trigger if exists orders_after_insert on suqa.orders;
create trigger orders_after_insert after insert on suqa.orders
  for each row execute function suqa.orders_on_insert();

-- Transitions on update (BEFORE, so we can validate and stamp timestamps).
-- NB: superseded by the version in 14_couriers.sql (adds the courier actor and picked_up_at); kept for readability.
create or replace function suqa.orders_on_status_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_actor suqa.actor_kind;
begin
  if new.status = old.status then return new; end if;

  if not suqa.order_transition_allowed(old.status, new.status) then
    raise exception 'order %: transition % → % not allowed', old.number, old.status, new.status
      using errcode = 'check_violation';
  end if;

  -- who is doing this?
  v_actor := case
    when suqa.is_platform_admin()             then 'platform'
    when suqa.is_tenant_member(new.tenant_id) then 'tenant'
    when suqa.is_shop_member(new.shop_id)     then 'shop'
    when auth.uid() = new.customer_id         then 'customer'
    else 'system' end;

  -- customers may only cancel while pending
  if v_actor = 'customer' and not (old.status = 'pending' and new.status = 'cancelled') then
    raise exception 'customers can only cancel a pending order' using errcode = 'insufficient_privilege';
  end if;

  if new.status = 'accepted'  then new.accepted_at  = coalesce(new.accepted_at, now()); end if;
  if new.status = 'delivered' then new.delivered_at = coalesce(new.delivered_at, now()); end if;
  if new.status in ('delivered','rejected','cancelled') then new.closed_at = coalesce(new.closed_at, now()); end if;

  insert into suqa.order_events(order_id, tenant_id, from_status, to_status, actor_kind, actor_id, note)
  values (new.id, new.tenant_id, old.status, new.status, v_actor, auth.uid(),
          case when new.status = 'rejected' then new.reject_reason end);
  return new;
end $$;
drop trigger if exists orders_status_change on suqa.orders;
create trigger orders_status_change before update of status on suqa.orders
  for each row execute function suqa.orders_on_status_change();

-- ---------- zone lookup ------------------------------------------------------
create or replace function suqa.find_zone(p_tenant uuid, p_shop uuid, p_point geography)
returns table (zone_id uuid, fee_usd numeric, eta_minutes int)
language sql stable security definer set search_path = public as $$
  select z.id, coalesce(sz.fee_usd, z.fee_usd), z.eta_minutes
    from suqa.delivery_zones z
    join suqa.shop_delivery_zones sz on sz.zone_id = z.id and sz.shop_id = p_shop
   where z.tenant_id = p_tenant and z.is_active
     and st_covers(z.area, p_point)
   order by z.sort_order limit 1
$$;

-- ---------- place_order / place_basket -----------------------------------------
-- Moved to 12_baskets.sql (shared implementation for single-shop orders and multi-shop baskets).
