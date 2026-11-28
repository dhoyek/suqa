-- 131: a price offer on one item — saved by the owner, charged by the server on an ordinary line. Rolls back.
\set ON_ERROR_STOP on
begin;
\i supabase/schema/131_offers_price.sql
do $$
declare t suqa.tenants; s suqa.shops; a suqa.addresses; u uuid; own uuid; o suqa.orders; v_d uuid; v_b uuid; v_l uuid; li suqa.order_items;
        p1 suqa.products; p2 suqa.products; p3 suqa.products; v_err text;
begin
  select s0.* into s from suqa.shops s0 where s0.status = 'active' and (select count(*) from suqa.products x where x.shop_id = s0.id and x.is_active and x.is_available) >= 3
     and exists (select 1 from suqa.shop_members m where m.shop_id = s0.id and m.role = 'owner' and m.active) limit 1;
  select * into t from suqa.tenants where id = s.tenant_id;
  select user_id into own from suqa.shop_members where shop_id = s.id and role = 'owner' and active limit 1;
  select id into u from suqa.profiles where id <> own limit 1;
  update suqa.tenants set fx_lbp_rate = 90000 where id = t.id; select * into t from suqa.tenants where id = t.id;
  update suqa.shops set pickup_enabled = true, min_order_usd = 0 where id = s.id;
  delete from suqa.exchange_rates where shop_id = s.id; delete from suqa.offers where shop_id = s.id;
  select * into p1 from suqa.products where shop_id = s.id and is_active and is_available order by id limit 1;
  select * into p2 from suqa.products where shop_id = s.id and is_active and is_available and id <> p1.id order by id limit 1;
  select * into p3 from suqa.products where shop_id = s.id and is_active and is_available and id not in (p1.id, p2.id) order by id limit 1;
  update suqa.products set price_currency = 'usd', price_lbp = 0, available_days = null, track_stock = false, price_usd = case id when p1.id then 3.50 when p2.id then 4.00 else 1.25 end where id in (p1.id, p2.id, p3.id);
  update suqa.products set price_currency = 'lbp', price_lbp = 221760, price_usd = 2.46 where id = p3.id;
  perform set_config('request.jwt.claim.sub', own::text, true);

  -- what a price offer must be
  begin perform suqa.offer_save(s.id, jsonb_build_object('kind', 'discount', 'price', 2, 'items', jsonb_build_array(jsonb_build_object('product_id', p1.id, 'quantity', 1), jsonb_build_object('product_id', p2.id, 'quantity', 1))));
        raise exception 'two items accepted'; exception when others then get stacked diagnostics v_err = message_text; assert v_err = 'offer_one_item', v_err; end;
  begin perform suqa.offer_save(s.id, jsonb_build_object('kind', 'discount', 'price', 3.50, 'items', jsonb_build_array(jsonb_build_object('product_id', p1.id, 'quantity', 1))));
        raise exception 'no saving accepted'; exception when others then get stacked diagnostics v_err = message_text; assert v_err = 'offer_no_saving', v_err; end;
  begin perform suqa.offer_save(s.id, jsonb_build_object('kind', 'discount', 'price_currency', 'usd', 'price', 2, 'items', jsonb_build_array(jsonb_build_object('product_id', p3.id, 'quantity', 1))));
        raise exception 'other currency accepted'; exception when others then get stacked diagnostics v_err = message_text; assert v_err = 'offer_mixed_currency', v_err; end;

  -- $3.50 → $2.90, no name given: it carries the item's name; a quantity sent is ignored (always one)
  v_d := suqa.offer_save(s.id, jsonb_build_object('kind', 'discount', 'price', 2.90, 'max_per_order', '3', 'items', jsonb_build_array(jsonb_build_object('product_id', p1.id, 'quantity', 5))));
  assert (select kind = 'discount' and price_usd = 2.90 and max_per_order is null and name = jsonb_strip_nulls(jsonb_build_object('ar', nullif(p1.name->>'ar', ''), 'en', nullif(p1.name->>'en', ''))) from suqa.offers where id = v_d), 'saved as a price offer';
  assert (select quantity from suqa.offer_items where offer_id = v_d) = 1;
  assert (suqa._sale_offer(p1.id)).id = v_d and (suqa._sale_offer(p2.id)).id is null;

  -- an ordinary order: the offer price on that item, the normal price on the others, said on the line
  o := suqa._place_shop_order(t, s.id, u, a, jsonb_build_array(jsonb_build_object('product_id', p1.id, 'quantity', 3, 'notes', 'cold'), jsonb_build_object('product_id', p2.id, 'quantity', 1)), null, 'T-131-A', null, null, null, 'pickup', null);
  assert o.subtotal_usd = 8.70 + 4.00, 'order: ' || o.subtotal_usd;
  select * into li from suqa.order_items where order_id = o.id and product_id = p1.id;
  assert li.unit_price_usd = 2.90 and li.line_total_usd = 8.70 and li.notes like '🏷 %· cold', 'line: ' || li.unit_price_usd || ' ' || coalesce(li.notes, '');
  assert (select notes is null and line_total_usd = 4.00 from suqa.order_items where order_id = o.id and product_id = p2.id), 'the other line untouched';

  -- a lira offer on a lira item: 221,760 → 180,000 at 90,000 = $2.00 a piece
  v_l := suqa.offer_save(s.id, jsonb_build_object('kind', 'discount', 'name', jsonb_build_object('ar', 'عرض الأسبوع'), 'price_currency', 'lbp', 'price', 180000, 'items', jsonb_build_array(jsonb_build_object('product_id', p3.id, 'quantity', 1))));
  o := suqa._place_shop_order(t, s.id, u, a, jsonb_build_array(jsonb_build_object('product_id', p3.id, 'quantity', 2)), null, 'T-131-B', null, null, null, 'pickup', null);
  assert o.subtotal_usd = 4.00, 'lira offer: ' || o.subtotal_usd;
  assert (select notes = '🏷 عرض الأسبوع' from suqa.order_items where order_id = o.id), 'named';

  -- two offers on one item: the cheaper one; an item inside a bundle keeps its bundle price
  perform suqa.offer_save(s.id, jsonb_build_object('kind', 'discount', 'price', 3.00, 'items', jsonb_build_array(jsonb_build_object('product_id', p1.id, 'quantity', 1))));
  assert (suqa._sale_offer(p1.id)).id = v_d, 'cheapest wins';
  v_b := suqa.offer_save(s.id, jsonb_build_object('name', jsonb_build_object('en', 'Pair'), 'price', 7, 'items', jsonb_build_array(jsonb_build_object('product_id', p1.id, 'quantity', 1), jsonb_build_object('product_id', p2.id, 'quantity', 1))));
  assert (select kind from suqa.offers where id = v_b) = 'bundle', 'default kind';
  o := suqa._place_shop_order(t, s.id, u, a, jsonb_build_array(jsonb_build_object('offer_id', v_b, 'quantity', 1), jsonb_build_object('product_id', p1.id, 'quantity', 1)), null, 'T-131-C', null, null, null, 'pickup', null);
  assert o.subtotal_usd = 7.00 + 2.90, 'bundle + offer item: ' || o.subtotal_usd;

  -- the kind never changes; ended / paused / item price dropped below the offer → the normal price again
  perform suqa.offer_save(s.id, jsonb_build_object('id', v_d, 'kind', 'bundle', 'name', jsonb_build_object('en', 'x'), 'price', 2.80, 'items', jsonb_build_array(jsonb_build_object('product_id', p1.id, 'quantity', 1))));
  assert (select kind = 'discount' and price_usd = 2.80 from suqa.offers where id = v_d), 'still a price offer';
  update suqa.offers set ends_at = now() - interval '1 minute', starts_at = now() - interval '1 day' where shop_id = s.id and kind = 'discount';
  assert (suqa._sale_offer(p1.id)).id is null, 'ended';
  o := suqa._place_shop_order(t, s.id, u, a, jsonb_build_array(jsonb_build_object('product_id', p1.id, 'quantity', 1)), null, 'T-131-D', null, null, null, 'pickup', null);
  assert o.subtotal_usd = 3.50 and (select notes is null from suqa.order_items where order_id = o.id), 'normal again: ' || o.subtotal_usd;
  update suqa.offers set ends_at = null where id = v_d; update suqa.products set price_usd = 2.50 where id = p1.id;
  assert (suqa._sale_offer(p1.id)).id is null, 'no longer a saving';
  assert not has_function_privilege('authenticated', 'suqa._sale_offer(uuid)', 'execute');
  raise notice 'price offers: all checks passed';
end $$;
rollback;
select 'offers_price ok' as result;
