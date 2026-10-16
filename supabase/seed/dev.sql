-- seed/dev.sql — DEV ONLY: accounts + dummy data for tenant 'batroun'       (2026-10-16)
-- Never run against a production project. Idempotent: re-running updates in place.
--
-- Dev accounts (password for all: Suqa-dev-2026!)
--   dev-admin@suqa.dev      platform admin + Batroun association admin
--   dev-ops@suqa.dev        Batroun association ops
--   owner-elie@suqa.dev     owner of "Abou Elie Grocery"
--   owner-mona@suqa.dev     owner of "Furn Mona"
--   owner-jad@suqa.dev      owner of "Jad Butchery"
--   owner-rita@suqa.dev     owner of "Pharmacie Rita"
--   owner-sam@suqa.dev      owner of "Sam's Snack"
--   customer-1@suqa.dev     customer (Nour)
--   customer-2@suqa.dev     customer (Karim)

create extension if not exists pgcrypto;

-- ---------- helper: create or refresh an email/password auth user -------------
create or replace function suqa._dev_user(p_id uuid, p_email text, p_name text, p_phone text, p_tenant uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          phone, phone_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at, confirmation_token, recovery_token,
                          email_change_token_new, email_change, is_sso_user)
  values ('00000000-0000-0000-0000-000000000000', p_id, 'authenticated', 'authenticated', p_email,
          crypt('Suqa-dev-2026!', gen_salt('bf')), now(),
          p_phone, case when p_phone is null then null else now() end,
          '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('full_name', p_name, 'tenant_id', p_tenant, 'locale', 'ar'),
          now(), now(), '', '', '', '', false)
  on conflict (id) do update set email = excluded.email, encrypted_password = excluded.encrypted_password,
          raw_user_meta_data = excluded.raw_user_meta_data, updated_at = now();

  insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
  values (p_id, p_id, p_id::text, 'email',
          jsonb_build_object('sub', p_id::text, 'email', p_email, 'email_verified', true, 'phone_verified', p_phone is not null),
          now(), now(), now())
  on conflict (provider_id, provider) do update set identity_data = excluded.identity_data, updated_at = now();

  -- profile (the auth trigger creates it on first insert; keep it in sync on re-runs)
  insert into suqa.profiles (id, home_tenant_id, full_name, phone, locale)
  values (p_id, p_tenant, p_name, p_phone, 'ar')
  on conflict (id) do update set full_name = excluded.full_name, phone = excluded.phone, home_tenant_id = excluded.home_tenant_id;
end $$;

do $$
declare
  t uuid; z uuid;
  u_admin uuid := 'a0000000-0000-4000-8000-000000000001';
  u_ops   uuid := 'a0000000-0000-4000-8000-000000000002';
  u_elie  uuid := 'b0000000-0000-4000-8000-000000000001';
  u_mona  uuid := 'b0000000-0000-4000-8000-000000000002';
  u_jad   uuid := 'b0000000-0000-4000-8000-000000000003';
  u_rita  uuid := 'b0000000-0000-4000-8000-000000000004';
  u_sam   uuid := 'b0000000-0000-4000-8000-000000000005';
  u_c1    uuid := 'c0000000-0000-4000-8000-000000000001';
  u_c2    uuid := 'c0000000-0000-4000-8000-000000000002';
  s_elie uuid; s_mona uuid; s_jad uuid; s_rita uuid; s_sam uuid;
  a_c1 uuid; a_c2 uuid;
  o uuid;
begin
  select id into t from suqa.tenants where slug = 'batroun';
  update suqa.tenants set status = 'live',
    settings = settings || '{"support_phone":"+96170000000","whatsapp_number":"+96170000000"}'::jsonb
  where id = t;
  select id into z from suqa.delivery_zones where tenant_id = t order by sort_order limit 1;

  -- ---------- users ----------
  perform suqa._dev_user(u_admin, 'dev-admin@suqa.dev',  'Dev Admin',        '+96170000001', t);
  perform suqa._dev_user(u_ops,   'dev-ops@suqa.dev',    'Association Ops',  '+96170000002', t);
  perform suqa._dev_user(u_elie,  'owner-elie@suqa.dev', 'Elie Khoury',      '+96170000011', t);
  perform suqa._dev_user(u_mona,  'owner-mona@suqa.dev', 'Mona Saliba',      '+96170000012', t);
  perform suqa._dev_user(u_jad,   'owner-jad@suqa.dev',  'Jad Nassar',       '+96170000013', t);
  perform suqa._dev_user(u_rita,  'owner-rita@suqa.dev', 'Rita Haddad',      '+96170000014', t);
  perform suqa._dev_user(u_sam,   'owner-sam@suqa.dev',  'Sami Gerges',      '+96170000015', t);
  perform suqa._dev_user(u_c1,    'customer-1@suqa.dev', 'Nour Abi Nader',   '+96171000001', t);
  perform suqa._dev_user(u_c2,    'customer-2@suqa.dev', 'Karim Daou',       '+96171000002', t);

  insert into suqa.platform_admins (user_id) values (u_admin) on conflict do nothing;
  insert into suqa.tenant_members (tenant_id, user_id, role) values (t, u_admin, 'admin'), (t, u_ops, 'ops')
  on conflict (tenant_id, user_id) do update set role = excluded.role;

  -- ---------- shops ----------
  insert into suqa.shops (tenant_id, slug, name, description, status, phone, whatsapp, address_text, location,
                          opening_hours, min_order_usd, prep_minutes, category_id, sort_order)
  values
   (t, 'abou-elie', '{"en":"Abou Elie Grocery","ar":"سمانة أبو إيلي"}',
       '{"en":"Everyday groceries, dairy and fresh bread. Family-run since 1989.","ar":"سمانة، ألبان وأجبان وخبز طازج. عائلية منذ ١٩٨٩."}',
       'active', '+96106740001', '+96170000011', 'Old Souk, Batroun', st_setsrid(st_makepoint(35.6575, 34.2555), 4326)::geography,
       '{"mon":[["07:00","21:00"]],"tue":[["07:00","21:00"]],"wed":[["07:00","21:00"]],"thu":[["07:00","21:00"]],"fri":[["07:00","21:00"]],"sat":[["07:00","22:00"]],"sun":[["08:00","14:00"]]}',
       5, 20, (select id from suqa.categories where tenant_id = t and slug = 'grocery'), 1),
   (t, 'furn-mona', '{"en":"Furn Mona","ar":"فرن منى"}',
       '{"en":"Manakish, kaak and sweets baked all day.","ar":"مناقيش وكعك وحلويات طازجة طوال اليوم."}',
       'active', '+96106740002', '+96170000012', 'Main road, near the church', st_setsrid(st_makepoint(35.6600, 34.2548), 4326)::geography,
       '{"mon":[["05:30","15:00"],["17:00","23:00"]],"tue":[["05:30","15:00"],["17:00","23:00"]],"wed":[["05:30","15:00"],["17:00","23:00"]],"thu":[["05:30","15:00"],["17:00","23:00"]],"fri":[["05:30","15:00"],["17:00","23:00"]],"sat":[["05:30","23:00"]],"sun":[["06:00","14:00"]]}',
       3, 15, (select id from suqa.categories where tenant_id = t and slug = 'bakery'), 2),
   (t, 'jad-butchery', '{"en":"Jad Butchery","ar":"ملحمة جاد"}',
       '{"en":"Fresh Lebanese lamb and beef, kafta made to order.","ar":"لحمة بلدية طازجة، كفتة على الطلب."}',
       'active', '+96106740003', '+96170000013', 'Souk el Sagha', st_setsrid(st_makepoint(35.6570, 34.2560), 4326)::geography,
       '{"mon":[["07:00","19:00"]],"tue":[["07:00","19:00"]],"wed":[["07:00","19:00"]],"thu":[["07:00","19:00"]],"fri":[["07:00","19:00"]],"sat":[["07:00","19:00"]],"sun":[]}',
       10, 30, (select id from suqa.categories where tenant_id = t and slug = 'butcher'), 3),
   (t, 'pharmacie-rita', '{"en":"Pharmacie Rita","ar":"صيدلية ريتا"}',
       '{"en":"OTC medicines, baby care and cosmetics. Prescriptions by phone.","ar":"أدوية بدون وصفة، مستلزمات أطفال ومستحضرات تجميل."}',
       'active', '+96106740004', '+96170000014', 'Seaside road', st_setsrid(st_makepoint(35.6560, 34.2540), 4326)::geography,
       '{"mon":[["08:00","22:00"]],"tue":[["08:00","22:00"]],"wed":[["08:00","22:00"]],"thu":[["08:00","22:00"]],"fri":[["08:00","22:00"]],"sat":[["08:00","22:00"]],"sun":[["09:00","20:00"]]}',
       0, 15, (select id from suqa.categories where tenant_id = t and slug = 'pharmacy'), 4),
   (t, 'sams-snack', '{"en":"Sam''s Snack","ar":"سناك سام"}',
       '{"en":"Shawarma, tawouk and fries — the late-night classic.","ar":"شاورما وطاووق وبطاطا — كلاسيكية آخر الليل."}',
       'pending', '+96106740005', '+96170000015', 'Batroun entrance roundabout', st_setsrid(st_makepoint(35.6620, 34.2535), 4326)::geography,
       '{"mon":[["11:00","02:00"]],"tue":[["11:00","02:00"]],"wed":[["11:00","02:00"]],"thu":[["11:00","02:00"]],"fri":[["11:00","03:00"]],"sat":[["11:00","03:00"]],"sun":[["12:00","01:00"]]}',
       6, 25, (select id from suqa.categories where tenant_id = t and slug = 'restaurant'), 5)
  on conflict (tenant_id, slug) do update set name = excluded.name, description = excluded.description,
       status = excluded.status, opening_hours = excluded.opening_hours, category_id = excluded.category_id;

  select id into s_elie from suqa.shops where tenant_id = t and slug = 'abou-elie';
  select id into s_mona from suqa.shops where tenant_id = t and slug = 'furn-mona';
  select id into s_jad  from suqa.shops where tenant_id = t and slug = 'jad-butchery';
  select id into s_rita from suqa.shops where tenant_id = t and slug = 'pharmacie-rita';
  select id into s_sam  from suqa.shops where tenant_id = t and slug = 'sams-snack';

  insert into suqa.shop_members (shop_id, user_id, role) values
    (s_elie, u_elie, 'owner'), (s_mona, u_mona, 'owner'), (s_jad, u_jad, 'owner'),
    (s_rita, u_rita, 'owner'), (s_sam, u_sam, 'owner')
  on conflict do nothing;

  insert into suqa.shop_delivery_zones (shop_id, zone_id, fee_usd) values
    (s_elie, z, null), (s_mona, z, 1.00), (s_jad, z, null), (s_rita, z, 1.50), (s_sam, z, null)
  on conflict (shop_id, zone_id) do update set fee_usd = excluded.fee_usd;

  -- ---------- products (delete+insert per dev shop keeps re-runs clean) ----------
  -- previous dev orders go first so their order_items no longer pin old product rows
  delete from suqa.orders where customer_id in (u_c1, u_c2);
  update suqa.order_counters set last_value = 0 where tenant_id = t;
  delete from suqa.products where shop_id in (s_elie, s_mona, s_jad, s_rita, s_sam);

  insert into suqa.products (tenant_id, shop_id, name, description, price_usd, unit, section, is_available, sort_order) values
   -- Abou Elie
   (t, s_elie, '{"en":"Labneh","ar":"لبنة"}', '{"en":"Fresh cow labneh","ar":"لبنة بقر طازجة"}', 3.50, '500 g', 'Dairy', true, 1),
   (t, s_elie, '{"en":"Halloumi","ar":"حلوم"}', '{}', 6.00, '400 g', 'Dairy', true, 2),
   (t, s_elie, '{"en":"Eggs","ar":"بيض"}', '{"en":"Free-range, 30 pieces","ar":"بلدي، ٣٠ حبة"}', 5.50, 'tray', 'Dairy', true, 3),
   (t, s_elie, '{"en":"Arabic bread","ar":"خبز عربي"}', '{}', 1.25, 'bag', 'Bakery', true, 4),
   (t, s_elie, '{"en":"Olive oil","ar":"زيت زيتون"}', '{"en":"Koura extra virgin","ar":"كورة بكر ممتاز"}', 14.00, '1 L', 'Pantry', true, 5),
   (t, s_elie, '{"en":"Zaatar","ar":"زعتر"}', '{}', 4.00, '500 g', 'Pantry', true, 6),
   (t, s_elie, '{"en":"Water 6×1.5 L","ar":"مياه ٦×١٫٥ ل"}', '{}', 2.50, 'pack', 'Drinks', true, 7),
   (t, s_elie, '{"en":"Lemons","ar":"ليمون حامض"}', '{"en":"Batroun lemons","ar":"حامض بترون"}', 1.50, 'kg', 'Produce', false, 8),
   -- Furn Mona
   (t, s_mona, '{"en":"Manoushe zaatar","ar":"منقوشة زعتر"}', '{}', 0.80, 'piece', 'Manakish', true, 1),
   (t, s_mona, '{"en":"Manoushe cheese","ar":"منقوشة جبنة"}', '{}', 1.75, 'piece', 'Manakish', true, 2),
   (t, s_mona, '{"en":"Lahm bi ajin","ar":"لحم بعجين"}', '{}', 1.50, 'piece', 'Manakish', true, 3),
   (t, s_mona, '{"en":"Kaak","ar":"كعك"}', '{"en":"Sesame kaak with cheese","ar":"كعك سمسم بجبنة"}', 1.25, 'piece', 'Kaak', true, 4),
   (t, s_mona, '{"en":"Sfouf","ar":"صفوف"}', '{}', 6.00, 'tray', 'Sweets', true, 5),
   (t, s_mona, '{"en":"Maamoul (12)","ar":"معمول (١٢)"}', '{"en":"Dates and walnuts","ar":"تمر وجوز"}', 9.00, 'box', 'Sweets', true, 6),
   -- Jad Butchery
   (t, s_jad, '{"en":"Lamb kafta","ar":"كفتة غنم"}', '{}', 12.00, 'kg', 'Lamb', true, 1),
   (t, s_jad, '{"en":"Lamb chops","ar":"ريش غنم"}', '{}', 18.00, 'kg', 'Lamb', true, 2),
   (t, s_jad, '{"en":"Beef cubes","ar":"لحم بقر مكعبات"}', '{}', 11.00, 'kg', 'Beef', true, 3),
   (t, s_jad, '{"en":"Minced beef","ar":"لحم بقر مفروم"}', '{}', 9.50, 'kg', 'Beef', true, 4),
   (t, s_jad, '{"en":"Chicken breast","ar":"صدر دجاج"}', '{}', 6.50, 'kg', 'Poultry', true, 5),
   (t, s_jad, '{"en":"Whole chicken","ar":"دجاجة كاملة"}', '{}', 5.00, 'piece', 'Poultry', false, 6),
   -- Pharmacie Rita
   (t, s_rita, '{"en":"Panadol Extra (24)","ar":"بانادول إكسترا (٢٤)"}', '{}', 3.20, 'box', 'Pain relief', true, 1),
   (t, s_rita, '{"en":"Vitamin C 1000 mg","ar":"فيتامين سي ١٠٠٠"}', '{}', 7.50, 'tube', 'Vitamins', true, 2),
   (t, s_rita, '{"en":"Baby diapers size 4","ar":"حفاضات أطفال مقاس ٤"}', '{}', 11.00, 'pack', 'Baby', true, 3),
   (t, s_rita, '{"en":"Sunscreen SPF 50","ar":"واقي شمس ٥٠"}', '{}', 15.00, 'bottle', 'Skin care', true, 4),
   (t, s_rita, '{"en":"Hand sanitizer","ar":"معقم يدين"}', '{}', 2.00, 'bottle', 'Hygiene', true, 5),
   -- Sam's Snack (pending shop — not visible to shoppers yet)
   (t, s_sam, '{"en":"Chicken shawarma","ar":"شاورما دجاج"}', '{}', 3.50, 'sandwich', 'Sandwiches', true, 1),
   (t, s_sam, '{"en":"Tawouk","ar":"طاووق"}', '{}', 4.00, 'sandwich', 'Sandwiches', true, 2),
   (t, s_sam, '{"en":"Fries","ar":"بطاطا مقلية"}', '{}', 2.00, 'portion', 'Sides', true, 3);

  -- ---------- customer addresses ----------
  delete from suqa.addresses where user_id in (u_c1, u_c2);
  insert into suqa.addresses (id, tenant_id, user_id, label, line1, line2, notes, location, phone, is_default) values
   ('d0000000-0000-4000-8000-000000000001', t, u_c1, 'Home', 'Abi Nader building, 2nd floor', 'Behind the serail', 'Ring twice', st_setsrid(st_makepoint(35.6585, 34.2550), 4326)::geography, '+96171000001', true),
   ('d0000000-0000-4000-8000-000000000002', t, u_c2, 'Home', 'Daou house, white gate', null, 'Call on arrival', st_setsrid(st_makepoint(35.6610, 34.2565), 4326)::geography, '+96171000002', true),
   ('d0000000-0000-4000-8000-000000000003', t, u_c2, 'Office', 'Municipality street, 1st floor', null, null, st_setsrid(st_makepoint(35.6590, 34.2545), 4326)::geography, '+96171000002', false);
  a_c1 := 'd0000000-0000-4000-8000-000000000001';
  a_c2 := 'd0000000-0000-4000-8000-000000000002';

  -- ---------- orders: placed as customers via place_order(), moved by shop owners ----------
  -- impersonation helper: auth.uid() reads request.jwt.claim.sub / request.jwt.claims
  perform set_config('request.jwt.claim.sub', u_c1::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', u_c1, 'role', 'authenticated')::text, true);

  -- 1. delivered yesterday — Abou Elie
  select id into o from suqa.place_order(s_elie, a_c1,
    (select jsonb_agg(jsonb_build_object('product_id', id, 'quantity', q)) from (
       select id, 1 q from suqa.products where shop_id = s_elie and name->>'en' = 'Labneh'
       union all select id, 2 from suqa.products where shop_id = s_elie and name->>'en' = 'Arabic bread'
       union all select id, 1 from suqa.products where shop_id = s_elie and name->>'en' = 'Eggs') x), 'Ring twice please');
  perform set_config('request.jwt.claim.sub', u_elie::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', u_elie, 'role', 'authenticated')::text, true);
  update suqa.orders set status = 'accepted', eta_minutes = 25 where id = o;
  update suqa.orders set status = 'preparing' where id = o;
  update suqa.orders set status = 'ready' where id = o;
  update suqa.orders set status = 'out_for_delivery' where id = o;
  update suqa.orders set status = 'delivered' where id = o;
  update suqa.orders set placed_at = now() - interval '1 day 3 hours', accepted_at = now() - interval '1 day 2 hours 55 minutes',
         delivered_at = now() - interval '1 day 2 hours 20 minutes', closed_at = now() - interval '1 day 2 hours 20 minutes' where id = o;
  update suqa.order_events set created_at = now() - interval '1 day 3 hours' where order_id = o;

  -- 2. rejected — Jad (out of chicken)
  perform set_config('request.jwt.claim.sub', u_c2::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', u_c2, 'role', 'authenticated')::text, true);
  select id into o from suqa.place_order(s_jad, a_c2,
    (select jsonb_agg(jsonb_build_object('product_id', id, 'quantity', 2)) from suqa.products where shop_id = s_jad and name->>'en' = 'Chicken breast'), null);
  perform set_config('request.jwt.claim.sub', u_jad::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', u_jad, 'role', 'authenticated')::text, true);
  update suqa.orders set status = 'rejected', reject_reason = 'Sold out for today, fresh stock tomorrow 7am' where id = o;
  update suqa.orders set placed_at = now() - interval '20 hours', closed_at = now() - interval '19 hours 50 minutes' where id = o;

  -- 3. preparing now — Furn Mona
  perform set_config('request.jwt.claim.sub', u_c2::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', u_c2, 'role', 'authenticated')::text, true);
  select id into o from suqa.place_order(s_mona, a_c2,
    (select jsonb_agg(jsonb_build_object('product_id', id, 'quantity', q)) from (
       select id, 4 q from suqa.products where shop_id = s_mona and name->>'en' = 'Manoushe zaatar'
       union all select id, 2 from suqa.products where shop_id = s_mona and name->>'en' = 'Manoushe cheese'
       union all select id, 1 from suqa.products where shop_id = s_mona and name->>'en' = 'Kaak') x), 'Extra zaatar');
  perform set_config('request.jwt.claim.sub', u_mona::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', u_mona, 'role', 'authenticated')::text, true);
  update suqa.orders set status = 'accepted', eta_minutes = 20 where id = o;
  update suqa.orders set status = 'preparing' where id = o;
  update suqa.orders set placed_at = now() - interval '12 minutes', accepted_at = now() - interval '10 minutes' where id = o;

  -- 4. pending — Pharmacie Rita (new, waiting for the shop)
  perform set_config('request.jwt.claim.sub', u_c1::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', u_c1, 'role', 'authenticated')::text, true);
  select id into o from suqa.place_order(s_rita, a_c1,
    (select jsonb_agg(jsonb_build_object('product_id', id, 'quantity', q)) from (
       select id, 1 q from suqa.products where shop_id = s_rita and name->>'en' = 'Panadol Extra (24)'
       union all select id, 1 from suqa.products where shop_id = s_rita and name->>'en' = 'Vitamin C 1000 mg') x), null);
  update suqa.orders set placed_at = now() - interval '3 minutes' where id = o;

  -- 5. pending — Abou Elie (second new order)
  select id into o from suqa.place_order(s_elie, a_c1,
    (select jsonb_agg(jsonb_build_object('product_id', id, 'quantity', q)) from (
       select id, 1 q from suqa.products where shop_id = s_elie and name->>'en' = 'Olive oil'
       union all select id, 1 from suqa.products where shop_id = s_elie and name->>'en' = 'Zaatar'
       union all select id, 2 from suqa.products where shop_id = s_elie and name->>'en' = 'Water 6×1.5 L') x), null);

  -- 6. cancelled by customer while pending — Jad
  perform set_config('request.jwt.claim.sub', u_c2::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', u_c2, 'role', 'authenticated')::text, true);
  select id into o from suqa.place_order(s_jad, a_c2,
    (select jsonb_agg(jsonb_build_object('product_id', id, 'quantity', 1)) from suqa.products where shop_id = s_jad and name->>'en' = 'Lamb kafta'), null);
  update suqa.orders set status = 'cancelled' where id = o;
  update suqa.orders set placed_at = now() - interval '2 days', closed_at = now() - interval '2 days' + interval '4 minutes' where id = o;

  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

drop function if exists suqa._dev_user(uuid, text, text, text, uuid);

select (select count(*) from auth.users where email like '%@suqa.dev') dev_users,
       (select count(*) from suqa.shops) shops,
       (select count(*) from suqa.products) products,
       (select count(*) from suqa.orders) orders,
       (select string_agg(number || ':' || status, ', ' order by number) from suqa.orders) order_statuses;
