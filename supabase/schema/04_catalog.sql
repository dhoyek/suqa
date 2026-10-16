-- 04_catalog.sql — shops, shop_members, categories, products   (2026-10-16)

create table if not exists suqa.shops (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references suqa.tenants(id) on delete cascade,
  slug             citext not null,                              -- url piece, unique per tenant
  name             jsonb not null,                               -- {"en":"…","ar":"…"}
  description      jsonb not null default '{}'::jsonb,
  status           suqa.shop_status not null default 'pending',
  phone            text,                                         -- public phone
  whatsapp         text,                                         -- E.164, receives order alerts
  address_text     text,
  location         geography(point, 4326),
  logo_url         text,
  cover_url        text,
  opening_hours    jsonb not null default '{}'::jsonb,           -- {"mon":[["09:00","13:00"],["16:00","20:00"]],…}
  is_open_override boolean,                                      -- null = follow hours; true/false = force
  min_order_usd    numeric(12,2) not null default 0,
  prep_minutes     int not null default 30,
  commission_rate  numeric(5,4) check (commission_rate between 0 and 1),  -- null = tenant default
  sort_order       int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, slug)
);
create index if not exists shops_tenant_status_idx on suqa.shops(tenant_id, status);
create index if not exists shops_location_idx on suqa.shops using gist(location);

create table if not exists suqa.shop_members (
  shop_id     uuid not null references suqa.shops(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        suqa.shop_role not null default 'staff',
  created_at  timestamptz not null default now(),
  primary key (shop_id, user_id)
);
create index if not exists shop_members_user_idx on suqa.shop_members(user_id);

-- Tenant-level taxonomy (e.g. Bakery, Grocery, Pharmacy). A shop picks one primary category.
create table if not exists suqa.categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references suqa.tenants(id) on delete cascade,
  slug        citext not null,
  name        jsonb not null,
  icon        text,
  sort_order  int not null default 0,
  parent_id   uuid references suqa.categories(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (tenant_id, slug)
);
create index if not exists categories_tenant_idx on suqa.categories(tenant_id);

alter table suqa.shops
  add column if not exists category_id uuid references suqa.categories(id) on delete set null;
-- (kept as a single, documented exception to the full-script rule: forward reference)

create table if not exists suqa.products (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references suqa.tenants(id) on delete cascade,
  shop_id        uuid not null references suqa.shops(id) on delete cascade,
  name           jsonb not null,
  description    jsonb not null default '{}'::jsonb,
  price_usd      numeric(12,2) not null check (price_usd >= 0),
  unit           text,                                           -- 'kg', 'piece', '500 g'
  image_url      text,
  is_available   boolean not null default true,                  -- the merchant's one toggle
  is_active      boolean not null default true,                  -- soft delete
  sort_order     int not null default 0,
  section        text,                                           -- free-text grouping inside a shop menu
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists products_shop_idx   on suqa.products(shop_id, is_active, is_available);
create index if not exists products_tenant_idx on suqa.products(tenant_id);
