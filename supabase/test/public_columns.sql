-- 114: the public key reads the public card of a shop / association and nothing else. Rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare n int; ok boolean;
begin
  set local role anon;
  select count(*) into n from (select id, slug, name, status, opening_hours, hide_online_when_zero, default_delivery_fee_usd, section_names from suqa.shops) x;
  assert n > 0, 'anon reads the public columns of the active shops';
  select count(*) into n from (select id, slug, brand_name, fx_lbp_rate, branding, settings from suqa.tenants) x;
  assert n > 0, 'anon reads the association';
  perform 1 from suqa.tenant_domains d join suqa.tenants t on t.id = d.tenant_id limit 1;
  perform 1 from suqa.products p where p.is_active limit 1;                       -- its row policy looks at shops.status
  begin perform commission_rate from suqa.shops limit 1; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'shop commission closed';
  begin perform default_margin_pct, max_discount_pct, driver_pay_cents, printer from suqa.shops limit 1; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'shop settings closed';
  begin perform s.* from suqa.shops s limit 1; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'select * refused';
  begin perform commission_rate from suqa.tenants limit 1; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'association commission closed';
  begin update suqa.shops set sort_order = sort_order; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'no write grant';
  reset role;
  set local role authenticated;
  perform s.* from suqa.shops s limit 1;                                          -- signed-in accounts: unchanged
  perform commission_rate from suqa.tenants limit 1;
  reset role;
end $$;
rollback;
\echo public_columns ok
