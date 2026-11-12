-- 61_access_hardening.sql — close what a security review of the API surface found.   (2026-11-12)
-- The POS and the web app already behave correctly; these are things someone could do by calling the API directly.
--
-- 1. BLOCKED STAFF KEPT THEIR ACCESS. is_shop_member / is_shop_owner (used by almost every access rule) ignored
--    shop_members.active — a member switched off in Settings → staff could no longer unlock the till (pos_role checks it) but
--    could still read the shop's orders and customers and write its products through the API. Both now require active.
-- 2. ANY MEMBER COULD EDIT THE SHOP ROW AND THE CATALOGUE DIRECTLY. shops_member_update / prod_write / pb_write were open to
--    every member, cashier included — max discount, driver pay default, opening hours, prices, deleting products — bypassing the
--    role and approval rules of the POS (which go through pos_push). Now: the shop row → owner; products and barcodes →
--    owner or stock role (the same people the POS lets edit items). The association keeps its access through its own rules.
-- 3. FUNCTIONS WITH NO CHECK OF THEIR OWN, CALLABLE BY ANYONE (even without signing in):
--      open_debts(shop)                 every open debt of any shop: names, phone numbers, amounts
--      wa_match_order(phone, …)         finds a customer's order from a phone number
--      wa_sender_for_order, order_event_payload
--      orders_touch_customer_row(order) writes a customer record from a made-up order
--      prune_sync_log / pos_prune_sync_log   deletes the change feed the tills sync from
--      next_order_number(tenant)        burns order numbers
--      supplier_recalc(supplier)
--    They are steps of other functions (reports, order placing, the WhatsApp webhook with the service key) and stay usable
--    there. Direct EXECUTE is revoked from public / anon / authenticated; kept for service_role.
-- 4. migration_map (old POS key → new id, 17k rows) had no row security at all: readable and writable by anyone. Row security
--    on, no policies, direct grants removed — the migration runs with the service key / inside migrate_apply.
-- Base files 07, 08, 21 and 38 carry the same text. Requires 58. Idempotent.

-- ---------- 1 -----------------------------------------------------------------------------------------------------------
create or replace function suqa.is_shop_member(p_shop uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from suqa.shop_members
                  where shop_id = p_shop and user_id = auth.uid() and active)
$$;

create or replace function suqa.is_shop_owner(p_shop uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from suqa.shop_members
                  where shop_id = p_shop and user_id = auth.uid() and role = 'owner' and active)
$$;

-- ---------- 2 -----------------------------------------------------------------------------------------------------------
select suqa._policy('shops','shops_member_update','update','authenticated','suqa.is_shop_owner(id)','suqa.is_shop_owner(id) and status in (''active'',''paused'')');

select suqa._policy('products','prod_write','all','authenticated',
  'suqa.pos_role(shop_id) in (''owner'',''stock'') or suqa.is_tenant_member(tenant_id)',
  '(suqa.pos_role(shop_id) in (''owner'',''stock'') or suqa.is_tenant_member(tenant_id))
   and tenant_id = (select tenant_id from suqa.shops s where s.id = shop_id)');

select suqa._policy('product_barcodes','pb_write','all','authenticated',
  'suqa.pos_role(shop_id) in (''owner'',''stock'') or suqa.is_tenant_member(tenant_id)',
  'suqa.pos_role(shop_id) in (''owner'',''stock'') or suqa.is_tenant_member(tenant_id)');

-- ---------- 3 -----------------------------------------------------------------------------------------------------------
do $$
declare f record; v_service boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
     where p.pronamespace = 'suqa'::regnamespace
       and p.proname in ('open_debts','wa_match_order','wa_sender_for_order','order_event_payload','orders_touch_customer_row',
                         'prune_sync_log','pos_prune_sync_log','next_order_number','supplier_recalc')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if v_service then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
end $$;

-- ---------- 4 -----------------------------------------------------------------------------------------------------------
alter table suqa.migration_map enable row level security;
revoke all on table suqa.migration_map from public, anon, authenticated;

-- what is left (expect 0 / 0 / true)
select (select count(*) from pg_proc p where p.pronamespace = 'suqa'::regnamespace
          and p.proname in ('open_debts','wa_match_order','wa_sender_for_order','order_event_payload','orders_touch_customer_row','prune_sync_log','pos_prune_sync_log','next_order_number','supplier_recalc')
          and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) as unguarded_functions_still_callable,
       (select count(*) from pg_class c where c.relnamespace = 'suqa'::regnamespace and c.relkind = 'r' and not c.relrowsecurity) as tables_without_row_security,
       (select relrowsecurity from pg_class where oid = 'suqa.migration_map'::regclass) as migration_map_protected;
