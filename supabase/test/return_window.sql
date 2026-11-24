-- 107: the shop's return window and the cashier's sales window — defaults, saved by the owner, clamped, refused for a cashier. Rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare t uuid; s uuid; own uuid := gen_random_uuid(); cash uuid := gen_random_uuid(); r jsonb; fee numeric; ok boolean;
begin
  select tenant_id, id, default_delivery_fee_usd into t, s, fee from suqa.shops limit 1;
  assert (select return_days = 7 and cashier_sales_days = 7 from suqa.shops where id = s), 'defaults are 7 days';
  insert into auth.users (id, email) values (own, 'own107@test.local'), (cash, 'cash107@test.local');
  insert into suqa.shop_members (shop_id, user_id, role, active) values (s, own, 'owner', true), (s, cash, 'staff', true);

  perform set_config('request.jwt.claim.sub', own::text, true);
  r := suqa.pos_shop_settings(s, '{"return_days": 14, "cashier_sales_days": 3}');
  assert (r->>'return_days')::int = 14 and (r->>'cashier_sales_days')::int = 3, 'saved and returned: ' || (r->>'return_days');
  assert (select default_delivery_fee_usd is not distinct from fee from suqa.shops where id = s), 'other settings untouched';
  r := suqa.pos_shop_settings(s, '{"return_days": 0, "cashier_sales_days": 9999}');
  assert (r->>'return_days')::int = 1 and (r->>'cashier_sales_days')::int = 365, 'clamped to 1..365';
  r := suqa.pos_shop_settings(s, '{"max_discount_pct": 5}');
  assert (r->>'return_days')::int = 1, 'a patch without the keys keeps them';

  perform set_config('request.jwt.claim.sub', cash::text, true);
  begin perform suqa.pos_shop_settings(s, '{"return_days": 30}'); ok := true; exception when insufficient_privilege then ok := false; end;
  assert not ok, 'a cashier cannot change them';
  raise notice 'return_window: ok';
end $$;
rollback;
