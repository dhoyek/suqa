-- 124: a signed-in account reads the public card only; the association reads its commission through a function. Rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare t uuid; s uuid; adm uuid := gen_random_uuid(); own uuid := gen_random_uuid(); cust uuid := gen_random_uuid(); ok boolean; r jsonb; n int;
begin
  select tenant_id, id into t, s from suqa.shops where status = 'active' limit 1;
  insert into auth.users (id, email) values (adm, 'adm124@test.local'), (own, 'own124@test.local'), (cust, 'cust124@test.local');
  insert into suqa.tenant_members (tenant_id, user_id, role) values (t, adm, 'admin');
  insert into suqa.shop_members (shop_id, user_id, role, active) values (s, own, 'owner', true);
  update suqa.shops set commission_rate = 0.07 where id = s; update suqa.tenants set commission_rate = 0.05 where id = t;

  -- a customer, signed in
  perform set_config('request.jwt.claim.sub', cust::text, true);
  set local role authenticated;
  select count(*) into n from (select id, slug, name, status, opening_hours, pos_enabled, section_names from suqa.shops) x; assert n > 0, 'public columns readable';
  select count(*) into n from (select id, brand_name, fx_lbp_rate, settings from suqa.tenants) x; assert n > 0, 'association readable';
  perform 1 from suqa.products p where p.is_active limit 1;                       -- its row policy looks at shops.status
  begin perform default_margin_pct, max_discount_pct from suqa.shops limit 1; ok := false; exception when insufficient_privilege then ok := true; end; assert ok, 'margin / discount closed';
  begin perform driver_pay_cents, printer, commission_rate from suqa.shops limit 1; ok := false; exception when insufficient_privilege then ok := true; end; assert ok, 'driver pay / printer / commission closed';
  begin perform x.* from suqa.shops x limit 1; ok := false; exception when insufficient_privilege then ok := true; end; assert ok, 'select * refused';
  begin perform commission_rate from suqa.tenants limit 1; ok := false; exception when insufficient_privilege then ok := true; end; assert ok, 'association commission closed';
  begin perform suqa.admin_commission(t, s); ok := false; exception when insufficient_privilege then ok := true; end; assert ok, 'a customer cannot ask for the commission';
  reset role;

  -- the shop owner: his own session reads the public card only (his till gets the settings through its own functions); he may still write his shop
  perform set_config('request.jwt.claim.sub', own::text, true);
  set local role authenticated;
  begin perform default_margin_pct from suqa.shops where id = s; ok := false; exception when insufficient_privilege then ok := true; end; assert ok, 'owner: not through the open table either';
  begin perform suqa.admin_commission(t, s); ok := false; exception when insufficient_privilege then ok := true; end; assert ok, 'an owner is not the association';
  update suqa.shops set is_open_override = is_open_override where id = s;          -- writing is unchanged
  reset role;
  assert (suqa.pos_shop_settings(s, '{}'::jsonb) ? 'default_margin_pct'), 'the till still gets its settings';

  -- the association admin
  perform set_config('request.jwt.claim.sub', adm::text, true);
  set local role authenticated;
  r := suqa.admin_commission(t, s);
  assert (r->>'tenant')::numeric = 0.05 and (r->>'shop')::numeric = 0.07, 'commission through the function: ' || r::text;
  assert (suqa.admin_commission(t, null)->>'shop') is null, 'no shop asked';
  update suqa.shops set commission_rate = 0.08 where id = s;                       -- the admin still sets it
  assert (suqa.admin_commission(t, s)->>'shop')::numeric = 0.08, 'updated';
  reset role;
end $$;
rollback;
\echo staff_columns ok
