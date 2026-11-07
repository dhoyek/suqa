-- pos_smoke.sql — POS RPCs end to end (run after smoke.sql): register, push (idempotent), pull, stock ledger, online reservation
-- Expected (see docs/pos/PLAN.md §5): one order per sale despite the replay; on_hand = 20 − 3; online order reserves 2 then deducts at ready.
set role authenticated; set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';   -- shop owner
update suqa.shops set pos_enabled = true where slug = 'abou-elie';
update suqa.products set track_stock = true where name->>'en' = 'Labneh';

-- register two devices
select prefix, name from suqa.pos_register_device('0193a000-0000-7000-8000-000000000001', (select id from suqa.shops where slug='abou-elie'), 'Counter PC', 'test');
select prefix, name from suqa.pos_register_device('0193a000-0000-7000-8000-000000000002', (select id from suqa.shops where slug='abou-elie'), 'Phone', 'test');

-- receive 20 labneh on device A
select jsonb_pretty(suqa.pos_push('0193a000-0000-7000-8000-000000000001', jsonb_build_array(jsonb_build_object(
  'op_id', '0193a000-0000-7000-8000-00000000a001', 'kind', 'stock.move',
  'payload', jsonb_build_object('id', '0193a000-0000-7000-8000-00000000b001', 'product_id', (select id from suqa.products where name->>'en'='Labneh'),
                                'qty', 20, 'kind', 'receive', 'unit_cost_cents', 250)))));

-- sale of 3 labneh on device A, pushed twice (simulated timeout + retry)
\set sale '''{"op_id":"0193a000-0000-7000-8000-00000000a002","kind":"sale.commit","payload":{"id":"0193a000-0000-7000-8000-00000000c001","local_number":"A-000001","channel":"walkin","rate_lbp_per_usd":89500,"subtotal_cents":1050,"total_cents":1050,"total_lbp":939750,"paid_usd_cents":1000,"paid_lbp":100000,"change_usd_cents":0,"change_lbp":55000,"lines":[{"id":"0193a000-0000-7000-8000-00000000d001","product_id":"PRODUCT","name":{"en":"Labneh","ar":"لبنة"},"qty":3,"price_currency":"usd","unit_price_cents":350,"line_total_cents":1050}],"payments":[{"id":"0193a000-0000-7000-8000-00000000e001","tender":"cash_usd","amount":1000,"currency":"usd"},{"id":"0193a000-0000-7000-8000-00000000e002","tender":"cash_lbp","amount":100000,"currency":"lbp"}],"stock_moves":[{"id":"0193a000-0000-7000-8000-00000000f001","product_id":"PRODUCT","qty":-3,"kind":"sale"}]}}'''
select r->>'status' as status, r->>'number' as number, r->>'replayed' as replayed
  from suqa.pos_push('0193a000-0000-7000-8000-000000000001',
       jsonb_build_array(replace(:sale, 'PRODUCT', (select id::text from suqa.products where name->>'en'='Labneh'))::jsonb)) p,
       jsonb_array_elements(p->'results') r;
select r->>'status' as status, r->>'number' as number, r->>'replayed' as replayed
  from suqa.pos_push('0193a000-0000-7000-8000-000000000001',
       jsonb_build_array(replace(:sale, 'PRODUCT', (select id::text from suqa.products where name->>'en'='Labneh'))::jsonb)) p,
       jsonb_array_elements(p->'results') r;

select count(*) as walkin_orders, sum(total_cents) as cents from suqa.orders where channel = 'walkin';
select count(*) as payments from suqa.payments;
select on_hand, reserved, needs_review from suqa.products where name->>'en'='Labneh';       -- 17, 0, f

-- device B pulls everything from cursor 0 (a fresh device would use pos_snapshot; this checks the feed)
select (p->>'count')::int as feed_rows, p->>'role' as role, p->'device'->>'prefix' as prefix
  from suqa.pos_pull('0193a000-0000-7000-8000-000000000002', 0) p;
select tbl, op, count(*) from suqa.sync_log group by 1,2 order by 1,2;
-- cost is stripped for a cashier
reset role;
insert into auth.users(id, phone, raw_user_meta_data) values ('44444444-4444-4444-4444-444444444444','+96170000004','{"full_name":"Cashier"}');
set role authenticated; set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
insert into suqa.shop_members(shop_id,user_id,role) select id,'44444444-4444-4444-4444-444444444444','staff' from suqa.shops where slug='abou-elie';
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select count(*) filter (where r->'row' ? 'cost_cents') as rows_with_cost, count(*) as product_rows
  from suqa.pos_pull('0193a000-0000-7000-8000-000000000002', 0) p, jsonb_array_elements(p->'rows') r where r->>'tbl' = 'products';
-- a cashier cannot set the rate without approval
select r->>'status' as status, r->>'error' as error from suqa.pos_push('0193a000-0000-7000-8000-000000000002', jsonb_build_array(jsonb_build_object(
  'op_id', '0193a000-0000-7000-8000-00000000a003', 'kind', 'rate.set', 'payload', jsonb_build_object('id','0193a000-0000-7000-8000-00000000b003','lbp_per_usd',90000)))) p, jsonb_array_elements(p->'results') r;

-- online order reserves stock, deducts at ready, releases on cancel
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select number from suqa.place_order((select id from suqa.shops where slug='abou-elie'),(select id from suqa.addresses where label='Home'),
  (select jsonb_agg(jsonb_build_object('product_id',id,'quantity',2)) from suqa.products where name->>'en'='Labneh'),'online 2 labneh');
select on_hand, reserved from suqa.products where name->>'en'='Labneh';       -- 17, 2
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
update suqa.orders set status='accepted' where customer_notes='online 2 labneh';
update suqa.orders set status='preparing' where customer_notes='online 2 labneh';
update suqa.orders set status='ready' where customer_notes='online 2 labneh';
select on_hand, reserved from suqa.products where name->>'en'='Labneh';       -- 15, 0
select kind, qty from suqa.stock_moves where ref_order_id = (select id from suqa.orders where customer_notes='online 2 labneh') order by at, kind;

-- revoke device B → pull/push refuse
select suqa.pos_revoke_device('0193a000-0000-7000-8000-000000000002');
\set ON_ERROR_STOP off
select suqa.pos_pull('0193a000-0000-7000-8000-000000000002', 0);   -- expect: device_revoked
\set ON_ERROR_STOP on
reset role;
select action, count(*) from suqa.audit_log group by 1 order by 1;
