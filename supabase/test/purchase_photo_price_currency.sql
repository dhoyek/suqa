-- 126: the invoice photo path and a new price in dollars or lira. Rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare d suqa.devices; s uuid; t uuid; sup uuid := gen_random_uuid(); p1 uuid; p2 uuid; p3 uuid; u uuid; r jsonb; cash uuid := gen_random_uuid(); own uuid := gen_random_uuid(); other uuid;
        a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid(); f text := gen_random_uuid()::text || '.jpg';
begin
  select * into d from suqa.devices limit 1; assert d.id is not null, 'the test database needs a device';
  s := d.shop_id; t := d.tenant_id; select user_id into u from suqa.shop_members where shop_id = s limit 1;
  select id into other from suqa.shops where id <> s limit 1;
  select id into p1 from suqa.products where shop_id = s order by id limit 1;
  select id into p2 from suqa.products where shop_id = s and id <> p1 order by id limit 1;
  select id into p3 from suqa.products where shop_id = s and id not in (p1, p2) order by id limit 1;
  update suqa.products set price_currency = 'usd', price_usd = 2, price_lbp = 0 where id in (p1, p3);
  update suqa.products set price_currency = 'lbp', price_usd = 0, price_lbp = 100000 where id = p2;
  insert into suqa.suppliers (id, shop_id, tenant_id, name) values (sup, s, t, 'sup 126');

  -- a photo in the shop's folder is kept; the lira price turns a dollar item into a lira item, and the other way round
  r := suqa._pos_purchase_commit(d, jsonb_build_object('id', a, 'supplier_id', sup, 'kind', 'purchase', 'currency', 'usd', 'rate', 89500, 'total', 3, 'total_cents', 300, 'photo_path', s::text || '/' || f,
        'lines', jsonb_build_array(
          jsonb_build_object('id', gen_random_uuid(), 'product_id', p1, 'qty', 1.5, 'unit_cost', 1.25, 'unit_cost_cents', 125, 'line_total_cents', 188, 'new_price_lbp', 150000, 'new_price_currency', 'lbp'),
          jsonb_build_object('id', gen_random_uuid(), 'product_id', p2, 'qty', 1, 'unit_cost', 1, 'unit_cost_cents', 100, 'line_total_cents', 100, 'new_price_usd', 1.75, 'new_price_currency', 'usd'),
          jsonb_build_object('id', gen_random_uuid(), 'product_id', p3, 'qty', 1, 'unit_cost', 1, 'unit_cost_cents', 100, 'line_total_cents', 100, 'new_price_usd', 2.5))), u);
  assert (r->>'ok')::boolean, r::text;
  assert (select photo_path = s::text || '/' || f from suqa.purchases where id = a), 'photo path kept';
  assert (select price_currency = 'lbp' and price_lbp = 150000 from suqa.products where id = p1), 'dollar item now priced in lira';
  assert (select price_currency = 'usd' and price_usd = 1.75 from suqa.products where id = p2), 'lira item now priced in dollars';
  assert (select price_currency = 'usd' and price_usd = 2.5 from suqa.products where id = p3), 'an older till (no currency sent): as before';
  assert (select qty = 1.5 from suqa.purchase_lines where purchase_id = a and product_id = p1), 'a decimal quantity is kept';

  -- a path outside the shop's folder, or not a plain file name, is not kept; a return keeps none
  r := suqa._pos_purchase_commit(d, jsonb_build_object('id', b, 'supplier_id', sup, 'kind', 'purchase', 'currency', 'usd', 'rate', 89500, 'photo_path', other::text || '/' || f, 'lines', '[]'::jsonb), u);
  assert (select photo_path is null from suqa.purchases where id = b), 'another shop''s folder refused';
  r := suqa._pos_purchase_commit(d, jsonb_build_object('id', c, 'supplier_id', sup, 'kind', 'return', 'currency', 'usd', 'rate', 89500, 'photo_path', s::text || '/' || f, 'lines', '[]'::jsonb), u);
  assert (select photo_path is null from suqa.purchases where id = c), 'a return keeps no photo';
  -- a currency named without its price changes nothing
  r := suqa._pos_purchase_commit(d, jsonb_build_object('id', gen_random_uuid(), 'supplier_id', sup, 'kind', 'purchase', 'currency', 'usd', 'rate', 89500,
        'lines', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'product_id', p3, 'qty', 1, 'unit_cost', 1, 'unit_cost_cents', 100, 'line_total_cents', 100, 'new_price_currency', 'lbp'))), u);
  assert (select price_currency = 'usd' from suqa.products where id = p3), 'currency without a price: unchanged';

  -- who may keep / open a photo: the shop's owner and stock keeper only
  insert into auth.users (id, email) values (own, 'own126@test.local'), (cash, 'cash126@test.local');
  insert into suqa.shop_members (shop_id, user_id, role, active) values (s, own, 'owner', true), (s, cash, 'cashier', true);
  perform set_config('request.jwt.claim.sub', own::text, true);
  assert suqa.can_use_invoice_photo(s::text || '/' || f), 'owner yes';
  assert not suqa.can_use_invoice_photo(s::text || '/x/' || f) and not suqa.can_use_invoice_photo('junk/' || f) and not suqa.can_use_invoice_photo(f), 'odd paths no';
  if other is not null then assert not suqa.can_use_invoice_photo(other::text || '/' || f), 'another shop no'; end if;
  perform set_config('request.jwt.claim.sub', cash::text, true);
  assert not suqa.can_use_invoice_photo(s::text || '/' || f), 'cashier no';
  assert (select not public from storage.buckets where id = 'invoices'), 'the bucket is private';
end $$;
rollback;
\echo purchase_photo_price_currency ok
