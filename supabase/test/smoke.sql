-- smoke.sql — end-to-end: sign-up trigger, RLS per role, place_order, state machine
insert into auth.users(id, phone, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111','+96170000001', jsonb_build_object('tenant_id',(select id from suqa.tenants where slug='batroun'),'full_name','Customer One')),
 ('22222222-2222-2222-2222-222222222222','+96170000002', '{"full_name":"Shop Owner"}'),
 ('33333333-3333-3333-3333-333333333333','+96170000003', '{"full_name":"Assoc Admin"}');
update suqa.tenants set status='live' where slug='batroun';
insert into suqa.tenant_members(tenant_id,user_id,role) select id,'33333333-3333-3333-3333-333333333333','admin' from suqa.tenants where slug='batroun';

set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
insert into suqa.shops(tenant_id,slug,name,status,whatsapp,min_order_usd,prep_minutes,category_id)
 select t.id,'abou-elie','{"en":"Abou Elie Grocery","ar":"سمانة أبو إيلي"}','active','+96170000002',5,20,c.id
 from suqa.tenants t join suqa.categories c on c.tenant_id=t.id and c.slug='grocery' where t.slug='batroun';
insert into suqa.shop_members(shop_id,user_id,role) select id,'22222222-2222-2222-2222-222222222222','owner' from suqa.shops where slug='abou-elie';
insert into suqa.shop_delivery_zones(shop_id,zone_id) select s.id,z.id from suqa.shops s, suqa.delivery_zones z where s.slug='abou-elie';

set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
insert into suqa.products(tenant_id,shop_id,name,price_usd,unit) select tenant_id,id,'{"en":"Labneh","ar":"لبنة"}',3.50,'500 g' from suqa.shops where slug='abou-elie';
insert into suqa.products(tenant_id,shop_id,name,price_usd,unit) select tenant_id,id,'{"en":"Bread","ar":"خبز"}',1.25,'bag' from suqa.shops where slug='abou-elie';

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
insert into suqa.addresses(tenant_id,user_id,label,line1,location,phone)
 select id,'11111111-1111-1111-1111-111111111111','Home','Near the old souk', st_setsrid(st_makepoint(35.6581,34.2553),4326)::geography,'+96170000001' from suqa.tenants where slug='batroun';
select number, status, subtotal_usd, delivery_fee_usd, total_usd, eta_minutes
from suqa.place_order((select id from suqa.shops where slug='abou-elie'),(select id from suqa.addresses where label='Home'),
  (select jsonb_agg(jsonb_build_object('product_id',id,'quantity',case when unit='bag' then 2 else 1 end)) from suqa.products),'ring twice');

insert into suqa.addresses(tenant_id,user_id,label,line1,location) select id,'11111111-1111-1111-1111-111111111111','Beirut','Hamra', st_setsrid(st_makepoint(35.48,33.89),4326)::geography from suqa.tenants where slug='batroun';
\set ON_ERROR_STOP off
select suqa.place_order((select id from suqa.shops where slug='abou-elie'),(select id from suqa.addresses where label='Beirut'),(select jsonb_agg(jsonb_build_object('product_id',id,'quantity',1)) from suqa.products)); -- expect: outside delivery area
update suqa.orders set status='delivered'; -- expect: not allowed
\set ON_ERROR_STOP on
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
update suqa.orders set status='accepted'; update suqa.orders set status='preparing'; update suqa.orders set status='ready'; update suqa.orders set status='delivered';
select from_status, to_status, actor_kind from suqa.order_events order by id;
reset role; set role anon;
select (select count(*) from suqa.shops) shops_anon, (select count(*) from suqa.products) products_anon, (select count(*) from suqa.orders) orders_anon, (select count(*) from suqa.addresses) addresses_anon;
reset role;
