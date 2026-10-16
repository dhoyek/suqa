-- 08_rls.sql — row-level security                        (2026-10-16)
-- Principle: RLS is the boundary. App code filters by tenant for UX; RLS enforces ownership.
-- Writes to orders happen only through suqa.place_order() and status updates.

do $$ declare t text; begin
  foreach t in array array['tenants','tenant_domains','profiles','platform_admins','tenant_members',
    'shops','shop_members','categories','products','delivery_zones','shop_delivery_zones',
    'addresses','orders','order_items','order_events','order_counters'] loop
    execute format('alter table suqa.%I enable row level security', t);
  end loop;
end $$;

-- helper to (re)create policies idempotently
create or replace function suqa._policy(p_table text, p_name text, p_cmd text, p_roles text, p_using text, p_check text default null)
returns void language plpgsql as $$
begin
  execute format('drop policy if exists %I on suqa.%I', p_name, p_table);
  execute format('create policy %I on suqa.%I for %s to %s %s %s',
    p_name, p_table, p_cmd, p_roles,
    case when p_using is not null then 'using (' || p_using || ')' else '' end,
    case when p_check is not null then 'with check (' || p_check || ')' else '' end);
end $$;

-- tenants: public read (branding), platform writes, tenant admin edits own
select suqa._policy('tenants','tenants_read','select','anon, authenticated','true');
select suqa._policy('tenants','tenants_platform_write','all','authenticated','suqa.is_platform_admin()','suqa.is_platform_admin()');
select suqa._policy('tenants','tenants_admin_update','update','authenticated','suqa.is_tenant_admin(id)','suqa.is_tenant_admin(id)');

-- tenant_domains
select suqa._policy('tenant_domains','domains_read','select','anon, authenticated','true');
select suqa._policy('tenant_domains','domains_platform_write','all','authenticated','suqa.is_platform_admin()','suqa.is_platform_admin()');

-- profiles
select suqa._policy('profiles','profiles_self_read','select','authenticated','id = auth.uid() or suqa.is_tenant_member(home_tenant_id)');
select suqa._policy('profiles','profiles_self_update','update','authenticated','id = auth.uid()','id = auth.uid()');

-- platform_admins: readable by self only; managed via service role / SQL editor
select suqa._policy('platform_admins','platform_admins_self','select','authenticated','user_id = auth.uid()');

-- tenant_members
select suqa._policy('tenant_members','tm_read','select','authenticated','user_id = auth.uid() or suqa.is_tenant_member(tenant_id)');
select suqa._policy('tenant_members','tm_admin_write','all','authenticated','suqa.is_tenant_admin(tenant_id)','suqa.is_tenant_admin(tenant_id)');

-- shops
select suqa._policy('shops','shops_public_read','select','anon, authenticated',
  'status = ''active'' or suqa.is_shop_member(id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('shops','shops_tenant_write','all','authenticated','suqa.is_tenant_member(tenant_id)','suqa.is_tenant_member(tenant_id)');
select suqa._policy('shops','shops_member_update','update','authenticated','suqa.is_shop_member(id)','suqa.is_shop_member(id) and status in (''active'',''paused'')');

-- shop_members
select suqa._policy('shop_members','sm_read','select','authenticated','user_id = auth.uid() or suqa.is_shop_member(shop_id) or suqa.is_tenant_member((select tenant_id from suqa.shops s where s.id = shop_id))');
select suqa._policy('shop_members','sm_write','all','authenticated',
  'suqa.is_shop_owner(shop_id) or suqa.is_tenant_member((select tenant_id from suqa.shops s where s.id = shop_id))',
  'suqa.is_shop_owner(shop_id) or suqa.is_tenant_member((select tenant_id from suqa.shops s where s.id = shop_id))');

-- categories
select suqa._policy('categories','cat_read','select','anon, authenticated','true');
select suqa._policy('categories','cat_write','all','authenticated','suqa.is_tenant_member(tenant_id)','suqa.is_tenant_member(tenant_id)');

-- products
select suqa._policy('products','prod_public_read','select','anon, authenticated',
  '(is_active and exists (select 1 from suqa.shops s where s.id = shop_id and s.status = ''active''))
   or suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('products','prod_write','all','authenticated',
  'suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)',
  '(suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id))
   and tenant_id = (select tenant_id from suqa.shops s where s.id = shop_id)');

-- delivery zones
select suqa._policy('delivery_zones','zones_read','select','anon, authenticated','true');
select suqa._policy('delivery_zones','zones_write','all','authenticated','suqa.is_tenant_member(tenant_id)','suqa.is_tenant_member(tenant_id)');
select suqa._policy('shop_delivery_zones','sz_read','select','anon, authenticated','true');
select suqa._policy('shop_delivery_zones','sz_write','all','authenticated',
  'suqa.is_shop_owner(shop_id) or suqa.is_tenant_member((select tenant_id from suqa.shops s where s.id = shop_id))',
  'suqa.is_shop_owner(shop_id) or suqa.is_tenant_member((select tenant_id from suqa.shops s where s.id = shop_id))');

-- addresses: strictly the customer's own (tenant staff see them via the order snapshot)
select suqa._policy('addresses','addr_own','all','authenticated','user_id = auth.uid()','user_id = auth.uid()');

-- orders: read by customer / shop / tenant; created only via place_order(); status updates by role
select suqa._policy('orders','orders_read','select','authenticated',
  'customer_id = auth.uid() or suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
select suqa._policy('orders','orders_update','update','authenticated',
  'customer_id = auth.uid() or suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)',
  'customer_id = auth.uid() or suqa.is_shop_member(shop_id) or suqa.is_tenant_member(tenant_id)');
-- (no insert/delete policies: inserts go through the security-definer function)

-- order_items / order_events follow the order
select suqa._policy('order_items','items_read','select','authenticated',
  'exists (select 1 from suqa.orders o where o.id = order_id)');
select suqa._policy('order_events','events_read','select','authenticated',
  'exists (select 1 from suqa.orders o where o.id = order_id)');
select suqa._policy('order_events','events_note_insert','insert','authenticated',null,
  'to_status is null and from_status is null and actor_id = auth.uid()
   and exists (select 1 from suqa.orders o where o.id = order_id and (suqa.is_shop_member(o.shop_id) or suqa.is_tenant_member(o.tenant_id)))');

-- order_counters: no client access
