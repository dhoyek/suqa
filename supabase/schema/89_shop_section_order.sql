-- 89_shop_section_order.sql — each shop sets the order of its own sections (store page and POS chips).   (2026-11-21)
--
-- WHY: since 87 every shop's sections follow the association's shared category order, so a bakery's page opened with "Drinks"
-- before "Manakish". The shared list stays one list with one default order; a shop now puts ITS sections in the order it wants.
--
-- NOW:
--   * suqa.shop_section_order — one row per shop that chose an order: the category keys (products.section values) in that order.
--     No row = the shared order, as today. A section the shop did not list comes after the listed ones, in the shared order
--     (so a new category the shop starts using is never hidden).
--     Everyone may read it (the store page needs it); it is written only through the function below.
--   * suqa.shop_section_order_set(shop, keys[]) — the shop's owner / stock keeper, or the association (setup / admin).
--     Keys are cleaned: trimmed, no doubles, at most 200, only categories the association has or the shop's items use.
--     An empty list removes the row: back to the shared order.
--
-- Table changes: NEW table suqa.shop_section_order. Nothing else changes; no data is rewritten. Idempotent.

create table if not exists suqa.shop_section_order (
  shop_id     uuid primary key references suqa.shops(id) on delete cascade,
  tenant_id   uuid not null references suqa.tenants(id) on delete cascade,
  keys        text[] not null default '{}',
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  constraint shop_section_order_size check (cardinality(keys) <= 200)
);
alter table suqa.shop_section_order enable row level security;
revoke all on suqa.shop_section_order from public, anon, authenticated;
grant select on suqa.shop_section_order to anon, authenticated;
drop policy if exists shop_section_order_read on suqa.shop_section_order;
create policy shop_section_order_read on suqa.shop_section_order for select to anon, authenticated using (true);   -- an order of public section names; written only by the function

create or replace function suqa.shop_section_order_set(p_shop uuid, p_keys text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_role text; v_keys text[];
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  select tenant_id into v_tenant from suqa.shops where id = p_shop;
  if v_tenant is null then raise exception 'no_shop'; end if;
  v_role := suqa.pos_role(p_shop);
  if not (suqa.is_tenant_member(v_tenant) or coalesce(v_role, '') in ('owner', 'stock', 'setup')) then raise exception 'not_shop_staff'; end if;
  -- as given, in order: trimmed, first occurrence only, known categories only
  select coalesce(array_agg(k order by ord), '{}') into v_keys from (
    select distinct on (trim(k)) trim(k) as k, ord from unnest(coalesce(p_keys, '{}')) with ordinality as u(k, ord)
     where trim(k) <> '' and length(trim(k)) <= 60
       and (exists (select 1 from suqa.item_categories c where c.tenant_id = v_tenant and c.key = trim(k))
            or exists (select 1 from suqa.products p where p.shop_id = p_shop and p.section = trim(k)))
     order by trim(k), ord) q;
  if cardinality(v_keys) > 200 then raise exception 'too_many'; end if;
  if cardinality(v_keys) = 0 then
    delete from suqa.shop_section_order where shop_id = p_shop;
    return jsonb_build_object('ok', true, 'keys', '[]'::jsonb);
  end if;
  insert into suqa.shop_section_order (shop_id, tenant_id, keys, updated_at, updated_by) values (p_shop, v_tenant, v_keys, now(), auth.uid())
  on conflict (shop_id) do update set keys = excluded.keys, updated_at = now(), updated_by = auth.uid();
  return jsonb_build_object('ok', true, 'keys', to_jsonb(v_keys));
end $$;
revoke all on function suqa.shop_section_order_set(uuid, text[]) from public, anon;
grant execute on function suqa.shop_section_order_set(uuid, text[]) to authenticated;

select 'shop section order installed' as result, (select count(*) from suqa.shop_section_order) as shops_with_own_order;
