-- 21_pos.sql — POS: devices, change feed, idempotent ops, stock ledger, payments, shifts      (2026-11-07)
-- See docs/pos/PLAN.md. Everything here is additive: the online store flow keeps working unchanged.
--
--   devices         one row per browser/device that opened the POS; prefix for offline order numbers; revocable
--   pos_ops         every applied op id → result  (idempotency: a retried push never duplicates a sale)
--   sync_log        change feed; AFTER triggers on synced tables write the full row; devices pull by cursor
--   conflict_log    field-level overwrites (server wins) the owner can review
--   audit_log       who did what, from which device
--   exchange_rates  shop rate history (LBP per USD); the tenant rate stays the store default
--   stock_moves     append-only ledger; products.on_hand / reserved are sums maintained by trigger
--   payments        tenders per order (cash USD / cash LBP / card / wallet / unpaid)
--   shifts, cash_moves, quick_buttons, returns, return_lines
--
-- Deployed DB: columns are added with ALTER … ADD COLUMN IF NOT EXISTS (base files 03/04/06 carry the full scripts).

-- ---------- enums ------------------------------------------------------------------------------------
alter type suqa.shop_role add value if not exists 'cashier';   -- 'staff' (legacy) is treated as cashier
alter type suqa.shop_role add value if not exists 'stock';

-- ---------- shops: POS settings ------------------------------------------------------------------------
alter table suqa.shops
  add column if not exists pos_enabled          boolean not null default false,
  add column if not exists offline_days         int     not null default 30 check (offline_days between 1 and 90),
  add column if not exists max_discount_pct     numeric(5,2) not null default 10,
  add column if not exists allow_negative_stock boolean not null default true,
  add column if not exists lbp_rounding_step    int     not null default 5000,
  add column if not exists deduct_stock_at      text    not null default 'ready' check (deduct_stock_at in ('ready','delivered')),
  add column if not exists hide_online_when_zero boolean not null default false,
  add column if not exists receipt_footer       text,
  add column if not exists printer              jsonb   not null default '{}'::jsonb;

-- ---------- shop_members: PIN + display name -------------------------------------------------------------
alter table suqa.shop_members
  add column if not exists display_name text,
  add column if not exists pin_hash     text,          -- PBKDF2-SHA256 (100k) of the 4-digit PIN, computed client-side
  add column if not exists pin_salt     text,
  add column if not exists pin_set_at   timestamptz,
  add column if not exists active       boolean not null default true,
  add column if not exists updated_at   timestamptz not null default now();

-- ---------- products: POS fields + stock sums ----------------------------------------------------------
alter table suqa.products
  add column if not exists price_currency text    not null default 'usd' check (price_currency in ('usd','lbp')),
  add column if not exists price_lbp      bigint  not null default 0 check (price_lbp >= 0),
  add column if not exists cost_cents     int,                                          -- owner-only (stripped in pos_pull)
  add column if not exists sku            text,
  add column if not exists unit_kind      text    not null default 'piece' check (unit_kind in ('piece','kg','g','l','ml','pack')),
  add column if not exists decimal_qty    boolean not null default false,
  add column if not exists vat            boolean not null default false,
  add column if not exists track_stock    boolean not null default false,
  add column if not exists min_stock      numeric(12,3) not null default 0,
  add column if not exists visible_online boolean not null default true,
  add column if not exists on_hand        numeric(12,3) not null default 0,
  add column if not exists reserved       numeric(12,3) not null default 0,
  add column if not exists needs_review   boolean not null default false;              -- on_hand went negative

create table if not exists suqa.product_barcodes (
  product_id  uuid not null references suqa.products(id) on delete cascade,
  shop_id     uuid not null references suqa.shops(id) on delete cascade,
  tenant_id   uuid not null references suqa.tenants(id) on delete cascade,
  barcode     text not null,
  pack_qty       numeric(12,3) not null default 1,            -- scanning this barcode adds pack_qty units (31_pos_m11)
  pack_price_usd numeric(12,2),                               -- pack price; null = unit price × pack_qty
  pack_price_lbp bigint,
  created_at  timestamptz not null default now(),
  primary key (product_id, barcode),
  unique (shop_id, barcode)
);
create index if not exists product_barcodes_shop on suqa.product_barcodes(shop_id);

create table if not exists suqa.quick_buttons (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references suqa.shops(id) on delete cascade,
  tenant_id   uuid not null references suqa.tenants(id) on delete cascade,
  product_id  uuid references suqa.products(id) on delete cascade,
  label       text,
  color       text,
  sort_order  int not null default 0,
  updated_at  timestamptz not null default now()
);

-- ---------- orders: every channel in one table -----------------------------------------------------------
alter table suqa.orders alter column customer_id drop not null;
alter table suqa.orders alter column address set default '{}'::jsonb;
alter table suqa.orders alter column customer_name set default '';
alter table suqa.orders alter column customer_phone set default '';
alter table suqa.orders
  add column if not exists channel          text not null default 'online' check (channel in ('online','walkin','whatsapp','phone')),
  add column if not exists device_id        uuid,
  add column if not exists staff_user_id    uuid references auth.users(id) on delete set null,
  add column if not exists local_number     text,                               -- 'A-000123' assigned offline by the device
  add column if not exists shift_id         uuid,
  add column if not exists parked           boolean not null default false,
  add column if not exists rate_lbp_per_usd int,
  add column if not exists subtotal_cents   int,
  add column if not exists discount_cents   int not null default 0,
  add column if not exists discount_reason  text,
  add column if not exists total_cents      int,
  add column if not exists total_lbp        bigint,
  add column if not exists paid_usd_cents   int not null default 0,
  add column if not exists paid_lbp         bigint not null default 0,
  add column if not exists change_usd_cents int not null default 0,
  add column if not exists change_lbp       bigint not null default 0,
  add column if not exists cancel_reason    text;
create index if not exists orders_shop_channel on suqa.orders(shop_id, channel, placed_at desc);
create index if not exists orders_device on suqa.orders(device_id) where device_id is not null;

alter table suqa.order_items
  add column if not exists shop_id          uuid references suqa.shops(id) on delete cascade,
  add column if not exists price_currency   text not null default 'usd' check (price_currency in ('usd','lbp')),
  add column if not exists unit_price_cents int,
  add column if not exists unit_price_lbp   bigint,
  add column if not exists discount_cents   int not null default 0,
  add column if not exists line_total_cents int,
  add column if not exists cost_cents       int,                                 -- snapshot at sale time (owner-only)
  add column if not exists voided           boolean not null default false,
  add column if not exists void_reason      text;
update suqa.order_items i set shop_id = o.shop_id from suqa.orders o where o.id = i.order_id and i.shop_id is null;
create or replace function suqa.order_items_fill_shop() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.shop_id is null then select shop_id into new.shop_id from suqa.orders where id = new.order_id; end if;
  return new;
end $$;
drop trigger if exists order_items_0_fill_shop on suqa.order_items;
create trigger order_items_0_fill_shop before insert on suqa.order_items for each row execute function suqa.order_items_fill_shop();

-- ---------- devices ---------------------------------------------------------------------------------------
create table if not exists suqa.devices (
  id             uuid primary key,                                   -- client-generated (uuid v7)
  shop_id        uuid not null references suqa.shops(id) on delete cascade,
  tenant_id      uuid not null references suqa.tenants(id) on delete cascade,
  name           text not null,
  prefix         text not null,                                      -- 'A', 'B', … unique per shop
  user_agent     text,
  registered_by  uuid references auth.users(id) on delete set null,
  registered_at  timestamptz not null default now(),
  last_sync_at   timestamptz,
  last_cursor    bigint not null default 0,
  pending_count  int not null default 0,
  app_version    text,
  revoked_at     timestamptz,
  revoked_by     uuid references auth.users(id) on delete set null,
  updated_at     timestamptz not null default now(),
  unique (shop_id, prefix)
);

-- ---------- idempotent ops ------------------------------------------------------------------------------
create table if not exists suqa.pos_ops (
  op_id          uuid primary key,
  device_id      uuid not null references suqa.devices(id) on delete cascade,
  shop_id        uuid not null,
  kind           text not null,
  schema_version int  not null default 1,
  applied_at     timestamptz not null default now(),
  result         jsonb not null
);
create index if not exists pos_ops_device on suqa.pos_ops(device_id, applied_at desc);

-- ---------- change feed ------------------------------------------------------------------------------------
create table if not exists suqa.sync_log (
  seq            bigserial primary key,
  tenant_id      uuid not null,
  shop_id        uuid,                                               -- null = tenant-wide row (categories)
  tbl            text not null,
  row_id         text not null,
  op             text not null check (op in ('upsert','delete')),
  row            jsonb not null,
  origin_device  uuid,
  at             timestamptz not null default now()
);
create index if not exists sync_log_shop_seq on suqa.sync_log(shop_id, seq);
create index if not exists sync_log_tenant_seq on suqa.sync_log(tenant_id, seq) where shop_id is null;
create index if not exists sync_log_at on suqa.sync_log(at);

create table if not exists suqa.conflict_log (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references suqa.shops(id) on delete cascade,
  tenant_id   uuid not null,
  tbl         text not null,
  row_id      text not null,
  field       text not null,
  old_value   jsonb,
  new_value   jsonb,
  by_device   uuid,
  by_user     uuid,
  at          timestamptz not null default now(),
  seen        boolean not null default false
);

create table if not exists suqa.audit_log (
  id               bigserial primary key,
  shop_id          uuid not null,
  tenant_id        uuid not null,
  user_id          uuid,
  device_id        uuid,
  at               timestamptz not null default now(),
  action           text not null,
  ref_tbl          text,
  ref_id           text,
  before           jsonb,
  after            jsonb,
  acting_as_admin  boolean not null default false
);
create index if not exists audit_log_shop on suqa.audit_log(shop_id, at desc);

-- ---------- money & stock -----------------------------------------------------------------------------------
create table if not exists suqa.exchange_rates (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references suqa.shops(id) on delete cascade,
  tenant_id    uuid not null,
  lbp_per_usd  int not null check (lbp_per_usd > 0),
  effective_at timestamptz not null default now(),
  set_by       uuid,
  updated_at   timestamptz not null default now()
);
create index if not exists exchange_rates_shop on suqa.exchange_rates(shop_id, effective_at desc);

create table if not exists suqa.stock_moves (
  id              uuid primary key,
  shop_id         uuid not null references suqa.shops(id) on delete cascade,
  tenant_id       uuid not null,
  product_id      uuid not null references suqa.products(id) on delete cascade,
  qty             numeric(12,3) not null,                            -- signed: sale −, receive +, reserve + (on reserved), release − (on reserved)
  kind            text not null check (kind in ('sale','return','receive','adjust','count','damaged','reserve','release')),
  ref_order_id    uuid references suqa.orders(id) on delete set null,
  ref_id          uuid,                                              -- return id, count id …
  unit_cost_cents int,
  note            text,
  device_id       uuid,
  user_id         uuid,
  at              timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists stock_moves_product on suqa.stock_moves(product_id, at desc);
create index if not exists stock_moves_order on suqa.stock_moves(ref_order_id) where ref_order_id is not null;

create table if not exists suqa.payments (
  id           uuid primary key,
  order_id     uuid not null references suqa.orders(id) on delete cascade,
  shop_id      uuid not null references suqa.shops(id) on delete cascade,
  tenant_id    uuid not null,
  tender       text not null check (tender in ('cash_usd','cash_lbp','card','wallet','unpaid')),
  amount       bigint not null,                                      -- cents for usd, pounds for lbp
  currency     text not null check (currency in ('usd','lbp')),
  reference    text,
  unpaid_name  text,
  unpaid_phone text,
  note         text,
  settled_at   timestamptz,                                          -- unpaid → paid later
  at           timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists payments_order on suqa.payments(order_id);

create table if not exists suqa.shifts (
  id                 uuid primary key,
  shop_id            uuid not null references suqa.shops(id) on delete cascade,
  tenant_id          uuid not null,
  device_id          uuid not null,
  opened_by          uuid,
  opened_at          timestamptz not null default now(),
  float_usd_cents    int not null default 0,
  float_lbp          bigint not null default 0,
  closed_by          uuid,
  closed_at          timestamptz,
  counted_usd_cents  int,
  counted_lbp        bigint,
  expected_usd_cents int,
  expected_lbp       bigint,
  diff_usd_cents     int,
  diff_lbp           bigint,
  note               text,
  updated_at         timestamptz not null default now()
);
create index if not exists shifts_device on suqa.shifts(device_id, opened_at desc);

create table if not exists suqa.cash_moves (
  id        uuid primary key,
  shift_id  uuid not null references suqa.shifts(id) on delete cascade,
  shop_id   uuid not null references suqa.shops(id) on delete cascade,
  tenant_id uuid not null,
  kind      text not null check (kind in ('in','out')),
  amount    bigint not null check (amount > 0),
  currency  text not null check (currency in ('usd','lbp')),
  reason    text,
  user_id   uuid,
  at        timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists suqa.returns (
  id               uuid primary key,
  shop_id          uuid not null references suqa.shops(id) on delete cascade,
  tenant_id        uuid not null,
  order_id         uuid not null references suqa.orders(id) on delete restrict,
  number           text,
  device_id        uuid,
  user_id          uuid,
  approved_by      uuid,
  refund_usd_cents int not null default 0,
  refund_lbp       bigint not null default 0,
  reason           text,
  at               timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create table if not exists suqa.return_lines (
  id             uuid primary key,
  return_id      uuid not null references suqa.returns(id) on delete cascade,
  shop_id        uuid not null,
  tenant_id      uuid not null,
  order_item_id  uuid references suqa.order_items(id) on delete set null,
  product_id     uuid references suqa.products(id) on delete set null,
  qty            numeric(12,3) not null check (qty > 0),
  destination    text not null check (destination in ('stock','damaged')),
  amount_cents   int not null default 0,
  updated_at     timestamptz not null default now()
);

-- updated_at on the new tables
do $$ declare t text; begin
  foreach t in array array['shop_members','quick_buttons','devices','exchange_rates','stock_moves','payments','shifts','cash_moves','returns','return_lines'] loop
    execute format('drop trigger if exists set_updated_at on suqa.%I', t);
    execute format('create trigger set_updated_at before update on suqa.%I for each row execute function suqa.set_updated_at()', t);
  end loop;
end $$;

-- ---------- stock sums --------------------------------------------------------------------------------------
-- on_hand  = Σ qty of real movements (sale, return, receive, adjust, count, damaged)
-- reserved = Σ qty of reserve/release movements (open online orders)
create or replace function suqa.stock_moves_apply() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_q numeric := case when tg_op = 'DELETE' then -old.qty else new.qty end;
        v_row suqa.stock_moves := case when tg_op = 'DELETE' then old else new end;
begin
  if tg_op = 'UPDATE' then   -- append-only; only detaching a deleted order's reference is allowed (27_pos_order_delete)
    if new.ref_order_id is null and old.ref_order_id is not null and (to_jsonb(new) - 'ref_order_id' - 'updated_at') = (to_jsonb(old) - 'ref_order_id' - 'updated_at') then return new; end if;
    raise exception 'stock_moves are append-only' using errcode = 'check_violation';
  end if;
  if v_row.kind in ('reserve','release') then
    update suqa.products set reserved = greatest(reserved + v_q, 0) where id = v_row.product_id;
  else
    update suqa.products set on_hand = on_hand + v_q,
                             needs_review = (on_hand + v_q < 0) or needs_review
     where id = v_row.product_id;
  end if;
  return v_row;
end $$;
drop trigger if exists stock_moves_apply on suqa.stock_moves;
create trigger stock_moves_apply after insert or update or delete on suqa.stock_moves
  for each row execute function suqa.stock_moves_apply();

-- Online orders: reserve on item insert, deduct at shop.deduct_stock_at, release on reject/cancel.
create or replace function suqa.order_items_reserve() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_order suqa.orders; v_track boolean;
begin
  select * into v_order from suqa.orders where id = new.order_id;
  if v_order.channel <> 'online' or new.product_id is null then return new; end if;
  select track_stock into v_track from suqa.products where id = new.product_id;
  if not coalesce(v_track, false) then return new; end if;
  insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id, at)
  values (gen_random_uuid(), v_order.shop_id, v_order.tenant_id, new.product_id, new.quantity, 'reserve', v_order.id, now());
  return new;
end $$;
drop trigger if exists order_items_reserve on suqa.order_items;
create trigger order_items_reserve after insert on suqa.order_items
  for each row execute function suqa.order_items_reserve();

create or replace function suqa.orders_stock_on_status() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_at text; v_item record;
begin
  if new.channel <> 'online' or new.status = old.status then return new; end if;
  select deduct_stock_at into v_at from suqa.shops where id = new.shop_id;

  if new.status::text = v_at or (new.status = 'delivered' and v_at = 'ready') then
    for v_item in select i.product_id, i.quantity from suqa.order_items i join suqa.products p on p.id = i.product_id
                   where i.order_id = new.id and p.track_stock and not i.voided loop
      if not exists (select 1 from suqa.stock_moves m where m.ref_order_id = new.id and m.product_id = v_item.product_id and m.kind = 'sale') then
        insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id)
        values (gen_random_uuid(), new.shop_id, new.tenant_id, v_item.product_id, -v_item.quantity, 'sale', new.id);
        if exists (select 1 from suqa.stock_moves m where m.ref_order_id = new.id and m.product_id = v_item.product_id and m.kind = 'reserve')
           and not exists (select 1 from suqa.stock_moves m where m.ref_order_id = new.id and m.product_id = v_item.product_id and m.kind = 'release') then
          insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id)
          values (gen_random_uuid(), new.shop_id, new.tenant_id, v_item.product_id, -v_item.quantity, 'release', new.id);
        end if;
      end if;
    end loop;
  elsif new.status in ('rejected','cancelled') then
    for v_item in select m.product_id, m.qty from suqa.stock_moves m
                   where m.ref_order_id = new.id and m.kind = 'reserve'
                     and not exists (select 1 from suqa.stock_moves r where r.ref_order_id = new.id and r.product_id = m.product_id and r.kind = 'release') loop
      insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id)
      values (gen_random_uuid(), new.shop_id, new.tenant_id, v_item.product_id, -v_item.qty, 'release', new.id);
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists orders_stock_on_status on suqa.orders;
create trigger orders_stock_on_status after update of status on suqa.orders
  for each row execute function suqa.orders_stock_on_status();

-- ---------- existing triggers: channel awareness ----------------------------------------------------------------
-- First order event: POS-created orders are acted on by the shop, not the customer.
create or replace function suqa.orders_on_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into suqa.order_events(order_id, tenant_id, from_status, to_status, actor_kind, actor_id)
  values (new.id, new.tenant_id, null, new.status,
          case when new.channel = 'online' then 'customer'::suqa.actor_kind else 'shop'::suqa.actor_kind end,
          case when new.channel = 'online' then new.customer_id else coalesce(new.staff_user_id, auth.uid()) end);
  return new;
end $$;

-- WhatsApp notifications: never for walk-in sales; the payload carries the channel so the web app can skip
-- the shop alert for orders the shop typed in itself (whatsapp/phone) while still updating the customer.
create or replace function suqa.notify_order_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text; v_event text;
begin
  if new.channel = 'walkin' then return new; end if;
  if tg_op = 'INSERT' then v_event := 'order.created';
  elsif new.status is distinct from old.status then v_event := 'order.status';
  else return new; end if;

  select value into v_url    from suqa.integration_config where key = 'wa_events_url';
  select value into v_secret from suqa.integration_config where key = 'wa_events_secret';
  if v_url is null or v_secret is null then return new; end if;

  perform net.http_post(
    url     := v_url,
    body    := suqa.order_event_payload(new, v_event, case when tg_op = 'UPDATE' then old.status end) || jsonb_build_object('channel', new.channel),
    headers := jsonb_build_object('content-type', 'application/json', 'x-suqa-secret', v_secret),
    timeout_milliseconds := 8000);
  return new;
end $$;

-- ---------- change feed trigger -----------------------------------------------------------------------------------
create or replace function suqa.sync_log_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_row jsonb; v_shop uuid; v_tenant uuid; v_id text; v_dev uuid;
begin
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_tenant := (v_row->>'tenant_id')::uuid;
  v_shop   := (v_row->>'shop_id')::uuid;
  if tg_table_name = 'shops' then v_shop := (v_row->>'id')::uuid; end if;
  if tg_table_name = 'shop_members' then
    v_id := (v_row->>'shop_id') || ':' || (v_row->>'user_id');
    select tenant_id into v_tenant from suqa.shops where id = v_shop;
  elsif tg_table_name = 'product_barcodes' then
    v_id := (v_row->>'product_id') || ':' || (v_row->>'barcode');
  else
    v_id := v_row->>'id';
  end if;
  if tg_table_name = 'shops' then
    -- merchants' devices need settings, not the contract
    v_row := v_row - 'commission_rate' - 'cover_url' - 'location';
  end if;
  v_dev := nullif(current_setting('suqa.device', true), '')::uuid;
  insert into suqa.sync_log (tenant_id, shop_id, tbl, row_id, op, row, origin_device)
  values (v_tenant, v_shop, tg_table_name, v_id, case when tg_op = 'DELETE' then 'delete' else 'upsert' end, v_row, v_dev);
  return null;
end $$;

do $$ declare t text; begin
  foreach t in array array['products','product_barcodes','categories','quick_buttons','exchange_rates','shops','shop_members',
                           'orders','order_items','payments','stock_moves','shifts','cash_moves','devices','conflict_log','returns','return_lines'] loop
    execute format('drop trigger if exists sync_log on suqa.%I', t);
    execute format('create trigger sync_log after insert or update or delete on suqa.%I for each row execute function suqa.sync_log_row()', t);
  end loop;
end $$;

-- Realtime: devices subscribe to sync_log inserts (poke only; data always comes through pos_pull).
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'suqa' and tablename = 'sync_log') then
    alter publication supabase_realtime add table suqa.sync_log;
  end if;
exception when undefined_object then null; end $$;

-- Retention: 30 days (a device further behind does a full resync).
create or replace function suqa.pos_prune_sync_log() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from suqa.sync_log where at < now() - interval '30 days';
  get diagnostics n = row_count;
  delete from suqa.pos_ops where applied_at < now() - interval '60 days';
  return n;
end $$;
do $$ begin
  perform cron.schedule('suqa-pos-prune', '17 3 * * *', $c$select suqa.pos_prune_sync_log()$c$);
exception when others then null; end $$;   -- pg_cron not enabled: prune manually or enable it later

-- ---------- role helpers ---------------------------------------------------------------------------------------------
create or replace function suqa.pos_role(p_shop uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when suqa.is_platform_admin() or suqa.is_tenant_member((select tenant_id from suqa.shops where id = p_shop)) then 'owner'
    else (select case role::text when 'staff' then 'cashier' else role::text end
            from suqa.shop_members where shop_id = p_shop and user_id = auth.uid() and active) end
$$;

-- ---------- device registration / revoke / PIN ----------------------------------------------------------------------
create or replace function suqa.pos_register_device(p_id uuid, p_shop uuid, p_name text, p_user_agent text default null, p_app_version text default null)
returns suqa.devices
language plpgsql security definer set search_path = public as $$
declare v_shop suqa.shops; v_dev suqa.devices; v_prefix text; v_n int;
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = 'insufficient_privilege'; end if;
  select * into v_shop from suqa.shops where id = p_shop;
  if not found then raise exception 'shop_not_found'; end if;
  if suqa.pos_role(p_shop) is null then raise exception 'not_a_member' using errcode = 'insufficient_privilege'; end if;
  if not v_shop.pos_enabled and not suqa.is_tenant_member(v_shop.tenant_id) then raise exception 'pos_disabled'; end if;

  select * into v_dev from suqa.devices where id = p_id;
  if found then
    if v_dev.revoked_at is not null then raise exception 'device_revoked'; end if;
    update suqa.devices set name = coalesce(p_name, name), user_agent = coalesce(p_user_agent, user_agent),
                            app_version = coalesce(p_app_version, app_version) where id = p_id returning * into v_dev;
    return v_dev;
  end if;

  -- next free prefix: A..Z, then AA, AB, …
  select count(*) into v_n from suqa.devices where shop_id = p_shop;
  loop
    v_prefix := case when v_n < 26 then chr(65 + v_n) else chr(65 + (v_n / 26) - 1) || chr(65 + (v_n % 26)) end;
    exit when not exists (select 1 from suqa.devices where shop_id = p_shop and prefix = v_prefix);
    v_n := v_n + 1;
  end loop;

  insert into suqa.devices (id, shop_id, tenant_id, name, prefix, user_agent, registered_by, app_version)
  values (p_id, p_shop, v_shop.tenant_id, coalesce(nullif(p_name, ''), 'Device ' || v_prefix), v_prefix, p_user_agent, auth.uid(), p_app_version)
  returning * into v_dev;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, device_id, action, ref_tbl, ref_id, after)
  values (p_shop, v_shop.tenant_id, auth.uid(), p_id, 'device.register', 'devices', p_id::text, to_jsonb(v_dev));
  return v_dev;
end $$;
grant execute on function suqa.pos_register_device(uuid, uuid, text, text, text) to authenticated;

create or replace function suqa.pos_revoke_device(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_dev suqa.devices;
begin
  select * into v_dev from suqa.devices where id = p_id;
  if not found then raise exception 'device_not_found'; end if;
  if suqa.pos_role(v_dev.shop_id) <> 'owner' then raise exception 'owner_only' using errcode = 'insufficient_privilege'; end if;
  update suqa.devices set revoked_at = now(), revoked_by = auth.uid() where id = p_id and revoked_at is null;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, device_id, action, ref_tbl, ref_id)
  values (v_dev.shop_id, v_dev.tenant_id, auth.uid(), p_id, 'device.revoke', 'devices', p_id::text);
end $$;
grant execute on function suqa.pos_revoke_device(uuid) to authenticated;

-- PIN: hashed client-side (PBKDF2-SHA256, 100k iterations, per-user salt); the server never sees the PIN.
create or replace function suqa.pos_set_pin(p_shop uuid, p_user uuid, p_hash text, p_salt text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = 'insufficient_privilege'; end if;
  if p_user <> auth.uid() and suqa.pos_role(p_shop) <> 'owner' then raise exception 'owner_only' using errcode = 'insufficient_privilege'; end if;
  update suqa.shop_members set pin_hash = p_hash, pin_salt = p_salt, pin_set_at = now() where shop_id = p_shop and user_id = p_user;
  if not found then raise exception 'not_a_member'; end if;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id)
  select p_shop, tenant_id, auth.uid(), 'pin.set', 'shop_members', p_user::text from suqa.shops where id = p_shop;
end $$;
grant execute on function suqa.pos_set_pin(uuid, uuid, text, text) to authenticated;

-- ---------- pull ------------------------------------------------------------------------------------------------------
create or replace function suqa.pos_pull(p_device uuid, p_cursor bigint, p_limit int default 1000)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_dev suqa.devices; v_role text; v_rows jsonb; v_next bigint; v_oldest bigint; v_count int;
begin
  select * into v_dev from suqa.devices where id = p_device;
  if not found then raise exception 'device_not_found'; end if;
  if v_dev.revoked_at is not null then raise exception 'device_revoked'; end if;
  v_role := suqa.pos_role(v_dev.shop_id);
  if v_role is null then raise exception 'not_a_member' using errcode = 'insufficient_privilege'; end if;

  select min(seq) into v_oldest from suqa.sync_log where shop_id = v_dev.shop_id or (shop_id is null and tenant_id = v_dev.tenant_id);
  if p_cursor > 0 and v_oldest is not null and p_cursor < v_oldest - 1 then
    return jsonb_build_object('resync', true, 'cursor', 0, 'server_now', now());
  end if;

  with page as (
    select seq, tbl, row_id, op, origin_device,
           case when tbl in ('products','order_items') and v_role <> 'owner' then row - 'cost_cents' else row end as row
      from suqa.sync_log
     where seq > p_cursor
       and (shop_id = v_dev.shop_id or (shop_id is null and tenant_id = v_dev.tenant_id))
     order by seq
     limit greatest(1, least(p_limit, 2000)))
  select coalesce(jsonb_agg(to_jsonb(page) order by seq), '[]'::jsonb), max(seq), count(*) into v_rows, v_next, v_count from page;

  update suqa.devices set last_sync_at = now(), last_cursor = greatest(last_cursor, coalesce(v_next, p_cursor)) where id = p_device;
  return jsonb_build_object('rows', v_rows, 'cursor', coalesce(v_next, p_cursor), 'count', v_count,
                            'server_now', now(), 'role', v_role,
                            'device', jsonb_build_object('id', v_dev.id, 'prefix', v_dev.prefix, 'name', v_dev.name));
end $$;
grant execute on function suqa.pos_pull(uuid, bigint, int) to authenticated;

-- Snapshot for first load (same shape as feed rows, cursor = current max seq).
create or replace function suqa.pos_snapshot(p_device uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_dev suqa.devices; v_role text; v_cursor bigint; v_owner boolean;
begin
  select * into v_dev from suqa.devices where id = p_device;
  if not found then raise exception 'device_not_found'; end if;
  if v_dev.revoked_at is not null then raise exception 'device_revoked'; end if;
  v_role := suqa.pos_role(v_dev.shop_id);
  if v_role is null then raise exception 'not_a_member' using errcode = 'insufficient_privilege'; end if;
  v_owner := v_role = 'owner';
  select coalesce(max(seq), 0) into v_cursor from suqa.sync_log;

  return jsonb_build_object(
    'cursor', v_cursor, 'server_now', now(), 'role', v_role,
    'device', jsonb_build_object('id', v_dev.id, 'prefix', v_dev.prefix, 'name', v_dev.name),
    'shop', (select to_jsonb(s) - 'commission_rate' - 'cover_url' - 'location' from suqa.shops s where s.id = v_dev.shop_id),
    'categories', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from suqa.categories c where c.tenant_id = v_dev.tenant_id),
    'products', (select coalesce(jsonb_agg(case when v_owner then to_jsonb(p) else to_jsonb(p) - 'cost_cents' end), '[]')
                   from suqa.products p where p.shop_id = v_dev.shop_id and p.is_active),
    'product_barcodes', (select coalesce(jsonb_agg(to_jsonb(b)), '[]') from suqa.product_barcodes b where b.shop_id = v_dev.shop_id),
    'quick_buttons', (select coalesce(jsonb_agg(to_jsonb(q)), '[]') from suqa.quick_buttons q where q.shop_id = v_dev.shop_id),
    'exchange_rates', (select coalesce(jsonb_agg(to_jsonb(r)), '[]') from (select * from suqa.exchange_rates where shop_id = v_dev.shop_id order by effective_at desc limit 50) r),
    'shop_members', (select coalesce(jsonb_agg(to_jsonb(m) || jsonb_build_object('full_name', p.full_name)), '[]')
                       from suqa.shop_members m left join suqa.profiles p on p.id = m.user_id where m.shop_id = v_dev.shop_id),
    'devices', (select coalesce(jsonb_agg(to_jsonb(d)), '[]') from suqa.devices d where d.shop_id = v_dev.shop_id),
    'orders', (select coalesce(jsonb_agg(to_jsonb(o)), '[]') from suqa.orders o
                where o.shop_id = v_dev.shop_id and (o.closed_at is null or o.placed_at > now() - interval '7 days')),
    'order_items', (select coalesce(jsonb_agg(case when v_owner then to_jsonb(i) else to_jsonb(i) - 'cost_cents' end), '[]')
                      from suqa.order_items i join suqa.orders o on o.id = i.order_id
                     where o.shop_id = v_dev.shop_id and (o.closed_at is null or o.placed_at > now() - interval '7 days')),
    'payments', (select coalesce(jsonb_agg(to_jsonb(p)), '[]') from suqa.payments p join suqa.orders o on o.id = p.order_id
                  where o.shop_id = v_dev.shop_id and (o.closed_at is null or o.placed_at > now() - interval '7 days')),
    'shifts', (select coalesce(jsonb_agg(to_jsonb(s)), '[]') from suqa.shifts s where s.shop_id = v_dev.shop_id and (s.closed_at is null or s.opened_at > now() - interval '7 days')),
    'cash_moves', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from suqa.cash_moves c join suqa.shifts s on s.id = c.shift_id
                    where s.shop_id = v_dev.shop_id and (s.closed_at is null or s.opened_at > now() - interval '7 days')),
    'stock_moves', (select coalesce(jsonb_agg(to_jsonb(m)), '[]') from (select * from suqa.stock_moves where shop_id = v_dev.shop_id order by at desc limit 2000) m)
  );
end $$;
grant execute on function suqa.pos_snapshot(uuid) to authenticated;

-- ---------- push: op handlers ---------------------------------------------------------------------------------------------
-- Each handler is idempotent on row ids (ON CONFLICT DO NOTHING) so a crash between apply and recording the op is harmless.

create or replace function suqa._pos_sale_commit(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_order suqa.orders; v_l jsonb; v_number text; v_status suqa.order_status; v_channel text; v_rate int;
begin
  v_channel := coalesce(p->>'channel', 'walkin');
  if v_channel not in ('walkin','whatsapp','phone') then raise exception 'bad_channel'; end if;
  v_status := coalesce(p->>'status', case when v_channel = 'walkin' then 'delivered' else 'accepted' end)::suqa.order_status;
  v_rate := coalesce((p->>'rate_lbp_per_usd')::int, (select lbp_per_usd from suqa.exchange_rates where shop_id = d.shop_id order by effective_at desc limit 1),
                     (select fx_lbp_rate::int from suqa.tenants where id = d.tenant_id));

  select * into v_order from suqa.orders where id = (p->>'id')::uuid;
  if not found then
    v_number := suqa.next_order_number(d.tenant_id);
    insert into suqa.orders (
      id, tenant_id, shop_id, customer_id, number, status, channel, device_id, staff_user_id, local_number, shift_id, parked,
      payment_method, address, customer_name, customer_phone, customer_notes, fulfillment, notify_customer,
      subtotal_usd, delivery_fee_usd, total_usd, fx_lbp_rate, commission_rate, commission_usd,
      rate_lbp_per_usd, subtotal_cents, discount_cents, discount_reason, total_cents, total_lbp,
      paid_usd_cents, paid_lbp, change_usd_cents, change_lbp, placed_at, delivered_at, closed_at)
    values (
      (p->>'id')::uuid, d.tenant_id, d.shop_id, nullif(p->>'customer_id','')::uuid, v_number, v_status, v_channel, d.id, p_user,
      p->>'local_number', nullif(p->>'shift_id','')::uuid, coalesce((p->>'parked')::boolean, false),
      'cod', coalesce(p->'address', '{}'::jsonb), coalesce(p->>'customer_name', ''), coalesce(p->>'customer_phone', ''), p->>'notes',
      coalesce(p->>'fulfillment', 'pickup'), coalesce((p->>'notify_customer')::boolean, v_channel <> 'walkin'),
      coalesce((p->>'subtotal_cents')::numeric, 0) / 100, coalesce((p->>'delivery_fee_cents')::numeric, 0) / 100, coalesce((p->>'total_cents')::numeric, 0) / 100,
      v_rate, 0, 0,
      v_rate, (p->>'subtotal_cents')::int, coalesce((p->>'discount_cents')::int, 0), p->>'discount_reason', (p->>'total_cents')::int, (p->>'total_lbp')::bigint,
      coalesce((p->>'paid_usd_cents')::int, 0), coalesce((p->>'paid_lbp')::bigint, 0), coalesce((p->>'change_usd_cents')::int, 0), coalesce((p->>'change_lbp')::bigint, 0),
      coalesce((p->>'placed_at')::timestamptz, now()),
      case when v_status = 'delivered' then coalesce((p->>'placed_at')::timestamptz, now()) end,
      case when v_status = 'delivered' then coalesce((p->>'placed_at')::timestamptz, now()) end)
    returning * into v_order;
  end if;

  for v_l in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    insert into suqa.order_items (id, order_id, tenant_id, shop_id, product_id, name, unit, unit_price_usd, quantity, line_total_usd, notes,
                                  price_currency, unit_price_cents, unit_price_lbp, discount_cents, line_total_cents, cost_cents)
    values ((v_l->>'id')::uuid, v_order.id, d.tenant_id, d.shop_id, nullif(v_l->>'product_id','')::uuid, coalesce(v_l->'name', '{}'::jsonb), v_l->>'unit',
            coalesce((v_l->>'unit_price_cents')::numeric, 0) / 100, (v_l->>'qty')::numeric, coalesce((v_l->>'line_total_cents')::numeric, 0) / 100, v_l->>'notes',
            coalesce(v_l->>'price_currency', 'usd'), (v_l->>'unit_price_cents')::int, (v_l->>'unit_price_lbp')::bigint,
            coalesce((v_l->>'discount_cents')::int, 0), (v_l->>'line_total_cents')::int, (v_l->>'cost_cents')::int)
    on conflict (id) do nothing;
  end loop;

  for v_l in select * from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) loop
    insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, reference, unpaid_name, unpaid_phone, note, at)
    values ((v_l->>'id')::uuid, v_order.id, d.shop_id, d.tenant_id, v_l->>'tender', (v_l->>'amount')::bigint, v_l->>'currency',
            v_l->>'reference', v_l->>'unpaid_name', v_l->>'unpaid_phone', v_l->>'note', coalesce((v_l->>'at')::timestamptz, now()))
    on conflict (id) do nothing;
  end loop;

  for v_l in select * from jsonb_array_elements(coalesce(p->'stock_moves', '[]'::jsonb)) loop
    insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id, device_id, user_id, at)
    values ((v_l->>'id')::uuid, d.shop_id, d.tenant_id, (v_l->>'product_id')::uuid, (v_l->>'qty')::numeric, coalesce(v_l->>'kind', 'sale'),
            v_order.id, d.id, p_user, coalesce((v_l->>'at')::timestamptz, now()))
    on conflict (id) do nothing;
  end loop;

  return jsonb_build_object('number', v_order.number, 'id', v_order.id);
end $$;

create or replace function suqa._pos_order_status(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_order suqa.orders;
begin
  select * into v_order from suqa.orders where id = (p->>'id')::uuid and shop_id = d.shop_id;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.status::text = p->>'status' then return jsonb_build_object('status', v_order.status, 'noop', true); end if;
  update suqa.orders
     set status = (p->>'status')::suqa.order_status,
         reject_reason = coalesce(p->>'reject_reason', reject_reason),
         cancel_reason = coalesce(p->>'cancel_reason', cancel_reason),
         shop_notes = coalesce(p->>'shop_notes', shop_notes),
         notify_customer = coalesce((p->>'notify_customer')::boolean, notify_customer),
         eta_minutes = coalesce((p->>'eta_minutes')::int, eta_minutes)
   where id = v_order.id;
  return jsonb_build_object('status', p->>'status');
end $$;

create or replace function suqa._pos_stock_move(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if (p->>'kind') not in ('receive','adjust','count','damaged','return') then raise exception 'bad_kind'; end if;
  insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_id, unit_cost_cents, note, device_id, user_id, at)
  values ((p->>'id')::uuid, d.shop_id, d.tenant_id, (p->>'product_id')::uuid, (p->>'qty')::numeric, p->>'kind', nullif(p->>'ref_id','')::uuid,
          (p->>'unit_cost_cents')::int, p->>'note', d.id, p_user, coalesce((p->>'at')::timestamptz, now()))
  on conflict (id) do nothing;
  if (p->>'unit_cost_cents') is not null then
    update suqa.products set cost_cents = (p->>'unit_cost_cents')::int where id = (p->>'product_id')::uuid and shop_id = d.shop_id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Field patch with server-wins LWW: if the row changed after the device's base version, overwritten values go to conflict_log.
create or replace function suqa._pos_product_patch(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_prod suqa.products; v_fields jsonb; v_k text; v_v jsonb; v_base timestamptz; v_conf int := 0; v_allowed text[] :=
  array['name','description','price_usd','price_currency','price_lbp','cost_cents','sku','unit','unit_kind','decimal_qty','vat','track_stock','min_stock',
        'visible_online','is_available','is_active','category_id','section','sort_order','image_url'];
begin
  v_fields := p->'fields'; v_base := (p->>'base_updated_at')::timestamptz;
  if (p->>'id') is null then
    -- new product created offline
    insert into suqa.products (id, tenant_id, shop_id, name, price_usd) values ((p->>'new_id')::uuid, d.tenant_id, d.shop_id, '{}'::jsonb, 0) on conflict (id) do nothing;
    select * into v_prod from suqa.products where id = (p->>'new_id')::uuid;
  else
    select * into v_prod from suqa.products where id = (p->>'id')::uuid and shop_id = d.shop_id;
    if not found then raise exception 'product_not_found'; end if;
  end if;

  for v_k, v_v in select * from jsonb_each(v_fields) loop
    if v_k <> all (v_allowed) then raise exception 'field_not_allowed' using detail = v_k; end if;
    if v_base is not null and v_prod.updated_at > v_base and to_jsonb(v_prod)->v_k is distinct from v_v then
      insert into suqa.conflict_log (shop_id, tenant_id, tbl, row_id, field, old_value, new_value, by_device, by_user)
      values (d.shop_id, d.tenant_id, 'products', v_prod.id::text, v_k, to_jsonb(v_prod)->v_k, v_v, d.id, p_user);
      v_conf := v_conf + 1;
    end if;
    execute format('update suqa.products set %I = ($1->>%L)::%s where id = $2', v_k, v_k,
                   (select format_type(a.atttypid, a.atttypmod) from pg_attribute a where a.attrelid = 'suqa.products'::regclass and a.attname = v_k))
      using v_fields, v_prod.id;
  end loop;

  for v_v in select * from jsonb_array_elements(coalesce(p->'barcodes_add', '[]'::jsonb)) loop
    insert into suqa.product_barcodes (product_id, shop_id, tenant_id, barcode) values (v_prod.id, d.shop_id, d.tenant_id, v_v#>>'{}') on conflict do nothing;
  end loop;
  for v_v in select * from jsonb_array_elements(coalesce(p->'barcodes_remove', '[]'::jsonb)) loop
    delete from suqa.product_barcodes where product_id = v_prod.id and barcode = v_v#>>'{}';
  end loop;
  return jsonb_build_object('conflicts', v_conf);
end $$;

create or replace function suqa._pos_shift(d suqa.devices, p jsonb, p_user uuid, p_kind text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_kind = 'shift.open' then
    insert into suqa.shifts (id, shop_id, tenant_id, device_id, opened_by, opened_at, float_usd_cents, float_lbp)
    values ((p->>'id')::uuid, d.shop_id, d.tenant_id, d.id, p_user, coalesce((p->>'opened_at')::timestamptz, now()),
            coalesce((p->>'float_usd_cents')::int, 0), coalesce((p->>'float_lbp')::bigint, 0))
    on conflict (id) do nothing;
  else
    update suqa.shifts set closed_by = p_user, closed_at = coalesce((p->>'closed_at')::timestamptz, now()),
           counted_usd_cents = (p->>'counted_usd_cents')::int, counted_lbp = (p->>'counted_lbp')::bigint,
           expected_usd_cents = (p->>'expected_usd_cents')::int, expected_lbp = (p->>'expected_lbp')::bigint,
           diff_usd_cents = (p->>'diff_usd_cents')::int, diff_lbp = (p->>'diff_lbp')::bigint, note = p->>'note'
     where id = (p->>'id')::uuid and shop_id = d.shop_id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function suqa._pos_cash_move(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  insert into suqa.cash_moves (id, shift_id, shop_id, tenant_id, kind, amount, currency, reason, user_id, at)
  values ((p->>'id')::uuid, (p->>'shift_id')::uuid, d.shop_id, d.tenant_id, p->>'kind', (p->>'amount')::bigint, p->>'currency', p->>'reason', p_user,
          coalesce((p->>'at')::timestamptz, now()))
  on conflict (id) do nothing;
  return jsonb_build_object('ok', true);
end $$;

create or replace function suqa._pos_rate_set(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  insert into suqa.exchange_rates (id, shop_id, tenant_id, lbp_per_usd, effective_at, set_by)
  values ((p->>'id')::uuid, d.shop_id, d.tenant_id, (p->>'lbp_per_usd')::int, coalesce((p->>'effective_at')::timestamptz, now()), p_user)
  on conflict (id) do nothing;
  return jsonb_build_object('ok', true);
end $$;

create or replace function suqa._pos_sale_cancel(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return jsonb_build_object('ok', true, 'reason', p->>'reason');   -- audited by pos_push; nothing sold
end $$;

-- ---------- push ------------------------------------------------------------------------------------------------------------
create or replace function suqa.pos_push(p_device uuid, p_ops jsonb, p_pending int default 0)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_dev suqa.devices; v_role text; v_op jsonb; v_id uuid; v_kind text; v_res jsonb; v_out jsonb := '[]'::jsonb;
        v_user uuid := auth.uid(); v_admin boolean; v_detail text;
begin
  if v_user is null then raise exception 'not_signed_in' using errcode = 'insufficient_privilege'; end if;
  select * into v_dev from suqa.devices where id = p_device;
  if not found then raise exception 'device_not_found'; end if;
  if v_dev.revoked_at is not null then raise exception 'device_revoked'; end if;
  v_role := suqa.pos_role(v_dev.shop_id);
  if v_role is null then raise exception 'not_a_member' using errcode = 'insufficient_privilege'; end if;
  v_admin := suqa.is_platform_admin();
  perform set_config('suqa.device', p_device::text, true);
  if jsonb_typeof(p_ops) <> 'array' then raise exception 'bad_ops'; end if;

  for v_op in select * from jsonb_array_elements(p_ops) loop
    v_id := (v_op->>'op_id')::uuid; v_kind := v_op->>'kind';
    select result into v_res from suqa.pos_ops where op_id = v_id;
    if found then
      v_out := v_out || (v_res || jsonb_build_object('op_id', v_id, 'replayed', true));
      continue;
    end if;

    begin
      -- role gate (server truth; the UI gates too)
      if v_role = 'stock' and v_kind not in ('stock.move','product.patch') then raise exception 'role_not_allowed' using errcode = 'insufficient_privilege'; end if;
      if v_role = 'cashier' and v_kind in ('rate.set','product.patch','stock.move') and coalesce((v_op->'payload'->>'approved_by'), '') = '' then
        raise exception 'owner_approval_required' using errcode = 'insufficient_privilege';
      end if;

      v_res := case v_kind
        when 'sale.commit'   then suqa._pos_sale_commit(v_dev, v_op->'payload', coalesce(nullif(v_op->'payload'->>'staff_user_id','')::uuid, v_user))
        when 'sale.cancel'   then suqa._pos_sale_cancel(v_dev, v_op->'payload', v_user)
        when 'order.status'  then suqa._pos_order_status(v_dev, v_op->'payload', v_user)
        when 'stock.move'    then suqa._pos_stock_move(v_dev, v_op->'payload', v_user)
        when 'product.patch' then suqa._pos_product_patch(v_dev, v_op->'payload', v_user)
        when 'shift.open'    then suqa._pos_shift(v_dev, v_op->'payload', v_user, 'shift.open')
        when 'shift.close'   then suqa._pos_shift(v_dev, v_op->'payload', v_user, 'shift.close')
        when 'cash.move'     then suqa._pos_cash_move(v_dev, v_op->'payload', v_user)
        when 'rate.set'      then suqa._pos_rate_set(v_dev, v_op->'payload', v_user)
        else null end;
      if v_res is null then raise exception 'unknown_op' using detail = v_kind; end if;
      v_res := v_res || jsonb_build_object('status', 'ok');
    exception when others then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_res := jsonb_build_object('status', 'rejected', 'error', sqlerrm, 'code', sqlstate, 'detail', coalesce(v_detail, ''));
    end;

    insert into suqa.pos_ops (op_id, device_id, shop_id, kind, schema_version, result)
    values (v_id, p_device, v_dev.shop_id, v_kind, coalesce((v_op->>'schema_version')::int, 1), v_res);
    insert into suqa.audit_log (shop_id, tenant_id, user_id, device_id, action, ref_id, after, acting_as_admin)
    values (v_dev.shop_id, v_dev.tenant_id, v_user, p_device, v_kind, v_op->'payload'->>'id', v_op->'payload' || jsonb_build_object('result', v_res), v_admin);
    v_out := v_out || (v_res || jsonb_build_object('op_id', v_id));
  end loop;

  update suqa.devices set last_sync_at = now(), pending_count = greatest(p_pending, 0) where id = p_device;
  return jsonb_build_object('results', v_out, 'server_now', now());
end $$;
grant execute on function suqa.pos_push(uuid, jsonb, int) to authenticated;

-- ---------- RLS -----------------------------------------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['product_barcodes','quick_buttons','devices','pos_ops','sync_log','conflict_log','audit_log','exchange_rates',
                           'stock_moves','payments','shifts','cash_moves','returns','return_lines'] loop
    execute format('alter table suqa.%I enable row level security', t);
  end loop;
end $$;

-- shop members read everything of their shop; writes go through pos_push (security definer) except where noted
select suqa._policy('product_barcodes','pb_read','select','authenticated','suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('product_barcodes','pb_write','all','authenticated','suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)','suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('quick_buttons','qb_read','select','authenticated','suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('quick_buttons','qb_write','all','authenticated','suqa.is_shop_owner(shop_id) or suqa.is_tenant_member(tenant_id)','suqa.is_shop_owner(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('devices','dev_read','select','authenticated','suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('devices','dev_owner_update','update','authenticated','suqa.is_shop_owner(shop_id) or suqa.is_tenant_member(tenant_id)','suqa.is_shop_owner(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('sync_log','sl_read','select','authenticated',
  '(shop_id is not null and (suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id))) or (shop_id is null and suqa.is_tenant_member(tenant_id))');
select suqa._policy('conflict_log','cl_owner','all','authenticated','suqa.is_shop_owner(shop_id) or suqa.is_tenant_member(tenant_id)','suqa.is_shop_owner(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('audit_log','al_owner_read','select','authenticated','suqa.is_shop_owner(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('exchange_rates','xr_read','select','authenticated','suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('exchange_rates','xr_owner_write','insert','authenticated',null,'suqa.is_shop_owner(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('stock_moves','sm_read','select','authenticated','suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('payments','pay_read','select','authenticated','suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('shifts','sh_read','select','authenticated','suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('cash_moves','cm_read','select','authenticated','suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('returns','ret_read','select','authenticated','suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('return_lines','rl_read','select','authenticated','suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
-- pos_ops: no policies → invisible to app roles

-- orders read: shop members already see their shop's orders; staff_user_id/customer null is fine with the existing policy.
-- shop_members: pin_hash is readable by shop members (needed offline for staff switch); never by customers.

grant select, insert, update, delete on suqa.product_barcodes, suqa.quick_buttons, suqa.devices, suqa.sync_log, suqa.conflict_log, suqa.audit_log,
  suqa.exchange_rates, suqa.stock_moves, suqa.payments, suqa.shifts, suqa.cash_moves, suqa.returns, suqa.return_lines to authenticated;
revoke all on suqa.pos_ops from anon, authenticated;
grant usage, select on sequence suqa.sync_log_seq_seq, suqa.audit_log_id_seq to authenticated;

select 'pos installed' as result;
