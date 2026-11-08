-- 04_catalog.sql — shops, shop_members, categories, products   (2026-11-07)

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
  pickup_enabled   boolean not null default true,              -- customers may collect from the shop (20_fulfillment)
  -- POS (21_pos)
  pos_enabled          boolean not null default false,         -- tenant switches the POS on per shop
  default_delivery_fee_usd numeric(12,2) not null default 0,     -- pre-filled delivery fee for WhatsApp/phone orders (28_pos_customers)
  offline_days         int     not null default 30 check (offline_days between 1 and 90),   -- PIN unlock allowed this long without internet
  max_discount_pct     numeric(5,2) not null default 10,       -- above this a cashier needs the owner PIN
  allow_negative_stock boolean not null default true,
  lbp_rounding_step    int     not null default 5000,          -- change in LBP rounded to usable notes
  deduct_stock_at      text    not null default 'ready' check (deduct_stock_at in ('ready','delivered')),
  hide_online_when_zero boolean not null default false,
  receipt_footer       text,
  printer              jsonb   not null default '{}'::jsonb,   -- {type:'escpos', transport:'serial|bluetooth|network', width:58|80, drawer:true}
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
  role        suqa.shop_role not null default 'staff',        -- owner | staff(=cashier) | cashier | stock   (21_pos)
  display_name text,                                           -- shown on the POS staff tiles (21_pos)
  pin_hash    text,                                            -- PBKDF2-SHA256 of the 4-digit POS PIN, hashed client-side (21_pos)
  pin_salt    text,
  pin_set_at  timestamptz,
  active      boolean not null default true,                   -- inactive staff cannot unlock the POS (21_pos)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
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
  -- POS (21_pos)
  price_currency text    not null default 'usd' check (price_currency in ('usd','lbp')),   -- which of price_usd / price_lbp is the entered one
  price_lbp      bigint  not null default 0 check (price_lbp >= 0),
  cost_cents     int,                                            -- owner-only; stripped from the POS feed for other roles
  sku            text,
  unit_kind      text    not null default 'piece' check (unit_kind in ('piece','kg','g','l','ml','pack')),
  decimal_qty    boolean not null default false,                 -- weighed items allow 0.250
  vat            boolean not null default false,
  track_stock    boolean not null default false,
  min_stock      numeric(12,3) not null default 0,
  visible_online boolean not null default true,                  -- listed in the public catalog (is_available = sellable right now)
  on_hand        numeric(12,3) not null default 0,               -- Σ stock_moves (trigger-maintained)
  reserved       numeric(12,3) not null default 0,               -- open online orders (trigger-maintained)
  needs_review   boolean not null default false,                 -- on_hand went negative
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists products_shop_idx   on suqa.products(shop_id, is_active, is_available);
create index if not exists products_tenant_idx on suqa.products(tenant_id);

-- POS: several barcodes per item; unique per shop (21_pos)
create table if not exists suqa.product_barcodes (
  product_id  uuid not null references suqa.products(id) on delete cascade,
  shop_id     uuid not null references suqa.shops(id) on delete cascade,
  tenant_id   uuid not null references suqa.tenants(id) on delete cascade,
  barcode     text not null,
  created_at  timestamptz not null default now(),
  primary key (product_id, barcode),
  unique (shop_id, barcode)
);
