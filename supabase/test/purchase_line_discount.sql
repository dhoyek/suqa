-- 119: a purchase with a discount and a note on a line, and a percent on the invoice. Rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare d suqa.devices; s uuid; t uuid; sup uuid := gen_random_uuid(); p1 uuid; p2 uuid; pid uuid := gen_random_uuid(); u uuid; r jsonb; l suqa.purchase_lines; h0 numeric;
begin
  select * into d from suqa.devices limit 1; assert d.id is not null, 'the test database needs a device';
  s := d.shop_id; t := d.tenant_id;
  select user_id into u from suqa.shop_members where shop_id = s limit 1;
  select id into p1 from suqa.products where shop_id = s and track_stock order by id limit 1;
  select id into p2 from suqa.products where shop_id = s and id <> p1 order by id limit 1;
  select on_hand into h0 from suqa.products where id = p1;
  insert into suqa.suppliers (id, shop_id, tenant_id, name) values (sup, s, t, 'sup 119');
  r := suqa._pos_purchase_commit(d, jsonb_build_object('id', pid, 'supplier_id', sup, 'kind', 'purchase', 'currency', 'usd', 'rate', 89500,
        'subtotal', 207, 'discount', 10.35, 'discount_pct', 5, 'total', 196.65, 'total_cents', 19665,
        'lines', jsonb_build_array(
          jsonb_build_object('id', gen_random_uuid(), 'product_id', p1, 'qty', 110, 'unit_cost', 2, 'unit_cost_cents', 180, 'line_total_cents', 19800, 'discount', 22, 'discount_pct', 10, 'note', ' promo '),
          jsonb_build_object('id', gen_random_uuid(), 'product_id', p2, 'qty', 4, 'unit_cost', 2.5, 'unit_cost_cents', 225, 'line_total_cents', 900, 'discount', 1),
          jsonb_build_object('id', gen_random_uuid(), 'product_id', p2, 'qty', 1, 'unit_cost', 1, 'unit_cost_cents', 100, 'line_total_cents', 100))), u);
  assert (r->>'ok')::boolean, r::text;
  assert (select discount = 10.35 and discount_pct = 5 and total_cents = 19665 from suqa.purchases where id = pid), 'invoice discount kept as amount and percent';
  select * into l from suqa.purchase_lines where purchase_id = pid and sort = 1;
  assert l.discount = 22 and l.discount_pct = 10 and l.note = 'promo' and l.unit_cost = 2 and l.unit_cost_cents = 180 and l.line_total_cents = 19800, 'line 1: ' || to_jsonb(l)::text;
  select * into l from suqa.purchase_lines where purchase_id = pid and sort = 2;
  assert l.discount = 1 and l.discount_pct is null and l.note is null, 'line 2: amount only';
  select * into l from suqa.purchase_lines where purchase_id = pid and sort = 3;
  assert l.discount is null and l.discount_pct is null and l.note is null, 'line 3: an old-style line stays as before';
  assert (select cost_cents = 180 and on_hand = h0 + 110 from suqa.products where id = p1), 'cost = after the discount; stock in once';
  assert (select count(*) = 1 and min(unit_cost_cents) = 180 from suqa.stock_moves where ref_id = pid and product_id = p1), 'one stock move at the real cost';
  r := suqa._pos_purchase_commit(d, jsonb_build_object('id', pid, 'supplier_id', sup, 'lines', '[]'::jsonb), u);
  assert (r->>'replayed')::boolean and (select on_hand = h0 + 110 from suqa.products where id = p1), 'sent twice: counted once';
  begin
    insert into suqa.purchase_lines (id, purchase_id, shop_id, tenant_id, product_id, name, qty, unit_cost, unit_cost_cents, line_total_cents, discount_pct) select gen_random_uuid(), pid, s, t, p1, '{}'::jsonb, 1, 1, 100, 100, 150;
    assert false, 'a percent above 100 must be refused';
  exception when check_violation then null; end;
end $$;
rollback;
\echo purchase_line_discount ok
