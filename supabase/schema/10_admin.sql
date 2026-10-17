-- 10_admin.sql — helpers for the association admin             (2026-10-17)

-- Look up a user by email so an admin can make them a shop owner / staff / tenant member.
-- Only tenant members (or platform admins) may call it; returns at most id + name.
create or replace function suqa.find_user_by_email(p_tenant uuid, p_email text)
returns table (user_id uuid, full_name text, email text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not suqa.is_tenant_member(p_tenant) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  -- Only people who signed up on this tenant (or are already linked to it) can be found —
  -- prevents using the admin as a directory of every account on the platform.
  return query
    select u.id, p.full_name, u.email::text
      from auth.users u left join suqa.profiles p on p.id = u.id
     where lower(u.email) = lower(trim(p_email))
       and (p.home_tenant_id = p_tenant
            or exists (select 1 from suqa.tenant_members tm where tm.user_id = u.id and tm.tenant_id = p_tenant)
            or exists (select 1 from suqa.shop_members sm join suqa.shops s on s.id = sm.shop_id
                        where sm.user_id = u.id and s.tenant_id = p_tenant))
     limit 1;
end $$;
grant execute on function suqa.find_user_by_email(uuid, text) to authenticated;

-- Members of a tenant / shop with their display info (profiles are readable by tenant members, this just joins email in).
create or replace function suqa.tenant_people(p_tenant uuid)
returns table (user_id uuid, full_name text, email text, phone text, tenant_role suqa.tenant_role, shop_id uuid, shop_role suqa.shop_role)
language plpgsql stable security definer set search_path = public as $$
begin
  if not suqa.is_tenant_member(p_tenant) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  return query
    select u.id, p.full_name, u.email::text, p.phone, tm.role, sm.shop_id, sm.role
      from auth.users u
      left join suqa.profiles p on p.id = u.id
      left join suqa.tenant_members tm on tm.user_id = u.id and tm.tenant_id = p_tenant
      left join suqa.shop_members sm on sm.user_id = u.id
      left join suqa.shops s on s.id = sm.shop_id and s.tenant_id = p_tenant
     where tm.user_id is not null or s.id is not null;
end $$;
grant execute on function suqa.tenant_people(uuid) to authenticated;

-- Today's numbers for the dashboard (tenant timezone).
create or replace function suqa.tenant_stats(p_tenant uuid)
returns table (orders_today int, revenue_today numeric, pending_now int, active_shops int, pending_shops int, delivered_today int, rejected_today int)
language plpgsql stable security definer set search_path = public as $$
declare v_tz text; v_start timestamptz;
begin
  if not suqa.is_tenant_member(p_tenant) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  select timezone into v_tz from suqa.tenants where id = p_tenant;
  v_start := (date_trunc('day', now() at time zone v_tz)) at time zone v_tz;
  return query select
    (select count(*)::int from suqa.orders where tenant_id = p_tenant and placed_at >= v_start),
    (select coalesce(sum(total_usd), 0) from suqa.orders where tenant_id = p_tenant and placed_at >= v_start and status = 'delivered'),
    (select count(*)::int from suqa.orders where tenant_id = p_tenant and status = 'pending'),
    (select count(*)::int from suqa.shops where tenant_id = p_tenant and status = 'active'),
    (select count(*)::int from suqa.shops where tenant_id = p_tenant and status = 'pending'),
    (select count(*)::int from suqa.orders where tenant_id = p_tenant and placed_at >= v_start and status = 'delivered'),
    (select count(*)::int from suqa.orders where tenant_id = p_tenant and placed_at >= v_start and status = 'rejected');
end $$;
grant execute on function suqa.tenant_stats(uuid) to authenticated;

-- Zones as GeoJSON for the admin map (PostgREST returns geography as WKB hex otherwise).
create or replace function suqa.tenant_zones_geojson(p_tenant uuid)
returns table (id uuid, name jsonb, fee_usd numeric, eta_minutes int, is_active boolean, sort_order int, geojson jsonb)
language sql stable security definer set search_path = public, extensions as $$
  select z.id, z.name, z.fee_usd, z.eta_minutes, z.is_active, z.sort_order, st_asgeojson(z.area)::jsonb
    from suqa.delivery_zones z where z.tenant_id = p_tenant and suqa.is_tenant_member(p_tenant)
   order by z.sort_order
$$;
grant execute on function suqa.tenant_zones_geojson(uuid) to authenticated;
