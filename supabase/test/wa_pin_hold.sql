-- 121: a WhatsApp pin that arrives before the customer / order is saved is kept 30 minutes and used. Rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare t uuid; s uuid; mem uuid := gen_random_uuid(); stranger uuid := gen_random_uuid(); r jsonb; ok boolean; o uuid := gen_random_uuid(); o2 uuid := gen_random_uuid(); o3 uuid := gen_random_uuid();
begin
  select tenant_id, id into t, s from suqa.shops limit 1;
  insert into auth.users (id, email) values (mem, 'mem121@test.local'), (stranger, 'str121@test.local');
  insert into suqa.shop_members (shop_id, user_id, role, active) values (s, mem, 'owner', true);

  -- the customer answers BEFORE anything is saved: nothing to attach to, the pin is kept
  r := suqa.wa_attach_location('+961 70 121 001', null, 34.1672515, 35.6868553, 'Batroun, near the church');
  assert (r->>'customers')::int = 0 and (r->>'orders')::int = 0, 'nothing saved yet';
  assert (select count(*) = 1 from suqa.wa_pins where phone_key = suqa._phone_key('70121001')), 'pin kept';

  -- the POS box finds it (shop members only)
  perform set_config('request.jwt.claim.sub', stranger::text, true);
  begin perform suqa.pos_wa_pin(s, '70121001'); ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'a stranger cannot read pins';
  perform set_config('request.jwt.claim.sub', mem::text, true);
  r := suqa.pos_wa_pin(s, '70 121 001');
  assert abs((r->>'lat')::float - 34.1672515) < 1e-6 and r->>'label' = 'Batroun, near the church', 'member sees the pin';
  assert suqa.pos_wa_pin(s, '70121999') is null, 'another number has none';

  -- a new customer saved without a pin takes it
  insert into suqa.shop_customers (shop_id, tenant_id, phone, phone_key, name) values (s, t, '70121001', suqa._phone_key('70121001'), 'Mariam 121');
  assert (select (address->>'lat')::float between 34.16 and 34.17 and address->>'line1' = 'Batroun, near the church' from suqa.shop_customers where shop_id = s and phone_key = suqa._phone_key('70121001')), 'new customer filled';

  -- a delivery order saved after the pin takes it; a pickup does not; a shop-set pin is never replaced
  insert into suqa.orders (id, tenant_id, shop_id, number, subtotal_usd, total_usd, fx_lbp_rate, fulfillment, customer_phone, customer_name, address, channel)
  values (o, t, s, 'T121-1', 1, 1, 89500, 'delivery', '+96170121001', 'Mariam 121', '{"line1":"home"}', 'whatsapp'),
         (o2, t, s, 'T121-2', 1, 1, 89500, 'pickup', '+96170121001', 'Mariam 121', '{}', 'whatsapp'),
         (o3, t, s, 'T121-3', 1, 1, 89500, 'delivery', '+96170121001', 'Mariam 121', '{"lat":33.9,"lng":35.5}', 'whatsapp');
  assert (select abs((address->>'lat')::float - 34.1672515) < 1e-6 and address->>'line1' = 'home' and address->>'map_url' like 'https://maps.google.com/?q=34.16725%' from suqa.orders where id = o), 'delivery order filled, its line kept';
  assert (select address is null or not (address ? 'lat') from suqa.orders where id = o2), 'pickup untouched';
  assert (select (address->>'lat')::float = 33.9 from suqa.orders where id = o3), 'shop pin kept';
  assert (select total_usd = 1 and subtotal_usd = 1 from suqa.orders where id = o), 'amounts untouched';

  -- older than 30 minutes: not used
  update suqa.wa_pins set received_at = now() - interval '31 minutes' where phone_key = suqa._phone_key('70121001');
  assert suqa.pos_wa_pin(s, '70121001') is null, 'old pin not offered';
  -- older than 7 days: removed at the next pin
  update suqa.wa_pins set received_at = now() - interval '8 days' where phone_key = suqa._phone_key('70121001');
  perform suqa.wa_attach_location('+96170121002', null, 34.1, 35.6, null);
  assert not exists (select 1 from suqa.wa_pins where phone_key = suqa._phone_key('70121001')), 'week-old pin removed';

  -- an existing open delivery order still gets the pin directly, as before
  r := suqa.wa_attach_location('+96170121001', null, 34.2, 35.7, null);
  assert (r->>'orders')::int >= 1 and (select (address->>'lat')::float = 34.2 from suqa.orders where id = o), 'open order updated as before';
end $$;
rollback;
\echo wa_pin_hold ok
