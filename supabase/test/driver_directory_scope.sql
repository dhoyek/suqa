-- 115: the association directory lists only drivers shared with the association. Rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare t uuid; s uuid; s2 uuid := gen_random_uuid(); own uuid := gen_random_uuid(); r jsonb; names jsonb;
begin
  select tenant_id, id into t, s from suqa.shops limit 1;
  insert into suqa.shops (id, tenant_id, slug, name, status) values (s2, t, 'dir115', '{"ar":"mahal 115","en":"shop 115"}', 'active');
  insert into auth.users (id, email) values (own, 'own115@test.local');
  insert into suqa.shop_members (shop_id, user_id, role, active) values (s, own, 'owner', true);
  insert into suqa.shop_drivers (id, shop_id, tenant_id, name, phone, phone_key, active, scope) values
    (gen_random_uuid(), s2, t, 'private 115', '+96170115001', suqa._phone_key('+96170115001'), true, 'shop'),
    (gen_random_uuid(), s2, t, 'shared 115',  '+96170115002', suqa._phone_key('+96170115002'), true, 'association'),
    (gen_random_uuid(), s2, t, 'shared off',  '+96170115003', suqa._phone_key('+96170115003'), false, 'association'),
    (gen_random_uuid(), s2, t, 'mine too',    '+96170115004', suqa._phone_key('+96170115004'), true, 'association'),
    (gen_random_uuid(), s,  t, 'mine too',    '+96170115004', suqa._phone_key('+96170115004'), true, 'shop');
  perform set_config('request.jwt.claim.sub', own::text, true);
  r := suqa.pos_driver_directory(s);
  names := (select coalesce(jsonb_agg(x->>'name'), '[]') from jsonb_array_elements(r) x);
  assert names ? 'shared 115', 'a shared driver is listed: ' || r::text;
  assert not names ? 'private 115', 'a driver kept for his shop is NOT listed';
  assert not names ? 'shared off' and not names ? 'mine too', 'inactive, or already mine: not listed';
  assert (select x->>'used_by' from jsonb_array_elements(r) x where x->>'name' = 'shared 115') = 'mahal 115', 'used_by';
end $$;
rollback;
\echo driver_directory_scope ok
