-- 73 — The association's own logo can be uploaded (shown next to its name on the site).
--   Files go to media/tenants/<tenant_id>/<file>. Until now only media/shops/<shop_id>/… was writable.
--   suqa.can_manage_shop_media(path) — the one rule behind the storage insert / update / delete policies (13) — now also says yes
--   for tenants/<tenant_id>/… when the caller is an ADMIN of that association (or a platform admin).
--   The logo's address is kept in tenants.branding.logo_url (the field exists since 02). Reading stays public, like all of "media".
-- No table changes, policies unchanged (they call this function). Base file 13 carries the same function. Requires 13. Idempotent.

create or replace function suqa.can_manage_shop_media(p_path text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_parts text[] := string_to_array(p_path, '/'); v_id uuid;
begin
  if array_length(v_parts, 1) < 3 or v_parts[1] not in ('shops', 'tenants') then return false; end if;
  begin v_id := v_parts[2]::uuid; exception when others then return false; end;
  if v_parts[1] = 'tenants' then
    return suqa.is_platform_admin() or suqa.is_tenant_admin(v_id);          -- the association's own files (its logo)
  end if;
  return suqa.is_shop_member(v_id)
      or suqa.is_tenant_member((select tenant_id from suqa.shops where id = v_id));
end $$;

select 'brand logo storage installed' as result;
