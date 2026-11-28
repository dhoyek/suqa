-- 130: bundles — the owner saves one, its price is spread over its items, an online order carries it. Rolls back.
\set ON_ERROR_STOP on
begin;
\i supabase/schema/130_offers_bundles.sql
\i supabase/schema/131_offers_price.sql
do $$
declare t suqa.tenants; s suqa.shops; a suqa.addresses; u uuid; own uuid; o suqa.orders; v_id uuid; v_id2 uuid; n int; li record;
        p1 suqa.products; p2 suqa.products; p3 suqa.products; v_err text;
begin
  select s0.* into s from suqa.shops s0 where s0.status = 'active' and (select count(*) from suqa.products x where x.shop_id = s0.id and x.is_active and x.is_available) >= 3
     and exists (select 1 from suqa.shop_members m where m.shop_id = s0.id and m.role = 'owner' and m.active) limit 1;
  select * into t from suqa.tenants where id = s.tenant_id;
  select user_id into own from suqa.shop_members where shop_id = s.id and role = 'owner' and active limit 1;
  select id into u from suqa.profiles where id <> own limit 1;
  update suqa.tenants set fx_lbp_rate = 90000 where id = t.id; select * into t from suqa.tenants where id = t.id;
  update suqa.shops set pickup_enabled = true, min_order_usd = 0 where id = s.id;
  delete from suqa.exchange_rates where shop_id = s.id;
  select * into p1 from suqa.products where shop_id = s.id and is_active and is_available order by id limit 1;
  select * into p2 from suqa.products where shop_id = s.id and is_active and is_available and id <> p1.id order by id limit 1;
  select * into p3 from suqa.products where shop_id = s.id and is_active and is_available and id not in (p1.id, p2.id) order by id limit 1;
  update suqa.products set price_currency = 'usd', price_lbp = 0, available_days = null, track_stock = false, price_usd = case id when p1.id then 2.50 when p2.id then 4.00 else 1.25 end where id in (p1.id, p2.id, p3.id);

  -- only the owner
  perform set_config('request.jwt.claim.sub', u::text, true);
  begin perform suqa.offer_save(s.id, '{}'::jsonb); raise exception 'a stranger saved an offer'; exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub', own::text, true);

  -- what a bundle must have
  begin perform suqa.offer_save(s.id, jsonb_build_object('name', jsonb_build_object('ar', 'x'), 'price', 2, 'items', jsonb_build_array(jsonb_build_object('product_id', p1.id, 'quantity', 1))));
        raise exception 'one unit accepted'; exception when others then get stacked diagnostics v_err = message_text; assert v_err = 'offer_needs_two', v_err; end;
  begin perform suqa.offer_save(s.id, jsonb_build_object('name', jsonb_build_object('ar', 'x'), 'price', 9, 'items', jsonb_build_array(jsonb_build_object('product_id', p1.id, 'quantity', 1), jsonb_build_object('product_id', p2.id, 'quantity', 1))));
        raise exception 'no saving accepted'; exception when others then get stacked diagnostics v_err = message_text; assert v_err = 'offer_no_saving', v_err; end;
  begin perform suqa.offer_save(s.id, jsonb_build_object('name', jsonb_build_object('ar', 'x'), 'price_currency', 'lbp', 'price', 100000, 'items', jsonb_build_array(jsonb_build_object('product_id', p1.id, 'quantity', 2))));
        raise exception 'mixed currency accepted'; exception when others then get stacked diagnostics v_err = message_text; assert v_err = 'offer_mixed_currency', v_err; end;

  -- breakfast: 1 × $2.50 + 1 × $4.00 + 2 × $1.25 = $9.00 for $7.00
  v_id := suqa.offer_save(s.id, jsonb_build_object('name', jsonb_build_object('ar', 'فطور', 'en', 'Breakfast'), 'price', 7, 'is_hot', true,
            'items', jsonb_build_array(jsonb_build_object('product_id', p1.id, 'quantity', 1), jsonb_build_object('product_id', p2.id, 'quantity', 1), jsonb_build_object('product_id', p3.id, 'quantity', 2))));
  assert (select count(*) from suqa.offer_items where offer_id = v_id) = 3 and (select price_usd from suqa.offers where id = v_id) = 7.00;
  assert suqa._bundle_ok(v_id, 90000), 'on sale';
  assert (select sum(unit_cents * quantity) from suqa._bundle_lines(v_id, 90000)) = 700, 'charged exactly the bundle price: ' || (select sum(unit_cents * quantity) from suqa._bundle_lines(v_id, 90000));
  assert (select bool_and(unit_cents <= normal_cents) from suqa._bundle_lines(v_id, 90000)), 'no item above its normal price';

  -- an online order: 2 bundles + one ordinary item
  o := suqa._place_shop_order(t, s.id, u, a, jsonb_build_array(jsonb_build_object('offer_id', v_id, 'quantity', 2), jsonb_build_object('product_id', p3.id, 'quantity', 1)), null, 'T-130-A', null, null, null, 'pickup', null);
  assert o.subtotal_usd = 14.00 + 1.25, 'order: ' || o.subtotal_usd;
  assert (select count(*) from suqa.order_items where order_id = o.id) = 4, 'three bundle lines + one';
  assert (select sum(line_total_usd) from suqa.order_items where order_id = o.id and notes like '🎁 %') = 14.00, 'bundle lines add up';
  assert (select quantity from suqa.order_items where order_id = o.id and product_id = p3.id and notes like '🎁 %') = 4, '2 × 2';
  assert (select line_total_usd from suqa.order_items where order_id = o.id and product_id = p3.id and notes is null) = 1.25, 'the ordinary one at its normal price';

  -- edit: now 3 of one item for $3 (normal $3.75); a remainder no line can take is left to the customer (never above the price)
  v_id2 := suqa.offer_save(s.id, jsonb_build_object('name', jsonb_build_object('en', '3 for 3.10'), 'price', 3.10, 'max_per_order', 2, 'items', jsonb_build_array(jsonb_build_object('product_id', p3.id, 'quantity', 3))));
  select sum(unit_cents * quantity) into n from suqa._bundle_lines(v_id2, 90000);
  assert n = 309, 'three at 103: ' || n;
  begin o := suqa._place_shop_order(t, s.id, u, a, jsonb_build_array(jsonb_build_object('offer_id', v_id2, 'quantity', 3)), null, 'T-130-B', null, null, null, 'pickup', null);
        raise exception 'more than allowed per order'; exception when others then get stacked diagnostics v_err = message_text; assert v_err = 'offer_quantity', v_err; end;

  -- a lira bundle of lira items, at the shop's rate
  update suqa.products set price_currency = 'lbp', price_lbp = case id when p1.id then 221760 else 274995 end where id in (p1.id, p2.id);
  assert not suqa._bundle_ok(v_id, 90000), 'an item changed currency: the bundle is off';
  v_id := suqa.offer_save(s.id, jsonb_build_object('id', v_id, 'name', jsonb_build_object('ar', 'فطور'), 'price_currency', 'lbp', 'price', 450000,
            'items', jsonb_build_array(jsonb_build_object('product_id', p1.id, 'quantity', 1), jsonb_build_object('product_id', p2.id, 'quantity', 1))));
  assert (select count(*) from suqa.offer_items where offer_id = v_id) = 2, 'items replaced';
  assert (select sum(unit_cents * quantity) from suqa._bundle_lines(v_id, 90000)) = 500, '450,000 at 90,000';
  o := suqa._place_shop_order(t, s.id, u, a, jsonb_build_array(jsonb_build_object('offer_id', v_id, 'quantity', 1)), null, 'T-130-C', null, null, null, 'pickup', null);
  assert o.subtotal_usd = 5.00, 'lira bundle: ' || o.subtotal_usd;

  -- off: an item not available, the switch, the dates
  update suqa.products set is_available = false where id = p2.id;
  begin o := suqa._place_shop_order(t, s.id, u, a, jsonb_build_array(jsonb_build_object('offer_id', v_id, 'quantity', 1)), null, 'T-130-D', null, null, null, 'pickup', null);
        raise exception 'sold with an item out'; exception when others then get stacked diagnostics v_err = message_text; assert v_err = 'offer_unavailable', v_err; end;
  update suqa.products set is_available = true where id = p2.id;
  update suqa.offers set ends_at = now() - interval '1 minute', starts_at = now() - interval '1 day' where id = v_id;
  assert not suqa._bundle_ok(v_id, 90000), 'ended';
  update suqa.offers set ends_at = null, is_active = false where id = v_id;
  assert not suqa._bundle_ok(v_id, 90000), 'switched off';

  -- an order without bundles is priced as before
  o := suqa._place_shop_order(t, s.id, u, a, jsonb_build_array(jsonb_build_object('product_id', p3.id, 'quantity', 2)), null, 'T-130-E', null, null, null, 'pickup', null);
  assert o.subtotal_usd = 2.50, 'plain: ' || o.subtotal_usd;

  -- visitors read active offers only; nobody writes the tables directly
  assert has_table_privilege('anon', 'suqa.offers', 'select') and not has_table_privilege('authenticated', 'suqa.offers', 'insert') and not has_table_privilege('authenticated', 'suqa.offer_items', 'delete');
  assert not has_function_privilege('anon', 'suqa.offer_save(uuid, jsonb)', 'execute') and not has_function_privilege('authenticated', 'suqa._bundle_lines(uuid, numeric)', 'execute');
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  assert (select count(*) from suqa.offers where shop_id = s.id) = 1, 'visitor sees the active one only: ' || (select count(*) from suqa.offers where shop_id = s.id);
  assert (select count(*) from suqa.offer_items where shop_id = s.id) = 1, 'and its items only';
  reset role;
  perform set_config('request.jwt.claim.sub', own::text, true);

  perform suqa.offer_delete(v_id2);
  assert not exists (select 1 from suqa.offers where id = v_id2) and not exists (select 1 from suqa.offer_items where offer_id = v_id2);
  raise notice 'offers / bundles: all checks passed';
end $$;
rollback;
select 'offers_bundles ok' as result;
