-- 115: "from the association directory" (shop owner, drivers panel) lists only the drivers shared with the association.
--   Before: pos_driver_directory listed every active driver of every other shop — also a driver his shop keeps for itself
--   (scope 'shop', script 98). Now only drivers whose shop set them to scope 'association' are listed, the same rule as
--   pos_association_drivers (the new-driver form). "used_by" names only the shops that share him.
--   Nothing else changes: owner only, drivers the shop already has are left out. No table change. Safe to run twice.

create or replace function suqa.pos_driver_directory(p_shop uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_tenant uuid;
begin
  if suqa.pos_role(p_shop) is distinct from 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  select tenant_id into v_tenant from suqa.shops where id = p_shop;
  return (
    select coalesce(jsonb_agg(x), '[]') from (
      select distinct on (d.phone_key) d.name, d.phone, d.vehicle, d.user_id is not null as has_account,
             (select string_agg(s2.name->>'ar', '، ') from suqa.shop_drivers d2 join suqa.shops s2 on s2.id = d2.shop_id
               where d2.phone_key = d.phone_key and d2.tenant_id = v_tenant and d2.active and d2.scope = 'association') as used_by
        from suqa.shop_drivers d
       where d.tenant_id = v_tenant and d.active and d.scope = 'association' and d.shop_id <> p_shop
         and not exists (select 1 from suqa.shop_drivers m where m.shop_id = p_shop and m.phone_key = d.phone_key)
       order by d.phone_key, d.updated_at desc nulls last) x
  );
end $function$;
