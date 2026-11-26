-- 123: out / low / expiring for the till's assistant. Rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare t uuid; s uuid; own uuid := gen_random_uuid(); cash uuid := gen_random_uuid(); setup uuid := gen_random_uuid(); r jsonb; ok boolean;
        a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid(); d uuid := gen_random_uuid(); e uuid := gen_random_uuid(); f uuid := gen_random_uuid();
  ids text;
begin
  select tenant_id, id into t, s from suqa.shops limit 1;
  insert into auth.users (id, email) values (own, 'own123@test.local'), (cash, 'cash123@test.local'), (setup, 'set123@test.local');
  insert into suqa.shop_members (shop_id, user_id, role, active) values (s, own, 'owner', true), (s, cash, 'cashier', true);
  insert into suqa.tenant_members (tenant_id, user_id, role) values (t, setup, 'admin');
  insert into suqa.products (id, tenant_id, shop_id, name, price_usd, is_active, track_stock, on_hand, min_stock, next_expiry, cost_cents) values
    (a, t, s, '{"ar":"t123 out"}',      1, true,  true,  0,  5, null, 77),
    (b, t, s, '{"ar":"t123 low"}',      1, true,  true,  2,  5, null, 77),
    (c, t, s, '{"ar":"t123 fine"}',     1, true,  true,  9,  5, current_date + 200, 77),
    (d, t, s, '{"ar":"t123 expiring"}', 1, true,  true,  4,  0, current_date + 10, 77),
    (e, t, s, '{"ar":"t123 untracked"}',1, true,  false, 0,  5, current_date + 1, 77),
    (f, t, s, '{"ar":"t123 stopped"}',  1, false, true,  0,  5, current_date + 1, 77);

  perform set_config('request.jwt.claim.sub', setup::text, true);       -- the association is not shop staff
  begin perform suqa.pos_stock_watch(s); ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'association admin refused';

  perform set_config('request.jwt.claim.sub', cash::text, true);
  r := suqa.pos_stock_watch(s);
  assert r->'out' @> jsonb_build_array(jsonb_build_object('id', a)) and not r->'out' @> jsonb_build_array(jsonb_build_object('id', f)) and not r->'out' @> jsonb_build_array(jsonb_build_object('id', e)), 'out: tracked active items only';
  assert r->'low' @> jsonb_build_array(jsonb_build_object('id', b, 'min_stock', 5)) and not r->'low' @> jsonb_build_array(jsonb_build_object('id', a)) and not r->'low' @> jsonb_build_array(jsonb_build_object('id', c)), 'low: under its minimum, not empty';
  assert r->'expiring' @> jsonb_build_array(jsonb_build_object('id', d, 'expired', false)) and not r->'expiring' @> jsonb_build_array(jsonb_build_object('id', c)), 'expiring within 30 days';
  assert (r->'counts'->>'out')::int >= 1 and (r->'counts'->>'low')::int >= 1, 'counts';
  assert r::text not like '%cost%' and r::text not like '%price%' and r::text not like '%supplier%', 'no money in it';

  perform set_config('request.jwt.claim.sub', own::text, true);
  r := suqa.pos_stock_watch(s, 365);
  assert r->'expiring' @> jsonb_build_array(jsonb_build_object('id', c)) and (r->>'expiry_days')::int = 365, 'a wider window';
  assert (suqa.pos_stock_watch(s, 99999)->>'expiry_days')::int = 365, 'window clamped';
end $$;
rollback;
\echo stock_watch ok
