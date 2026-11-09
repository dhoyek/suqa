-- 06_orders.sql — orders, order_items, order_events        (2026-11-07)

-- One order = one shop. Everything money-related is a snapshot at checkout.
create table if not exists suqa.orders (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references suqa.tenants(id) on delete restrict,
  shop_id           uuid not null references suqa.shops(id) on delete restrict,
  customer_id       uuid references auth.users(id) on delete restrict,   -- null for walk-in sales (21_pos)
  number            text not null,                               -- 'BAT-000123' (or 'BAT-000123-A' inside a basket), per tenant
  status            suqa.order_status not null default 'pending',
  basket_id         uuid,                                        -- set when the order is one shop's part of a multi-shop basket (FK added in 12_baskets.sql)
  basket_seq        text,                                        -- 'A', 'B', … position inside the basket
  courier_id        uuid references auth.users(id) on delete set null,   -- association courier delivering it (14_couriers.sql)
  picked_up_at      timestamptz,
  payment_method    suqa.payment_method not null default 'cod',
  -- delivery
  zone_id           uuid references suqa.delivery_zones(id) on delete set null,
  address           jsonb not null default '{}'::jsonb,          -- snapshot of suqa.addresses row ({} for pickup / walk-in)
  customer_name     text not null default '',
  customer_phone    text not null default '',
  customer_notes    text,
  fulfillment       text not null default 'delivery' check (fulfillment in ('delivery','pickup')),   -- 20_fulfillment
  notify_customer   boolean not null default true,              -- merchant may silence the WhatsApp update for a step (20_fulfillment)
  -- POS (21_pos): every channel lives here
  channel           text not null default 'online' check (channel in ('online','walkin','whatsapp','phone')),
  device_id         uuid,                                       -- POS device that created it
  staff_user_id     uuid references auth.users(id) on delete set null,
  local_number      text,                                       -- 'A-000123' assigned offline by the device; `number` is assigned on sync
  shift_id          uuid,
  parked            boolean not null default false,
  rate_lbp_per_usd  int,
  subtotal_cents    int,
  discount_cents    int not null default 0,
  discount_reason   text,
  total_cents       int,
  total_lbp         bigint,
  paid_usd_cents    int not null default 0,
  paid_lbp          bigint not null default 0,
  change_usd_cents  int not null default 0,
  change_lbp        bigint not null default 0,
  cancel_reason     text,
  -- money (USD, snapshot)
  subtotal_usd      numeric(12,2) not null check (subtotal_usd >= 0),
  delivery_fee_usd  numeric(12,2) not null default 0,
  courier_fee_cents int not null default 0,                       -- paid to the driver, USD cents (25_pos_m6)
  courier_name      text,                                         -- shop's own driver, free text (25_pos_m6)
  total_usd         numeric(12,2) not null,
  fx_lbp_rate       numeric(14,2) not null,                      -- tenant rate at checkout
  commission_rate   numeric(5,4)  not null default 0,
  commission_usd    numeric(12,2) not null default 0,
  -- shop side
  shop_notes        text,
  reject_reason     text,
  eta_minutes       int,
  -- timestamps
  placed_at         timestamptz not null default now(),
  needed_at         timestamptz,                         -- 34: when the customer wants it (scheduled orders)
  driver_id         uuid,                                -- 37: shop driver delivering it (suqa.shop_drivers; fk added in 37)
  accepted_at       timestamptz,
  delivered_at      timestamptz,
  closed_at         timestamptz,                                 -- delivered/rejected/cancelled
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, number)
);
create index if not exists orders_shop_status_idx   on suqa.orders(shop_id, status, placed_at desc);
create index if not exists orders_customer_idx      on suqa.orders(customer_id, placed_at desc);
create index if not exists orders_tenant_placed_idx on suqa.orders(tenant_id, placed_at desc);

create table if not exists suqa.order_items (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references suqa.orders(id) on delete cascade,
  tenant_id      uuid not null references suqa.tenants(id) on delete restrict,
  product_id     uuid references suqa.products(id) on delete set null,
  name           jsonb not null,                                 -- snapshot
  unit           text,
  unit_price_usd numeric(12,2) not null,
  quantity       numeric(10,3) not null check (quantity > 0),   -- allows 0.5 kg
  line_total_usd numeric(12,2) not null,
  notes          text,
  -- POS (21_pos)
  shop_id          uuid references suqa.shops(id) on delete cascade,   -- filled from the order by trigger
  price_currency   text not null default 'usd' check (price_currency in ('usd','lbp')),
  unit_price_cents int,
  unit_price_lbp   bigint,
  discount_cents   int not null default 0,
  line_total_cents int,
  cost_cents       int,                                                -- snapshot (owner-only)
  voided           boolean not null default false,
  void_reason      text
);
create index if not exists order_items_order_idx on suqa.order_items(order_id);

-- Append-only history of status changes and remarks.
create table if not exists suqa.order_events (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references suqa.orders(id) on delete cascade,
  tenant_id   uuid not null references suqa.tenants(id) on delete restrict,
  from_status suqa.order_status,
  to_status   suqa.order_status,
  actor_kind  suqa.actor_kind not null,
  actor_id    uuid,                                              -- auth user, null for system
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists order_events_order_idx on suqa.order_events(order_id, created_at);

-- Per-tenant order counters.
create table if not exists suqa.order_counters (
  tenant_id   uuid primary key references suqa.tenants(id) on delete cascade,
  prefix      text not null,                                     -- 'BAT'
  last_value  bigint not null default 0
);
