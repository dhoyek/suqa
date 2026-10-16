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

-- ---------- place_order (the only way a customer creates an order) -----------
-- Prices, fees and totals are computed here from the database, never trusted from the client.
-- p_items: [{ "product_id": "...", "quantity": 2, "notes": "..." }]
create or replace function suqa.place_order(
  p_shop uuid, p_address_id uuid, p_items jsonb, p_notes text default null)
returns suqa.orders
language plpgsql security definer set search_path = public as $$
declare
  v_shop suqa.shops; v_tenant suqa.tenants; v_addr suqa.addresses; v_order suqa.orders;
  v_zone record; v_item jsonb; v_prod suqa.products; v_qty numeric; v_sub numeric := 0;
  v_rate numeric;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode='insufficient_privilege'; end if;

  select * into v_shop from suqa.shops where id = p_shop and status = 'active';
  if not found then raise exception 'shop not available'; end if;
  select * into v_tenant from suqa.tenants where id = v_shop.tenant_id and status = 'live';
  if not found then raise exception 'tenant not live'; end if;
  select * into v_addr from suqa.addresses where id = p_address_id and user_id = auth.uid() and tenant_id = v_tenant.id;
  if not found then raise exception 'address not found'; end if;

  select * into v_zone from suqa.find_zone(v_tenant.id, v_shop.id, v_addr.location);
  if v_zone.zone_id is null then raise exception 'address outside delivery area'; end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'empty order';
  end if;

  -- subtotal
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from suqa.products
     where id = (v_item->>'product_id')::uuid and shop_id = v_shop.id and is_active and is_available;
    if not found then raise exception 'product % unavailable', v_item->>'product_id'; end if;
    v_qty := (v_item->>'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'bad quantity'; end if;
    v_sub := v_sub + round(v_prod.price_usd * v_qty, 2);
  end loop;

  if v_sub < v_shop.min_order_usd then
    raise exception 'minimum order is % USD', v_shop.min_order_usd;
  end if;

  v_rate := coalesce(v_shop.commission_rate, v_tenant.commission_rate);

  insert into suqa.orders (
    tenant_id, shop_id, customer_id, number, zone_id, address, customer_name, customer_phone,
    customer_notes, subtotal_usd, delivery_fee_usd, total_usd, fx_lbp_rate,
    commission_rate, commission_usd, eta_minutes)
  values (
    v_tenant.id, v_shop.id, auth.uid(), suqa.next_order_number(v_tenant.id), v_zone.zone_id,
    to_jsonb(v_addr) - 'user_id',
    coalesce((select full_name from suqa.profiles where id = auth.uid()), ''),
    coalesce(v_addr.phone, (select phone from suqa.profiles where id = auth.uid()), ''),
    p_notes, v_sub, v_zone.fee_usd, v_sub + v_zone.fee_usd, v_tenant.fx_lbp_rate,
    v_rate, round(v_sub * v_rate, 2), coalesce(v_zone.eta_minutes, 0) + v_shop.prep_minutes)
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from suqa.products where id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    insert into suqa.order_items (order_id, tenant_id, product_id, name, unit, unit_price_usd, quantity, line_total_usd, notes)
    values (v_order.id, v_tenant.id, v_prod.id, v_prod.name, v_prod.unit, v_prod.price_usd, v_qty,
            round(v_prod.price_usd * v_qty, 2), v_item->>'notes');
  end loop;

  return v_order;
end $$;

grant execute on function suqa.place_order(uuid, uuid, jsonb, text) to authenticated;
