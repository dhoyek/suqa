-- 128: an edited order keeps its lira total. Calls _order_recalc directly on a copied order (database owner).
\set ON_ERROR_STOP on
begin;
\i supabase/schema/128_order_recalc_lira.sql
do $$
declare v_src suqa.orders; v_id uuid := gen_random_uuid(); o suqa.orders; v_i suqa.order_items;
begin
  select * into v_src from suqa.orders order by placed_at desc limit 1;
  if v_src.id is null then raise exception 'no order in the fixtures'; end if;
  v_src.id := v_id; v_src.number := 'T128-' || left(v_id::text, 8); v_src.local_number := 'T-128'; v_src.rate_lbp_per_usd := 89000; v_src.discount_cents := 0; v_src.delivery_fee_usd := 0; v_src.commission_rate := 0;
  insert into suqa.orders select (v_src).*;
  select * into v_i from suqa.order_items limit 1;
  -- helper: one line
  create temp table t_line(n int, cur text, lbp numeric, cents int, qty numeric, disc int, tot int, voided boolean default false);
  insert into t_line values (1,'lbp',221760,249,1,0,249), (2,'lbp',274995,309,2,0,618), (3,'lbp',138465,156,3,0,467);
  insert into suqa.order_items select (jsonb_populate_record(v_i, jsonb_build_object('id', gen_random_uuid(), 'order_id', v_id, 'product_id', null, 'quantity', qty,
      'price_currency', cur, 'unit_price_lbp', lbp, 'unit_price_cents', cents, 'unit_price_usd', cents / 100.0, 'discount_cents', disc, 'line_total_cents', tot, 'line_total_usd', tot / 100.0, 'voided', voided))).* from t_line;

  -- 1. lira lines: exact lira sum; cents follow the sum
  perform suqa._order_recalc(v_id); select * into o from suqa.orders where id = v_id;
  assert o.total_lbp = 221760 + 549990 + 415395, 'lira total = exact sum, got ' || o.total_lbp;
  assert o.total_cents = round(1187145 * 100.0 / 89000), 'cents follow the lira sum, got ' || o.total_cents;
  assert o.subtotal_cents = o.total_cents;

  -- 2. + delivery fee and an order discount: converted at the rate, lira part untouched
  update suqa.orders set delivery_fee_usd = 2, discount_cents = 100 where id = v_id;
  perform suqa._order_recalc(v_id); select * into o from suqa.orders where id = v_id;
  assert o.total_cents = 1334 - 100 + 200, 'total cents ' || o.total_cents;
  assert o.total_lbp = 1187145 + 100 * 890, 'lira + fee − discount, got ' || o.total_lbp;

  -- 3. a dollar line joins: lira part exact, dollar part converted
  update suqa.orders set delivery_fee_usd = 0, discount_cents = 0 where id = v_id;
  insert into suqa.order_items select (jsonb_populate_record(v_i, jsonb_build_object('id', gen_random_uuid(), 'order_id', v_id, 'product_id', null, 'quantity', 2,
      'price_currency', 'usd', 'unit_price_lbp', 0, 'unit_price_cents', 500, 'unit_price_usd', 5, 'discount_cents', 0, 'line_total_cents', 1000, 'line_total_usd', 10, 'voided', false))).*;
  perform suqa._order_recalc(v_id); select * into o from suqa.orders where id = v_id;
  assert o.total_cents = 1334 + 1000 and o.total_lbp = 1187145 + 890000, 'mixed: ' || o.total_cents || ' / ' || o.total_lbp;

  -- 4. a voided lira line leaves the sum
  update suqa.order_items set voided = true where order_id = v_id and unit_price_lbp = 221760;
  perform suqa._order_recalc(v_id); select * into o from suqa.orders where id = v_id;
  assert o.total_lbp = 549990 + 415395 + 890000, 'voided line out, got ' || o.total_lbp;

  -- 5. lira lines whose cents were set on another basis (far from the lira price): computed as before (24)
  update suqa.order_items set line_total_cents = 900, unit_price_cents = 900 where order_id = v_id and unit_price_lbp = 274995;
  perform suqa._order_recalc(v_id); select * into o from suqa.orders where id = v_id;
  assert o.total_cents = 900 + 467 + 1000, 'old way cents ' || o.total_cents;
  assert o.total_lbp = round(2367 * 890.0), 'old way lira ' || o.total_lbp;

  -- 6. a dollar-only order: exactly as before
  delete from suqa.order_items where order_id = v_id and price_currency = 'lbp';
  perform suqa._order_recalc(v_id); select * into o from suqa.orders where id = v_id;
  assert o.total_cents = 1000 and o.total_lbp = 890000, 'dollar only';
  raise notice '128 ok';
end $$;
rollback;
