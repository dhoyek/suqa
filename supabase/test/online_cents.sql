-- 83: online orders get cents, the rate and the lira total; POS orders untouched. One transaction on a database built from all.sql.
\set ON_ERROR_STOP on
begin;
create schema if not exists net;
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 1000)
returns bigint language sql as $$ select 1::bigint $$;
do $$
declare v_shop uuid := (select id from suqa.shops where slug = 'abou-elie'); v_t uuid := (select tenant_id from suqa.shops where slug = 'abou-elie');
        v_old uuid := gen_random_uuid(); v_pos uuid := gen_random_uuid();
begin
  -- an online order saved the old way (dollars only), inserted with triggers off as it is today on prod
  set local session_replication_role = replica;
  insert into suqa.orders (id, tenant_id, shop_id, number, channel, status, fulfillment, subtotal_usd, delivery_fee_usd, total_usd, fx_lbp_rate)
  values (v_old, v_t, v_shop, 'T-ONLINE-1', 'online', 'preparing', 'delivery', 6.67, 1, 7.67, 90000);
  insert into suqa.order_items (order_id, tenant_id, shop_id, name, unit_price_usd, quantity, line_total_usd) values (v_old, v_t, v_shop, '{"ar":"خبصة"}', 6.67, 1, 6.67);
  -- a POS order with its own cents and rate (must stay exactly as it is)
  insert into suqa.orders (id, tenant_id, shop_id, number, channel, status, fulfillment, subtotal_usd, total_usd, fx_lbp_rate, rate_lbp_per_usd, subtotal_cents, discount_cents, total_cents, total_lbp)
  values (v_pos, v_t, v_shop, 'T-POS-1', 'walkin', 'delivered', 'pickup', 5, 5, 90000, 89500, 500, 0, 500, 450000);
  set local session_replication_role = origin;
end $$;

\i supabase/schema/83_online_order_cents.sql

do $$
declare o suqa.orders; i suqa.order_items; v_new uuid := gen_random_uuid();
        v_shop uuid := (select id from suqa.shops where slug = 'abou-elie'); v_t uuid := (select tenant_id from suqa.shops where slug = 'abou-elie');
begin
  -- the old online order is filled
  select * into o from suqa.orders where number = 'T-ONLINE-1';
  assert o.total_cents = 767 and o.subtotal_cents = 667 and o.discount_cents = 0 and o.rate_lbp_per_usd = 90000 and o.total_lbp = 690000, 'backfill order: ' || row_to_json(o)::text;
  select * into i from suqa.order_items where order_id = o.id;
  assert i.line_total_cents = 667 and i.unit_price_cents = 667 and i.discount_cents = 0, 'backfill line';
  -- the POS order is untouched
  select * into o from suqa.orders where number = 'T-POS-1';
  assert o.rate_lbp_per_usd = 89500 and o.total_cents = 500 and o.total_lbp = 450000, 'POS order untouched';

  -- a new online order (dollars only) is filled on insert, its line too; 3 × 600,000 L.L. item = $20.00 → 1,800,000 + $1 fee
  insert into suqa.orders (id, tenant_id, shop_id, number, channel, status, fulfillment, subtotal_usd, delivery_fee_usd, total_usd, fx_lbp_rate)
  values (v_new, v_t, v_shop, 'T-ONLINE-2', 'online', 'pending', 'delivery', 20.00, 1, 21.00, 90000);
  insert into suqa.order_items (order_id, tenant_id, shop_id, name, unit_price_usd, quantity, line_total_usd) values (v_new, v_t, v_shop, '{"ar":"بيتزا"}', 6.67, 3, 20.00);
  select * into o from suqa.orders where id = v_new;
  assert o.total_cents = 2100 and o.subtotal_cents = 2000 and o.rate_lbp_per_usd = 90000 and o.total_lbp = 1890000, 'insert fill: ' || row_to_json(o)::text;
  select * into i from suqa.order_items where order_id = v_new;
  assert i.line_total_cents = 2000 and i.unit_price_cents = 667, 'insert line fill';

  -- a POS-style insert with its own cents keeps them
  insert into suqa.orders (tenant_id, shop_id, number, channel, status, fulfillment, subtotal_usd, total_usd, fx_lbp_rate, rate_lbp_per_usd, subtotal_cents, discount_cents, total_cents, total_lbp)
  values (v_t, v_shop, 'T-POS-2', 'walkin', 'delivered', 'pickup', 3, 3, 90000, 89000, 300, 0, 300, 270000) returning * into o;
  assert o.rate_lbp_per_usd = 89000 and o.total_lbp = 270000 and o.total_cents = 300, 'POS insert untouched';

  -- running the script again changes nothing
  raise notice 'online cents: all checks passed';
end $$;
\i supabase/schema/83_online_order_cents.sql
rollback;
