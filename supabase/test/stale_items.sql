-- 108: stale items — the window, what counts as a sale, who may read it, the setting. Rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare t uuid; s uuid; own uuid := gen_random_uuid(); stk uuid := gen_random_uuid(); cash uuid := gen_random_uuid(); r jsonb; ok boolean;
        p_old uuid := gen_random_uuid(); p_new uuid := gen_random_uuid(); p_sold uuid := gen_random_uuid(); p_longago uuid := gen_random_uuid(); p_off uuid := gen_random_uuid(); p_canc uuid := gen_random_uuid();
        o1 uuid; ids jsonb;
begin
  select tenant_id, id into t, s from suqa.shops limit 1;
  assert (select stale_days = 60 from suqa.shops where id = s), 'default 60';
  insert into auth.users (id, email) values (own, 'own108@test.local'), (stk, 'stk108@test.local'), (cash, 'cash108@test.local');
  insert into suqa.shop_members (shop_id, user_id, role, active) values (s, own, 'owner', true), (s, stk, 'stock', true), (s, cash, 'staff', true);
  update suqa.products set is_active = false where shop_id = s;      -- only the test's own items count
  insert into suqa.products (id, tenant_id, shop_id, name, price_usd, price_lbp, is_active, created_at, track_stock, on_hand, visible_online, is_available) values
    (p_old,     t, s, '{"en":"never sold, old"}', 1, 0, true,  now() - interval '100 days', true, 0, true, true),
    (p_new,     t, s, '{"en":"never sold, new"}', 1, 0, true,  now() - interval '10 days',  true, 5, true, true),
    (p_sold,    t, s, '{"en":"sold last week"}',  1, 0, true,  now() - interval '100 days', true, 5, true, true),
    (p_longago, t, s, '{"en":"sold long ago"}',   1, 0, true,  now() - interval '200 days', false, 0, true, true),
    (p_off,     t, s, '{"en":"inactive"}',        1, 0, false, now() - interval '100 days', true, 5, true, true),
    (p_canc,    t, s, '{"en":"only a cancelled sale"}', 1, 0, true, now() - interval '100 days', true, 3, false, true);
  -- sales: copy the shape of any order of this shop
  select id into o1 from suqa.orders where shop_id = s limit 1;
  assert o1 is not null, 'the test database needs one order';
  perform set_config('request.jwt.claim.sub', own::text, true);
  r := suqa.pos_report_stale(s);
  ids := (select jsonb_agg(x->>'id') from jsonb_array_elements(r->'rows') x);
  assert (r->>'days')::int = 60 and (r->>'count')::int = 4, 'old ones only, no sales yet: ' || r::text;
  assert not ids ? p_new::text and not ids ? p_off::text, 'a new item and an inactive one are not stale';
  assert r->'rows'->0->>'id' = p_old::text and (r->'rows'->0->>'listed_empty')::boolean, 'listed online with no stock comes first';
  assert not (r->'rows'->0) ? 'cost_cents', 'no cost in the report';
  update suqa.products set on_hand = 5 where id = p_old;   -- a line cannot be written on an item with no stock
  -- sales: last week, long ago, a cancelled one, a voided line
  insert into suqa.orders (id, tenant_id, shop_id, number, subtotal_usd, total_usd, fx_lbp_rate, status, placed_at) values
    (gen_random_uuid(), t, s, 'T108-1', 1, 1, 89500, 'delivered', now() - interval '8 days'),
    (gen_random_uuid(), t, s, 'T108-2', 1, 1, 89500, 'delivered', now() - interval '150 days'),
    (gen_random_uuid(), t, s, 'T108-3', 1, 1, 89500, 'cancelled', now() - interval '2 days');
  insert into suqa.order_items (order_id, tenant_id, product_id, name, unit_price_usd, quantity, line_total_usd, voided)
  select o.id, t, x.pid, '{"en":"x"}', 1, 1, 1, x.v from (values ('T108-1', p_sold, false), ('T108-2', p_longago, false), ('T108-3', p_canc, false), ('T108-1', p_old, true)) x(n, pid, v)
    join suqa.orders o on o.number = x.n and o.shop_id = s;
  r := suqa.pos_report_stale(s);
  ids := (select jsonb_agg(x->>'id') from jsonb_array_elements(r->'rows') x);
  assert (r->>'count')::int = 3 and not ids ? p_sold::text, 'sold last week is not stale: ' || ids::text;
  assert ids ? p_canc::text and ids ? p_old::text, 'a cancelled sale and a voided line are not sales';
  assert (select (x->>'last_sold_at') is not null from jsonb_array_elements(r->'rows') x where x->>'id' = p_longago::text), 'the old sale''s date is given';
  assert r->'rows'->-1->>'id' = p_longago::text, 'never sold before sold long ago';
  -- a longer window: the 150-day-old sale is inside 180 days
  r := suqa.pos_report_stale(s, 180);
  assert (r->>'count')::int = 0, 'nothing is 180 days stale: ' || r::text;
  -- the setting
  r := suqa.pos_shop_settings(s, '{"stale_days": 180}'); assert (r->>'stale_days')::int = 180, 'saved';
  assert (suqa.pos_report_stale(s)->>'days')::int = 180, 'the report follows the setting';
  r := suqa.pos_shop_settings(s, '{"stale_days": 1}'); assert (r->>'stale_days')::int = 7, 'clamped';
  r := suqa.pos_shop_settings(s, '{"return_days": 9}'); assert (r->>'stale_days')::int = 7 and (r->>'return_days')::int = 9, '107 keys still work';
  -- who
  perform set_config('request.jwt.claim.sub', stk::text, true);
  assert (suqa.pos_report_stale(s, 60)->>'count')::int = 3, 'stock role reads it';
  perform set_config('request.jwt.claim.sub', cash::text, true);
  begin perform suqa.pos_report_stale(s); ok := true; exception when insufficient_privilege then ok := false; end;
  assert not ok, 'a cashier does not';
  raise notice 'stale_items: ok';
end $$;
rollback;
