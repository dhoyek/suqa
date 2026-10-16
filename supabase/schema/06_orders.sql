-- 06_orders.sql — orders, order_items, order_events        (2026-10-16)

-- One order = one shop. Everything money-related is a snapshot at checkout.
create table if not exists suqa.orders (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references suqa.tenants(id) on delete restrict,
  shop_id           uuid not null references suqa.shops(id) on delete restrict,
  customer_id       uuid not null references auth.users(id) on delete restrict,
  number            text not null,                               -- 'BAT-000123', per tenant
  status            suqa.order_status not null default 'pending',
  payment_method    suqa.payment_method not null default 'cod',
  -- delivery
  zone_id           uuid references suqa.delivery_zones(id) on delete set null,
  address           jsonb not null,                              -- snapshot of suqa.addresses row
  customer_name     text not null,
  customer_phone    text not null,
  customer_notes    text,
  -- money (USD, snapshot)
  subtotal_usd      numeric(12,2) not null check (subtotal_usd >= 0),
  delivery_fee_usd  numeric(12,2) not null default 0,
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
  notes          text
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
