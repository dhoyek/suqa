-- 103: an online order is priced and stored at the SHOP's rate; the association's when the shop has none. Rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare t suqa.tenants; s suqa.shops; s2 suqa.shops; p suqa.products; p2 suqa.products; u uuid; o suqa.orders; o2 suqa.orders; a suqa.addresses; r jsonb; li suqa.order_items;
begin
  select s0.* into s from suqa.shops s0 where s0.status = 'active' and exists (select 1 from suqa.products x where x.shop_id = s0.id and x.is_active and x.is_available) limit 1;
  select * into t from suqa.tenants where id = s.tenant_id;
  select * into s2 from suqa.shops where tenant_id = t.id and id <> s.id limit 1;
  select id into u from suqa.profiles limit 1;
  update suqa.tenants set fx_lbp_rate = 90000 where id = t.id; select * into t from suqa.tenants where id = t.id;
  update suqa.shops set pickup_enabled = true, min_order_usd = 0 where id = s.id;
  delete from suqa.exchange_rates where shop_id in (s.id, s2.id);

  -- no rate of its own: the association's
  assert suqa.shop_rate(s.id) = 90000, 'fallback: ' || suqa.shop_rate(s.id);
  assert not (suqa.shop_rates(t.id) ? s.id::text), 'no own rate → not in the map';

  -- its own rate, the newest row; a rate dated in the future is not used yet
  insert into suqa.exchange_rates (shop_id, tenant_id, lbp_per_usd, effective_at) values (s.id, t.id, 88000, now() - interval '2 days'), (s.id, t.id, 89000, now() - interval '1 hour'), (s.id, t.id, 95000, now() + interval '1 day');
  assert suqa.shop_rate(s.id) = 89000, 'own: ' || suqa.shop_rate(s.id);
  r := suqa.shop_rates(t.id);
  assert (r->>s.id::text)::numeric = 89000 and not coalesce(r ? s2.id::text, false), 'map: ' || r::text;

  -- a lira-priced item and a dollar-priced one, ordered for pickup
  select * into p from suqa.products where shop_id = s.id and is_active and is_available order by id limit 1;
  select * into p2 from suqa.products where shop_id = s.id and is_active and is_available and id <> p.id order by id limit 1;
  update suqa.products set price_currency = 'lbp', price_lbp = 600000, price_usd = 6.70, available_days = null, track_stock = false where id = p.id;
  update suqa.products set price_currency = 'usd', price_lbp = 0, price_usd = 2.00, available_days = null, track_stock = false where id = p2.id;
  o := suqa._place_shop_order(t, s.id, u, a, jsonb_build_array(jsonb_build_object('product_id', p.id, 'quantity', 3), jsonb_build_object('product_id', p2.id, 'quantity', 1)), null, 'T-103-A', null, null, null, 'pickup', null);
  assert o.fx_lbp_rate = 89000, 'order rate: ' || o.fx_lbp_rate;
  select * into li from suqa.order_items where order_id = o.id and product_id = p.id;
  assert li.line_total_usd = round(1800000 / 89000.0, 2) and li.unit_price_usd = round(600000 / 89000.0, 2), 'lira line at the shop rate: ' || li.line_total_usd;
  assert round(li.line_total_usd * o.fx_lbp_rate, -3) = 1800000, 'its lira comes back whole';
  assert o.subtotal_usd = li.line_total_usd + 2.00 and o.total_usd = o.subtotal_usd, 'totals: ' || o.total_usd;
  assert coalesce(o.rate_lbp_per_usd, 89000) = 89000, 'the till reads the same rate';
  assert o.total_lbp is null or o.total_lbp = round(o.total_usd * 89000 / 1000) * 1000, 'lira total: ' || o.total_lbp;

  -- the shop removes its rate: the next order is at the association's again; the first order keeps its own
  delete from suqa.exchange_rates where shop_id = s.id;
  o2 := suqa._place_shop_order(t, s.id, u, a, jsonb_build_array(jsonb_build_object('product_id', p.id, 'quantity', 3)), null, 'T-103-B', null, null, null, 'pickup', null);
  assert o2.fx_lbp_rate = 90000 and o2.subtotal_usd = 20.00, 'association rate: ' || o2.fx_lbp_rate || ' ' || o2.subtotal_usd;
  assert (select fx_lbp_rate from suqa.orders where id = o.id) = 89000, 'an order already placed keeps its rate';

  -- who may read: everyone the current rate, nobody but the staff the history
  assert has_function_privilege('anon', 'suqa.shop_rates(uuid)', 'execute') and has_function_privilege('anon', 'suqa.shop_rate(uuid)', 'execute'), 'visitors read the current rate';
  raise notice 'shop rate online: all checks passed';
end $$;
rollback;
select 'shop_rate_online ok' as result;
