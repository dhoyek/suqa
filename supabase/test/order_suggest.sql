-- 125: what to order. Rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare t uuid; s uuid; own uuid := gen_random_uuid(); cash uuid := gen_random_uuid(); r jsonb; ok boolean; sup uuid := gen_random_uuid();
        a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid(); d uuid := gen_random_uuid(); e uuid := gen_random_uuid(); o uuid;
  function_row jsonb;
begin
  select tenant_id, id into t, s from suqa.shops limit 1;
  select id into o from suqa.orders where shop_id = s limit 1;
  insert into auth.users (id, email) values (own, 'own125@test.local'), (cash, 'cash125@test.local');
  insert into suqa.shop_members (shop_id, user_id, role, active) values (s, own, 'owner', true), (s, cash, 'cashier', true);
  insert into suqa.suppliers (id, shop_id, tenant_id, name) values (sup, s, t, 't125 supplier');
  insert into suqa.products (id, tenant_id, shop_id, name, price_usd, is_active, track_stock, on_hand, reserved, min_stock, supplier_id, cost_cents, decimal_qty) values
    (a, t, s, '{"ar":"t125 fast"}',      1, true, true,  3, 1, 0, sup, 77, false),   -- sold 28 in 14 d -> 14 for 7 d, free 2 -> 12
    (b, t, s, '{"ar":"t125 enough"}',    1, true, true, 50, 0, 0, sup, 77, false),   -- sold 14 -> 7, has 50 -> not listed
    (c, t, s, '{"ar":"t125 minimum"}',   1, true, true,  1, 0, 6, null, 77, false),  -- no sales, minimum 6, has 1 -> 5
    (d, t, s, '{"ar":"t125 untracked"}', 1, true, false, 0, 0, 6, sup, 77, false),
    (e, t, s, '{"ar":"t125 weight"}',    1, true, true,  0.5, 0, 0, sup, 77, true);  -- sold 2.1 kg (3.5 less 1.4 returned) -> 1.05, has 0.5 -> 0.55
  insert into suqa.stock_moves (id, shop_id, tenant_id, product_id, qty, kind, ref_order_id, at) values
    (gen_random_uuid(), s, t, a, -20, 'sale', o, now() - interval '2 days'), (gen_random_uuid(), s, t, a, -8, 'sale', o, now() - interval '10 days'),
    (gen_random_uuid(), s, t, a, -99, 'sale', o, now() - interval '40 days'),            -- outside the window
    (gen_random_uuid(), s, t, a, 30, 'receive', null, now() - interval '1 day'),         -- not a sale
    (gen_random_uuid(), s, t, b, -14, 'sale', o, now() - interval '3 days'),
    (gen_random_uuid(), s, t, e, -3.5, 'sale', o, now() - interval '3 days'), (gen_random_uuid(), s, t, e, 1.4, 'return', o, now() - interval '2 days'),
    (gen_random_uuid(), s, t, d, -30, 'sale', o, now() - interval '3 days');

  update suqa.products set on_hand = v.h from (values (a, 3), (b, 50), (c, 1), (e, 0.5)) v(id, h) where products.id = v.id;   -- the moves above changed the shelf
  perform set_config('request.jwt.claim.sub', cash::text, true);
  begin perform suqa.pos_order_suggest(s); ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'cashier refused';

  perform set_config('request.jwt.claim.sub', own::text, true);
  r := suqa.pos_order_suggest(s);
  assert (r->>'days')::int = 14 and (r->>'cover')::int = 7, 'defaults';
  assert r->'rows' @> jsonb_build_array(jsonb_build_object('id', a, 'suggest', 12, 'sold', 28, 'supplier', 't125 supplier')), 'fast item: ' || (select x::text from jsonb_array_elements(r->'rows') x where x->>'id' = a::text);
  assert not r->'rows' @> jsonb_build_array(jsonb_build_object('id', b)), 'enough on the shelf';
  assert r->'rows' @> jsonb_build_array(jsonb_build_object('id', c, 'suggest', 5)), 'the minimum counts without sales';
  assert not r->'rows' @> jsonb_build_array(jsonb_build_object('id', d)), 'untracked never';
  assert r->'rows' @> jsonb_build_array(jsonb_build_object('id', e, 'suggest', 0.55)), 'weight, net of the return: ' || (select x::text from jsonb_array_elements(r->'rows') x where x->>'id' = e::text);
  assert r::text not like '%cost%' and r::text not like '%price%' and r::text not like '%cents%', 'no money in it';
  r := suqa.pos_order_suggest(s, 14, 14);
  assert r->'rows' @> jsonb_build_array(jsonb_build_object('id', a, 'suggest', 26)), 'cover 14 days';
  assert r->'rows' @> jsonb_build_array(jsonb_build_object('id', b)) = false, 'b still fine at 14';
  r := suqa.pos_order_suggest(s, 999, 999);
  assert (r->>'days')::int = 90 and (r->>'cover')::int = 60, 'clamped';
end $$;
rollback;
\echo order_suggest ok
