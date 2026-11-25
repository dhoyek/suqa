-- 117: the association's admin edits a driver's details (Admin → Drivers → ✎).
--   admin_driver_update(tenant, phone_key, patch)   association ADMIN only. A driver is one person = one phone number, with one
--     line per shop he works for; the change is written to ALL his lines in the association, so he reads the same everywhere:
--       name     (not empty)
--       phone    (at least 6 digits; refused with 'phone_taken' when one of his shops already has another driver with that number)
--       vehicle  (empty = none)
--     Only the keys present in the patch are changed. After a phone change each line is linked again to the account that has
--     that number (_driver_link), as when a shop saves a driver.
--   NOT touched: which shops he works for, active / available, shop only / association, his pay, his settlements, his orders.
--   The shops' tills receive the change by sync (shop_drivers is in the sync log). Written in the audit log ('driver.edit').
-- No table change. Safe to run twice.

create or replace function suqa.admin_driver_update(p_tenant uuid, p_phone_key text, p_patch jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_name text := trim(coalesce(p_patch->>'name', '')); v_phone text := trim(coalesce(p_patch->>'phone', ''));
        v_key text; v_n int; r record;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if not suqa.is_tenant_admin(p_tenant) then raise exception 'not_allowed' using errcode = 'insufficient_privilege'; end if;
  if not exists (select 1 from suqa.shop_drivers where tenant_id = p_tenant and phone_key = p_phone_key) then raise exception 'driver_not_found'; end if;
  if p_patch ? 'name' and v_name = '' then raise exception 'bad_name'; end if;
  v_key := p_phone_key;
  if p_patch ? 'phone' then
    v_key := suqa._phone_key(v_phone);
    if v_key is null or length(v_key) < 6 then raise exception 'bad_phone'; end if;
    if v_key <> p_phone_key and exists (
         select 1 from suqa.shop_drivers mine join suqa.shop_drivers other on other.shop_id = mine.shop_id and other.phone_key = v_key
          where mine.tenant_id = p_tenant and mine.phone_key = p_phone_key) then
      raise exception 'phone_taken';
    end if;
  end if;
  perform 1 from suqa.shop_drivers where tenant_id = p_tenant and phone_key = p_phone_key for update;
  update suqa.shop_drivers set
    name      = case when p_patch ? 'name' then v_name else name end,
    phone     = case when p_patch ? 'phone' then v_phone else phone end,
    phone_key = v_key,
    vehicle   = case when p_patch ? 'vehicle' then nullif(trim(coalesce(p_patch->>'vehicle', '')), '') else vehicle end
  where tenant_id = p_tenant and phone_key = p_phone_key;
  get diagnostics v_n = row_count;
  for r in select id, shop_id from suqa.shop_drivers where tenant_id = p_tenant and phone_key = v_key loop
    if p_patch ? 'phone' then perform suqa._driver_link(r.id); end if;
    insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after)
    values (r.shop_id, p_tenant, auth.uid(), 'driver.edit', 'shop_drivers', r.id::text, (p_patch - 'phone') || jsonb_build_object('by', 'association', 'phone_changed', v_key <> p_phone_key));
  end loop;
  return jsonb_build_object('ok', true, 'rows', v_n, 'phone_key', v_key);
end $function$;
revoke all on function suqa.admin_driver_update(uuid, text, jsonb) from public, anon;
grant execute on function suqa.admin_driver_update(uuid, text, jsonb) to authenticated;
