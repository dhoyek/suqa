-- 13_storage.sql — images (Supabase Storage)                                 (2026-10-17)
-- One public bucket "media". Object paths: shops/<shop_id>/<file>  (logo, cover, product photos) and tenants/<tenant_id>/<file> (the association's logo).
-- Anyone can read (the storefront is public); only that shop's members or the tenant's staff can write.
-- Files are small (client compresses to ≤1200px JPEG/WebP before upload, see apps/web/lib/upload.ts).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 3 * 1024 * 1024, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- helper: may the caller manage files under shops/<shop_id>/ (shop people, association) or tenants/<tenant_id>/ (association admins — 73)?
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

drop policy if exists "media public read"   on storage.objects;
drop policy if exists "media shop insert"   on storage.objects;
drop policy if exists "media shop update"   on storage.objects;
drop policy if exists "media shop delete"   on storage.objects;
create policy "media public read" on storage.objects for select to anon, authenticated using (bucket_id = 'media');
create policy "media shop insert" on storage.objects for insert to authenticated with check (bucket_id = 'media' and suqa.can_manage_shop_media(name));
create policy "media shop update" on storage.objects for update to authenticated using (bucket_id = 'media' and suqa.can_manage_shop_media(name)) with check (bucket_id = 'media' and suqa.can_manage_shop_media(name));
create policy "media shop delete" on storage.objects for delete to authenticated using (bucket_id = 'media' and suqa.can_manage_shop_media(name));

select 'storage installed' as result;
