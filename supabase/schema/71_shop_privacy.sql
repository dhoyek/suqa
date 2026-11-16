-- 71 — Shop privacy: costs are not public, association admins do not see a shop's business, and admins get a "setup" role.
--
--  A. ITEM COSTS.  The public read rule on suqa.products is per row, so every column — cost_cents, margin_pct, supplier_id … —
--     was readable with the public key. Table-wide SELECT is revoked from anon / authenticated and granted back column by
--     column (the storefront columns only). Costs now travel only through the POS sync functions, which check the role.
--     NOTE for later scripts: a new products column is private until it is granted here.
--
--  B. THE "setup" ROLE.  suqa.pos_role() used to answer 'owner' for every association admin / ops account, on every shop.
--     It now answers the person's real role in the shop, and 'setup' for an admin / ops account that is not a member.
--     setup may: register a device, edit items (not their cost / margin / supplier), bulk-price, import items, shop settings,
--                staff, devices, exchange rate.
--     setup may not: anything else — sales, orders, payments, purchases, suppliers, customers, debts, shifts, stock ledger,
--                reports, export, backup, approval PIN. Its device receives none of those rows (snapshot and feed).
--
--  C. ADMIN READ ACCESS.  Row policies on the shop-private tables no longer include association members. Orders (and their
--     WhatsApp log) stay visible to them for ONLINE orders only (the marketplace side: dashboard, support, commission).
--     Dashboard counters and account pages count online orders only.
--
--  D. An admin / ops account can be given a role in a shop only by that shop's own owner — or by anyone allowed while the
--     shop has no owner yet. (Otherwise "make myself owner" would undo all of the above.)
--
--  E. Visitors who are not signed in can no longer call any POS function at all (they were already refused inside, 70).
--
-- Functions are patched in place from their live definitions where only a gate changes (the script stops if an expected
-- line is missing); pos_snapshot is given in full. Requires 37, 63, 65, 69, 70. Idempotent.

-- ---------- A. item columns ---------------------------------------------------------------------------------------------
revoke select on suqa.products from anon, authenticated;
grant select (id, tenant_id, shop_id, name, description, price_usd, price_currency, price_lbp, unit, unit_kind, decimal_qty, image_url, is_available, is_active, sort_order, section, sku, vat, track_stock, visible_online, on_hand, reserved, available_days, created_at, updated_at)
  on suqa.products to anon, authenticated;

-- ---------- B. roles ----------------------------------------------------------------------------------------------------
create or replace function suqa.pos_role(p_shop uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select case role::text when 'staff' then 'cashier' else role::text end
       from suqa.shop_members where shop_id = p_shop and user_id = auth.uid() and active),
    case when suqa.is_platform_admin() or suqa.is_tenant_member((select tenant_id from suqa.shops where id = p_shop)) then 'setup' end)
$$;

-- in-place patches: (function, text to find, replacement). A patch already applied is skipped; a missing line stops the script.
do $$
declare
  p text[]; v_oid oid; v_def text; v_new text;
  patches text[][] := array[
    -- owner-only gates that the setup role may also pass
    array['pos_bulk_price',       'suqa.pos_role(p_shop) is distinct from ''owner''', 'coalesce(suqa.pos_role(p_shop), '''') not in (''owner'', ''setup'')'],
    array['pos_bulk_visibility',  'suqa.pos_role(p_shop) is distinct from ''owner''', 'coalesce(suqa.pos_role(p_shop), '''') not in (''owner'', ''setup'')'],
    array['pos_import_products',  'suqa.pos_role(p_shop) is distinct from ''owner''', 'coalesce(suqa.pos_role(p_shop), '''') not in (''owner'', ''setup'')'],
    array['pos_shop_settings',    'suqa.pos_role(p_shop) is distinct from ''owner''', 'coalesce(suqa.pos_role(p_shop), '''') not in (''owner'', ''setup'')'],
    array['pos_staff_list',       'suqa.pos_role(p_shop) is distinct from ''owner''', 'coalesce(suqa.pos_role(p_shop), '''') not in (''owner'', ''setup'')'],
    array['pos_staff_add_user',   'suqa.pos_role(p_shop) is distinct from ''owner''', 'coalesce(suqa.pos_role(p_shop), '''') not in (''owner'', ''setup'')'],
    array['pos_staff_invite',     'suqa.pos_role(p_shop) is distinct from ''owner''', 'coalesce(suqa.pos_role(p_shop), '''') not in (''owner'', ''setup'')'],
    array['pos_staff_set',        'suqa.pos_role(p_shop) is distinct from ''owner''', 'coalesce(suqa.pos_role(p_shop), '''') not in (''owner'', ''setup'')'],
    array['pos_staff_phone',      'suqa.pos_role(p_shop) is distinct from ''owner''', 'coalesce(suqa.pos_role(p_shop), '''') not in (''owner'', ''setup'')'],
    array['pos_account_search',   'suqa.pos_role(p_shop) is distinct from ''owner''', 'coalesce(suqa.pos_role(p_shop), '''') not in (''owner'', ''setup'')'],
    array['pos_revoke_device',    'suqa.pos_role(v_dev.shop_id) is distinct from ''owner''', 'coalesce(suqa.pos_role(v_dev.shop_id), '''') not in (''owner'', ''setup'')'],
    -- "any member" gates that the setup role must NOT pass
    array['pos_approval_pin',      'suqa.pos_role(p_shop) is null', 'coalesce(suqa.pos_role(p_shop), ''setup'') = ''setup'''],
    array['pos_account_addresses', 'suqa.pos_role(p_shop) is null', 'coalesce(suqa.pos_role(p_shop), ''setup'') = ''setup'''],
    -- an order's history: the shop's people; the association only for online orders
    array['pos_order_history', 'if v_role is null and not suqa.is_tenant_member(o.tenant_id) then', 'if v_role is null or (v_role = ''setup'' and o.channel <> ''online'') then'],
    -- the admin's own shop list: setup, not owner
    array['pos_my_shops', 'select s.id, ''owner'' from suqa.shops s', 'select s.id, ''setup'' from suqa.shops s'],
    -- feed: setup receives catalogue tables only, never cost / margin / supplier
    array['pos_pull', 'case when tbl in (''products'',''order_items'') and v_role <> ''owner'' then row - ''cost_cents'' else row end as row',
                      'case when tbl in (''products'',''order_items'') and v_role <> ''owner'' then row - ''cost_cents'' - (case when v_role = ''setup'' then array[''margin_pct'',''supplier_id''] else ''{}''::text[] end) else row end as row'],
    array['pos_pull', '       and (shop_id = v_dev.shop_id or (shop_id is null and tenant_id = v_dev.tenant_id))',
                      '       and (shop_id = v_dev.shop_id or (shop_id is null and tenant_id = v_dev.tenant_id))' || E'\n' ||
                      '       and (v_role <> ''setup'' or tbl in (''products'',''product_barcodes'',''shops'',''devices''))'],
    -- push: setup may only edit items (never their cost / margin / supplier) and the exchange rate
    array['pos_push', '      if v_role = ''stock'' and v_kind not in',
                      '      if v_role = ''setup'' and v_kind not in (''product.patch'',''rate.set'') then raise exception ''role_not_allowed'' using errcode = ''insufficient_privilege''; end if;' || E'\n' ||
                      '      if v_role = ''stock'' and v_kind not in'],
    array['pos_push', 'when ''product.patch'' then suqa._pos_product_patch(v_dev, v_op->''payload'', v_user)',
                      'when ''product.patch'' then suqa._pos_product_patch(v_dev, case when v_role = ''setup'' and v_op->''payload'' ? ''fields'' then jsonb_set(v_op->''payload'', ''{fields}'', (v_op->''payload''->''fields'') - ''cost_cents'' - ''margin_pct'' - ''supplier_id'') else v_op->''payload'' end, v_user)'],
    -- association dashboards and account pages: online orders only
    array['tenant_stats',           'from suqa.orders where tenant_id = p_tenant', 'from suqa.orders where channel = ''online'' and tenant_id = p_tenant'],
    array['tenant_accounts',        'from suqa.orders o where o.tenant_id = p_tenant and o.customer_id is not null', 'from suqa.orders o where o.channel = ''online'' and o.tenant_id = p_tenant and o.customer_id is not null'],
    array['tenant_accounts',        'from suqa.orders o where o.customer_id = u.id and o.tenant_id = p_tenant', 'from suqa.orders o where o.channel = ''online'' and o.customer_id = u.id and o.tenant_id = p_tenant'],
    array['admin_account_activity', 'from suqa.orders where customer_id = p_user and tenant_id = p_tenant', 'from suqa.orders where channel = ''online'' and customer_id = p_user and tenant_id = p_tenant']
  ];
begin
  foreach p slice 1 in array patches loop
    select pr.oid into v_oid from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace where n.nspname = 'suqa' and pr.proname = p[1];
    if v_oid is null then raise exception 'function % not found', p[1]; end if;
    v_def := pg_get_functiondef(v_oid);
    if position(p[3] in v_def) > 0 then continue; end if;                       -- already applied
    if position(p[2] in v_def) = 0 then raise exception 'expected line not found in %: %', p[1], p[2]; end if;
    v_new := replace(v_def, p[2], p[3]);
    execute v_new;
  end loop;
end $$;

-- the device's first copy of the shop (37 + nothing private for the setup role)
create or replace function suqa.pos_snapshot(p_device uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_dev suqa.devices; v_role text; v_cursor bigint; v_owner boolean; v_setup boolean;
begin
  select * into v_dev from suqa.devices where id = p_device;
  if not found then raise exception 'device_not_found'; end if;
  if v_dev.revoked_at is not null then raise exception 'device_revoked'; end if;
  v_role := suqa.pos_role(v_dev.shop_id);
  if v_role is null then raise exception 'not_a_member' using errcode = 'insufficient_privilege'; end if;
  v_owner := v_role = 'owner';
  v_setup := v_role = 'setup';   -- an association admin setting the shop up: catalogue and settings only, nothing about its business
  select coalesce(max(seq), 0) into v_cursor from suqa.sync_log;

  return jsonb_build_object(
    'cursor', v_cursor, 'server_now', now(), 'role', v_role,
    'device', jsonb_build_object('id', v_dev.id, 'prefix', v_dev.prefix, 'name', v_dev.name),
    'shop', (select to_jsonb(s) - 'commission_rate' - 'cover_url' - 'location' from suqa.shops s where s.id = v_dev.shop_id),
    'categories', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from suqa.categories c where c.tenant_id = v_dev.tenant_id),
    'products', (select coalesce(jsonb_agg(case when v_owner then to_jsonb(p) when v_setup then to_jsonb(p) - 'cost_cents' - 'margin_pct' - 'supplier_id' else to_jsonb(p) - 'cost_cents' end), '[]')
                   from suqa.products p where p.shop_id = v_dev.shop_id and p.is_active),
    'product_barcodes', (select coalesce(jsonb_agg(to_jsonb(b)), '[]') from suqa.product_barcodes b where b.shop_id = v_dev.shop_id),
    'quick_buttons', (select coalesce(jsonb_agg(to_jsonb(q)), '[]') from suqa.quick_buttons q where q.shop_id = v_dev.shop_id),
    'exchange_rates', (select coalesce(jsonb_agg(to_jsonb(r)), '[]') from (select * from suqa.exchange_rates where shop_id = v_dev.shop_id order by effective_at desc limit 50) r),
    'shop_members', case when v_setup then '[]'::jsonb else (select coalesce(jsonb_agg(to_jsonb(m) || jsonb_build_object('full_name', p.full_name)), '[]')
                       from suqa.shop_members m left join suqa.profiles p on p.id = m.user_id where m.shop_id = v_dev.shop_id) end,
    'devices', (select coalesce(jsonb_agg(to_jsonb(d)), '[]') from suqa.devices d where d.shop_id = v_dev.shop_id),
    'orders', case when v_setup then '[]'::jsonb else (select coalesce(jsonb_agg(to_jsonb(o)), '[]') from suqa.orders o
                where o.shop_id = v_dev.shop_id and (o.closed_at is null or o.placed_at > now() - interval '7 days' or o.id in (select order_id from suqa.payments where shop_id = v_dev.shop_id and tender = 'unpaid'))) end,
    'order_items', case when v_setup then '[]'::jsonb else (select coalesce(jsonb_agg(case when v_owner then to_jsonb(i) else to_jsonb(i) - 'cost_cents' end), '[]')
                      from suqa.order_items i join suqa.orders o on o.id = i.order_id
                     where o.shop_id = v_dev.shop_id and (o.closed_at is null or o.placed_at > now() - interval '7 days' or o.id in (select order_id from suqa.payments where shop_id = v_dev.shop_id and tender = 'unpaid'))) end,
    'payments', case when v_setup then '[]'::jsonb else (select coalesce(jsonb_agg(to_jsonb(p)), '[]') from suqa.payments p join suqa.orders o on o.id = p.order_id
                  where o.shop_id = v_dev.shop_id and (o.closed_at is null or o.placed_at > now() - interval '7 days' or o.id in (select order_id from suqa.payments where shop_id = v_dev.shop_id and tender = 'unpaid'))) end,
    'shifts', case when v_setup then '[]'::jsonb else (select coalesce(jsonb_agg(to_jsonb(s)), '[]') from suqa.shifts s where s.shop_id = v_dev.shop_id and (s.closed_at is null or s.opened_at > now() - interval '7 days')) end,
    'cash_moves', case when v_setup then '[]'::jsonb else (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from suqa.cash_moves c join suqa.shifts s on s.id = c.shift_id
                    where s.shop_id = v_dev.shop_id and (s.closed_at is null or s.opened_at > now() - interval '7 days')) end,
    'suppliers', case when v_setup then '[]'::jsonb else (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.suppliers x where x.shop_id = v_dev.shop_id) end,
    'shop_drivers', case when v_setup then '[]'::jsonb else (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.shop_drivers x where x.shop_id = v_dev.shop_id) end,
    'purchases', case when v_setup then '[]'::jsonb else (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.purchases x where x.shop_id = v_dev.shop_id and x.at > now() - interval '180 days') end,
    'purchase_lines', case when v_setup then '[]'::jsonb else (select coalesce(jsonb_agg(to_jsonb(l)), '[]') from suqa.purchase_lines l join suqa.purchases x on x.id = l.purchase_id where x.shop_id = v_dev.shop_id and x.at > now() - interval '180 days') end,
    'supplier_payments', case when v_setup then '[]'::jsonb else (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.supplier_payments x where x.shop_id = v_dev.shop_id and x.at > now() - interval '180 days') end,
    'shop_customers', case when v_setup then '[]'::jsonb else (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.shop_customers x where x.shop_id = v_dev.shop_id) end,
    'debt_settlements', case when v_setup then '[]'::jsonb else (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.debt_settlements x where x.shop_id = v_dev.shop_id) end,
    'debt_allocations', case when v_setup then '[]'::jsonb else (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from suqa.debt_allocations x where x.shop_id = v_dev.shop_id) end,
    'stock_moves', case when v_setup then '[]'::jsonb else (select coalesce(jsonb_agg(to_jsonb(m)), '[]') from (select * from suqa.stock_moves where shop_id = v_dev.shop_id order by at desc limit 2000) m) end
  );
end $$;

-- ---------- C. row policies: shop-private tables are the shop's -------------------------------------------------------------
do $$
declare
  p text[]; v_qual text; v_chk text; v_q2 text; v_c2 text;
  pol text[][] := array[
    array['cash_moves', 'cm_read', ' OR suqa.is_tenant_member(tenant_id)', ''],
    array['debt_allocations', 'da_read', ' OR suqa.is_tenant_member(tenant_id)', ''],
    array['debt_settlements', 'ds_read', ' OR suqa.is_tenant_member(tenant_id)', ''],
    array['driver_payouts', 'driver_payouts_read', ' OR suqa.is_tenant_member(tenant_id)', ''],
    array['payments', 'pay_read', ' OR suqa.is_tenant_member(tenant_id)', ''],
    array['purchase_lines', 'purl_read', ' OR suqa.is_tenant_member(tenant_id)', ''],
    array['purchases', 'pur_read', ' OR suqa.is_tenant_member(tenant_id)', ''],
    array['return_lines', 'rl_read', ' OR suqa.is_tenant_member(tenant_id)', ''],
    array['returns', 'ret_read', ' OR suqa.is_tenant_member(tenant_id)', ''],
    array['shifts', 'sh_read', ' OR suqa.is_tenant_member(tenant_id)', ''],
    array['shop_customers', 'sc_read', ' OR suqa.is_tenant_member(tenant_id)', ''],
    array['stock_moves', 'sm_read', ' OR suqa.is_tenant_member(tenant_id)', ''],
    array['supplier_payments', 'supp_read', ' OR suqa.is_tenant_member(tenant_id)', ''],
    array['suppliers', 'sup_read', ' OR suqa.is_tenant_member(tenant_id)', ''],
    array['conflict_log', 'cl_owner', ' OR suqa.is_tenant_member(tenant_id)', ''],
    array['shop_drivers', 'shop_drivers_read', ' OR suqa.is_tenant_member(tenant_id)', ''],
    -- the audit trail of a shop is the owner's; the association keeps its own account-administration entries (shop id all zeros)
    array['audit_log', 'al_owner_read', 'suqa.is_tenant_member(tenant_id)', '(suqa.is_tenant_member(tenant_id) AND (shop_id = ''00000000-0000-0000-0000-000000000000''::uuid))'],
    -- orders: the association sees the marketplace (online) side only
    array['orders', 'orders_read', 'suqa.is_tenant_member(tenant_id)', '(suqa.is_tenant_member(tenant_id) AND (channel = ''online''::text))'],
    array['orders', 'orders_update', 'suqa.is_tenant_member(tenant_id)', '(suqa.is_tenant_member(tenant_id) AND (channel = ''online''::text))'],
    array['wa_messages', 'wa_messages_read', 'suqa.is_tenant_member(o.tenant_id)', '(suqa.is_tenant_member(o.tenant_id) AND (o.channel = ''online''::text))']
  ];
begin
  foreach p slice 1 in array pol loop
    select pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid) into v_qual, v_chk
      from pg_policy where polrelid = ('suqa.' || p[1])::regclass and polname = p[2];
    if not found then raise exception 'policy %.% not found', p[1], p[2]; end if;
    if p[4] <> '' and (position(p[4] in coalesce(v_qual, '')) > 0 or position(p[4] in coalesce(v_chk, '')) > 0) then continue; end if;   -- already applied
    if position('is_tenant_member' in coalesce(v_qual, '') || coalesce(v_chk, '')) = 0 then continue; end if;                          -- already applied (removed)
    if position(p[3] in coalesce(v_qual, '') || coalesce(v_chk, '')) = 0 then raise exception 'policy %.%: expected text not found (%).', p[1], p[2], coalesce(v_qual, '') || ' / ' || coalesce(v_chk, ''); end if;
    v_q2 := replace(v_qual, p[3], p[4]); v_c2 := replace(v_chk, p[3], p[4]);
    if v_qual is not null then execute format('alter policy %I on suqa.%I using (%s)', p[2], p[1], v_q2); end if;
    if v_chk  is not null then execute format('alter policy %I on suqa.%I with check (%s)', p[2], p[1], v_c2); end if;
  end loop;
end $$;

-- the change feed carries whole rows of everything: shop rows for the shop's people, shared rows (categories…) for the association
drop policy if exists sl_read on suqa.sync_log;
create policy sl_read on suqa.sync_log for select to authenticated
  using ((shop_id is not null and suqa.is_shop_member(shop_id)) or (shop_id is null and suqa.is_tenant_member(tenant_id)));

-- ---------- D. an admin gets a shop role only from the shop's owner ---------------------------------------------------------
create or replace function suqa.shop_members_guard_admin() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  if auth.uid() is null then return new; end if;                                   -- service key / database owner (imports, seeding)
  if tg_op = 'UPDATE' and new.role is not distinct from old.role and new.active is not distinct from old.active then return new; end if;
  if not coalesce(new.active, true) then return new; end if;                       -- removing or switching off is always allowed
  select tenant_id into v_tenant from suqa.shops where id = new.shop_id;
  -- is the person being given the role part of the association (or the platform)?
  if not exists (select 1 from suqa.tenant_members tm where tm.tenant_id = v_tenant and tm.user_id = new.user_id)
     and not exists (select 1 from suqa.platform_admins pa where pa.user_id = new.user_id) then
    return new;
  end if;
  -- fine while the shop has no other active owner; after that only one of its owners may do it
  if not exists (select 1 from suqa.shop_members m where m.shop_id = new.shop_id and m.role = 'owner' and m.active and m.user_id <> new.user_id) then return new; end if;
  if exists (select 1 from suqa.shop_members m where m.shop_id = new.shop_id and m.role = 'owner' and m.active and m.user_id = auth.uid() and m.user_id <> new.user_id) then return new; end if;
  raise exception 'owner_must_add_admin' using errcode = 'insufficient_privilege',
    detail = 'An association admin can be given a role in a shop only by that shop''s owner.';
end $$;
revoke all on function suqa.shop_members_guard_admin() from public, anon, authenticated;
drop trigger if exists shop_members_guard_admin on suqa.shop_members;
create trigger shop_members_guard_admin before insert or update on suqa.shop_members
  for each row execute function suqa.shop_members_guard_admin();

-- ---------- E. no POS function for visitors who are not signed in ----------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, has_function_privilege('authenticated', p.oid, 'execute') as auth
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'suqa' and (p.proname like 'pos\_%' or p.proname like '\_pos\_%')
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
    if r.auth then execute format('grant execute on function %s to authenticated', r.sig); end if;
  end loop;
end $$;

select 'shop privacy installed' as result;
