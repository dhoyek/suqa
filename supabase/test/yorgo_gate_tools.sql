-- 106: the photo tools' gate — the shop's assistant switch does not matter; the master switch, the rate and the caps do. Rolls back.
\set ON_ERROR_STOP on
begin;
do $$
declare t uuid; s uuid; other uuid; u uuid := gen_random_uuid(); g jsonb; d date;
begin
  select tenant_id, id into t, s from suqa.shops limit 1;
  insert into suqa.yorgo_settings (tenant_id, enabled) values (t, true) on conflict (tenant_id) do nothing;
  update suqa.yorgo_settings set enabled = true, rate_per_min = 6, cap_global_usd = 100, cap_shop_usd = 10 where tenant_id = t;
  delete from suqa.yorgo_shops where shop_id = s;
  delete from suqa.yorgo_usage where tenant_id = t;
  select (now() at time zone coalesce((select timezone from suqa.tenants where id = t), 'UTC'))::date into d;

  -- the assistant is off for this shop; the tools are not
  assert (suqa.yorgo_gate(t, u, 'seller', s)->>'ok')::boolean = false, 'assistant needs the shop switch';
  g := suqa.yorgo_gate_tools(t, u, s); assert (g->>'ok')::boolean, 'tools without the shop switch: ' || g::text;
  -- a shop of another association, or none: off
  assert suqa.yorgo_gate_tools(t, u, null)->>'reason' = 'off', 'no shop';
  assert suqa.yorgo_gate_tools(gen_random_uuid(), u, s)->>'reason' = 'off', 'other association';
  -- the shop's cap: the default, then the shop's own
  insert into suqa.yorgo_usage (tenant_id, day, shop_id, user_id, cost_usd) values (t, d, s, u, 9.99);
  assert (suqa.yorgo_gate_tools(t, u, s)->>'ok')::boolean, 'under the default cap';
  update suqa.yorgo_usage set cost_usd = 10 where tenant_id = t and shop_id = s;
  assert suqa.yorgo_gate_tools(t, u, s)->>'reason' = 'cap_shop', 'default cap reached';
  insert into suqa.yorgo_shops (shop_id, tenant_id, enabled, cap_usd) values (s, t, false, 25);
  assert (suqa.yorgo_gate_tools(t, u, s)->>'ok')::boolean, 'the shop''s own cap counts, switched off or not';
  -- the association's cap and master switch
  update suqa.yorgo_settings set cap_global_usd = 10 where tenant_id = t;
  assert suqa.yorgo_gate_tools(t, u, s)->>'reason' = 'cap_global', 'association cap';
  update suqa.yorgo_settings set cap_global_usd = 100, enabled = false where tenant_id = t;
  assert suqa.yorgo_gate_tools(t, u, s)->>'reason' = 'off', 'master switch';
  -- only the server may ask
  assert not has_function_privilege('authenticated', 'suqa.yorgo_gate_tools(uuid,uuid,uuid)', 'execute') and not has_function_privilege('anon', 'suqa.yorgo_gate_tools(uuid,uuid,uuid)', 'execute'), 'server only';
  raise notice 'yorgo gate tools: all checks passed';
end $$;
rollback;
select 'yorgo_gate_tools ok' as result;
