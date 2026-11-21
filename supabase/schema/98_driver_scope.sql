-- 98: drivers — a shop's driver can be "for the shop only" or "for the whole association".
--
-- A driver is a shop's own row (name, phone, pay rule, his balance with that shop). The owner can now mark him as available to
-- the whole association: the other shops then find him in "the association's drivers" on their own Drivers screen and add him
-- with one tap — as their OWN driver row, with their own pay rule and their own balance. Nothing of a shop's money is shared:
-- only the name, the phone number and the vehicle of a driver whose shop chose to share him. The association's couriers
-- (Admin → Members) are in the same list.
--
-- Changed table:    shop_drivers (+ scope).
-- Changed function: _pos_driver_upsert (takes scope when the till sends it; nothing else changes).
-- New function:     pos_association_drivers(shop) — the shop's staff only; the drivers shared in the shop's association that the
--                   shop has not got yet.

create table if not exists suqa.shop_drivers (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references suqa.shops(id) on delete cascade,
  tenant_id     uuid not null references suqa.tenants(id) on delete cascade,
  name          text not null,
  phone         text not null,
  phone_key     text not null,                             -- suqa._phone_key(phone)
  vehicle       text,                                      -- 'moto', 'car', … free text
  active        boolean not null default true,
  available     boolean not null default true,             -- quick on/off: "not today"
  notes         text,
  user_id       uuid references auth.users(id) on delete set null,   -- linked when a user with this number exists
  last_used_at  timestamptz,
  pay_mode      text check (pay_mode is null or pay_mode in ('none','per_delivery','delivery_fee')),   -- 60: null = follow the shop default
  pay_cents     int  check (pay_cents is null or pay_cents >= 0),                                    -- 60: fixed amount per delivery when pay_mode = 'per_delivery'
  scope         text not null default 'shop' check (scope in ('shop','association')),               -- 98: 'association' = the other shops of the association may add him
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (shop_id, phone_key)
);
alter table suqa.shop_drivers add column if not exists scope text not null default 'shop';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shop_drivers_scope_check' and conrelid = 'suqa.shop_drivers'::regclass) then
    alter table suqa.shop_drivers add constraint shop_drivers_scope_check check (scope in ('shop','association'));
  end if;
end $$;
create index if not exists shop_drivers_shared on suqa.shop_drivers(tenant_id) where scope = 'association';

create or replace function suqa._pos_driver_upsert(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_key text := suqa._phone_key(p->>'phone'); v_id uuid := coalesce(nullif(p->>'id', '')::uuid, gen_random_uuid());
        v_scope text := case when p->>'scope' in ('shop', 'association') then p->>'scope' end;      -- 98: only when the till sends it
begin
  if v_key is null or length(v_key) < 6 then raise exception 'bad_phone'; end if;
  if coalesce(trim(p->>'name'), '') = '' then raise exception 'bad_name'; end if;
  insert into suqa.shop_drivers (id, shop_id, tenant_id, name, phone, phone_key, vehicle, active, available, notes, scope)
  values (v_id, d.shop_id, d.tenant_id, trim(p->>'name'), trim(p->>'phone'), v_key, nullif(trim(coalesce(p->>'vehicle', '')), ''),
          coalesce((p->>'active')::boolean, true), coalesce((p->>'available')::boolean, true), nullif(trim(coalesce(p->>'notes', '')), ''), coalesce(v_scope, 'shop'))
  on conflict (shop_id, phone_key) do update set
    name = excluded.name, phone = excluded.phone, vehicle = excluded.vehicle, notes = excluded.notes,
    active = case when p ? 'active' then excluded.active else suqa.shop_drivers.active end,
    available = case when p ? 'available' then excluded.available else suqa.shop_drivers.available end,
    scope = coalesce(v_scope, suqa.shop_drivers.scope)
  returning id into v_id;
  perform suqa._driver_link(v_id);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- The association's drivers a shop can add: shared by another shop of the same association, or one of the association's couriers.
-- One line per phone number; the ones this shop already has are left out. Name, phone and vehicle only.
create or replace function suqa.pos_association_drivers(p_shop uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_role text := suqa.pos_role(p_shop); v_tenant uuid;
begin
  if v_role is null or v_role = 'setup' then raise exception 'not_staff' using errcode = 'insufficient_privilege'; end if;
  select tenant_id into v_tenant from suqa.shops where id = p_shop;
  return coalesce((
    select jsonb_agg(jsonb_build_object('name', x.name, 'phone', x.phone, 'vehicle', x.vehicle, 'source', x.source) order by x.name)
    from (
      select distinct on (y.phone_key) y.name, y.phone, y.vehicle, y.source
      from (
        select sd.phone_key, sd.name, sd.phone, sd.vehicle, 'shop' as source, sd.updated_at
          from suqa.shop_drivers sd where sd.tenant_id = v_tenant and sd.scope = 'association' and sd.active and sd.shop_id <> p_shop
        union all
        select suqa._phone_key(pr.phone), coalesce(nullif(trim(pr.full_name), ''), pr.phone), pr.phone, c.vehicle, 'association', c.created_at
          from suqa.couriers c join suqa.profiles pr on pr.id = c.user_id
         where c.tenant_id = v_tenant and c.is_active and pr.phone is not null and length(suqa._phone_key(pr.phone)) >= 6
      ) y
      where not exists (select 1 from suqa.shop_drivers mine where mine.shop_id = p_shop and mine.phone_key = y.phone_key)
      order by y.phone_key, (y.source = 'association') desc, y.updated_at desc
    ) x), '[]'::jsonb);
end $$;
revoke all on function suqa.pos_association_drivers(uuid) from public, anon;
grant execute on function suqa.pos_association_drivers(uuid) to authenticated;
