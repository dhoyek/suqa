-- 05_delivery.sql — delivery_zones, shop_delivery_zones, addresses   (2026-10-16)

create table if not exists suqa.delivery_zones (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references suqa.tenants(id) on delete cascade,
  name        jsonb not null,                                    -- {"en":"Batroun town","ar":"البترون"}
  area        geography(multipolygon, 4326) not null,
  fee_usd     numeric(12,2) not null default 0,
  eta_minutes int,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists delivery_zones_tenant_idx on suqa.delivery_zones(tenant_id, is_active);
create index if not exists delivery_zones_area_idx   on suqa.delivery_zones using gist(area);

-- Which zones a shop delivers to; optional fee override.
create table if not exists suqa.shop_delivery_zones (
  shop_id      uuid not null references suqa.shops(id) on delete cascade,
  zone_id      uuid not null references suqa.delivery_zones(id) on delete cascade,
  fee_usd      numeric(12,2),                                    -- null = zone default
  primary key (shop_id, zone_id)
);

-- Customer saved addresses.
create table if not exists suqa.addresses (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references suqa.tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  label       text,                                              -- 'Home', 'Office'
  line1       text,                                              -- building / street as the user types it (optional since 16_quick_checkout)
  line2       text,
  notes       text,                                              -- "ring twice", landmark
  location    geography(point, 4326) not null,
  phone       text,                                              -- contact for this delivery
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists addresses_user_idx on suqa.addresses(user_id);
