-- 14_couriers.sql — association couriers (drivers)                           (2026-10-17)
-- A courier is NOT a tenant member: they see only orders that are ready to go out in their tenant,
-- can take them (status ready → out_for_delivery, courier_id = me) and mark them delivered. Nothing else.
-- Shown in the app only when tenants.settings.courier_enabled = true.

alter type suqa.actor_kind add value if not exists 'courier';

create table if not exists suqa.couriers (
  tenant_id   uuid not null references suqa.tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  is_active   boolean not null default true,
  vehicle     text,                                              -- 'moto', 'car', … free text
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index if not exists couriers_user_idx on suqa.couriers(user_id);

-- orders: who is delivering (columns also declared here for existing databases; see 06_orders.sql)
alter table suqa.orders add column if not exists courier_id uuid references auth.users(id) on delete set null;
alter table suqa.orders add column if not exists picked_up_at timestamptz;
create index if not exists orders_courier_idx on suqa.orders(courier_id, status);

create or replace function suqa.is_courier(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from suqa.couriers where tenant_id = p_tenant and user_id = auth.uid() and is_active)
$$;

-- ---------- RLS --------------------------------------------------------------
alter table suqa.couriers enable row level security;
select suqa._policy('couriers','couriers_read','select','authenticated','user_id = auth.uid() or suqa.is_tenant_member(tenant_id)');
select suqa._policy('couriers','couriers_admin_write','all','authenticated','suqa.is_tenant_admin(tenant_id)','suqa.is_tenant_admin(tenant_id)');

-- orders: couriers read what is ready / theirs, and may update those rows (columns limited by the guard below)
select suqa._policy('orders','orders_read','select','authenticated',
  'customer_id = auth.uid() or suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)
   or (suqa.is_courier(tenant_id) and (status in (''ready'',''out_for_delivery'') or courier_id = auth.uid()))');
select suqa._policy('orders','orders_update','update','authenticated',
  'customer_id = auth.uid() or suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)
   or (suqa.is_courier(tenant_id) and (status = ''ready'' or courier_id = auth.uid()))',
  'customer_id = auth.uid() or suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)
   or (suqa.is_courier(tenant_id) and courier_id = auth.uid())');
-- baskets: a courier may read the baskets of the parts they can see (address, notes)
select suqa._policy('baskets','baskets_read','select','authenticated',
  'customer_id = auth.uid() or suqa.is_tenant_member(tenant_id)
   or exists (select 1 from suqa.orders o where o.basket_id = baskets.id and (suqa.is_shop_member(o.shop_id) or (suqa.is_courier(tenant_id) and (o.status in (''ready'',''out_for_delivery'') or o.courier_id = auth.uid()))))');
-- shops: couriers need the shop name/address/phone of ready orders (shops are public when active anyway)

-- ---------- column guard: couriers may only take / hand over ----------------------
create or replace function suqa.orders_guard_columns() returns trigger
language plpgsql set search_path = public as $$
declare
  v_changed text[];
  v_allowed text[];
  v_auto    text[] := array['updated_at','accepted_at','delivered_at','closed_at','picked_up_at'];
begin
  if not suqa._guards_apply() then return new; end if;

  v_changed := suqa._changed_cols(to_jsonb(old), to_jsonb(new));
  v_changed := array(select unnest(v_changed) except select unnest(v_auto));

  if suqa.is_tenant_member(new.tenant_id) or suqa.is_shop_member(new.shop_id) then
    v_allowed := array['status','reject_reason','shop_notes','eta_minutes','courier_id'];
  elsif suqa.is_courier(new.tenant_id) then
    v_allowed := array['status','courier_id'];
    -- a courier may only claim an unassigned order for themselves, and only move ready → out → delivered
    if new.courier_id is distinct from old.courier_id and not (old.courier_id is null and new.courier_id = auth.uid()) then
      raise exception 'order_locked' using errcode = 'check_violation', detail = 'courier_id';
    end if;
    if new.status is distinct from old.status and not ((old.status, new.status) in (('ready','out_for_delivery'), ('out_for_delivery','delivered'))) then
      raise exception 'order_locked' using errcode = 'check_violation', detail = 'status';
    end if;
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

-- ---------- state machine: know the courier, stamp pickup time -------------------
create or replace function suqa.orders_on_status_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_actor suqa.actor_kind;
begin
  if new.status = old.status then return new; end if;

  if not suqa.order_transition_allowed(old.status, new.status) then
    raise exception 'order %: transition % → % not allowed', old.number, old.status, new.status
      using errcode = 'check_violation';
  end if;

  v_actor := case
    when suqa.is_platform_admin()             then 'platform'
    when suqa.is_tenant_member(new.tenant_id) then 'tenant'
    when suqa.is_shop_member(new.shop_id)     then 'shop'
    when suqa.is_courier(new.tenant_id)       then 'courier'
    when auth.uid() = new.customer_id         then 'customer'
    else 'system' end;

  if v_actor = 'customer' and not (old.status = 'pending' and new.status = 'cancelled') then
    raise exception 'customers can only cancel a pending order' using errcode = 'insufficient_privilege';
  end if;

  if new.status = 'accepted'         then new.accepted_at  = coalesce(new.accepted_at, now()); end if;
  if new.status = 'out_for_delivery' then new.picked_up_at = coalesce(new.picked_up_at, now()); end if;
  if new.status = 'delivered'        then new.delivered_at = coalesce(new.delivered_at, now()); end if;
  if new.status in ('delivered','rejected','cancelled') then new.closed_at = coalesce(new.closed_at, now()); end if;

  insert into suqa.order_events(order_id, tenant_id, from_status, to_status, actor_kind, actor_id, note)
  values (new.id, new.tenant_id, old.status, new.status, v_actor, auth.uid(),
          case when new.status = 'rejected' then new.reject_reason end);
  return new;
end $$;

-- ---------- admin helper: couriers with names ------------------------------------
create or replace function suqa.tenant_couriers(p_tenant uuid)
returns table (user_id uuid, full_name text, email text, phone text, is_active boolean, vehicle text, active_deliveries int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not suqa.is_tenant_member(p_tenant) then raise exception 'not allowed' using errcode = 'insufficient_privilege'; end if;
  return query
    select c.user_id, p.full_name, u.email::text, p.phone, c.is_active, c.vehicle,
           (select count(*)::int from suqa.orders o where o.courier_id = c.user_id and o.status = 'out_for_delivery')
      from suqa.couriers c
      join auth.users u on u.id = c.user_id
      left join suqa.profiles p on p.id = c.user_id
     where c.tenant_id = p_tenant
     order by p.full_name;
end $$;
grant execute on function suqa.tenant_couriers(uuid) to authenticated;

select 'couriers installed' as result;
