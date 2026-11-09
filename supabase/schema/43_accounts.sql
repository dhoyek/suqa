-- 43_accounts.sql — accounts are the identity; phones are just how people find them.
--  • tenant_accounts(tenant)         admin: every signed-in account that has touched this tenant, with its roles
--  • pos_account_search(shop, q)     shop owner: find an existing account by name / number to add as staff (≥3 chars, 10 rows)
--  • pos_staff_add_user(shop, user, role, name)   shop owner: link that account as a member (by user id, not phone)
--  • pos_driver_directory(shop)      shop owner: drivers other shops of the association already use (one driver, many shops)
-- Requires 25 (pos_staff_invite/pos_role), 37 (shop_drivers), 41 (access_requests).

create or replace function suqa.tenant_accounts(p_tenant uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not suqa.is_tenant_member(p_tenant) then raise exception 'not allowed' using errcode = 'insufficient_privilege'; end if;
  return (
    with people as (
      select tm.user_id from suqa.tenant_members tm where tm.tenant_id = p_tenant
      union select sm.user_id from suqa.shop_members sm join suqa.shops s on s.id = sm.shop_id where s.tenant_id = p_tenant
      union select d.user_id from suqa.shop_drivers d where d.tenant_id = p_tenant and d.user_id is not null
      union select ar.user_id from suqa.access_requests ar where ar.tenant_id = p_tenant
      union select o.customer_id from suqa.orders o where o.tenant_id = p_tenant and o.customer_id is not null
      union select cp.user_id from suqa.couriers cp where cp.tenant_id = p_tenant
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', u.id, 'name', p.full_name, 'phone', u.phone, 'email', u.email,
             'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at,
             'tenant_role', (select tm.role::text from suqa.tenant_members tm where tm.tenant_id = p_tenant and tm.user_id = u.id),
             'shops', (select coalesce(jsonb_agg(jsonb_build_object('shop_id', s.id, 'name', s.name, 'role', sm.role::text, 'active', sm.active) order by s.sort_order), '[]')
                         from suqa.shop_members sm join suqa.shops s on s.id = sm.shop_id where sm.user_id = u.id and s.tenant_id = p_tenant),
             'driver_for', (select coalesce(jsonb_agg(s.name order by s.sort_order), '[]') from suqa.shop_drivers d join suqa.shops s on s.id = d.shop_id where d.user_id = u.id and d.tenant_id = p_tenant and d.active),
             'courier', exists (select 1 from suqa.couriers cp where cp.user_id = u.id and cp.tenant_id = p_tenant),
             'orders', (select count(*) from suqa.orders o where o.customer_id = u.id and o.tenant_id = p_tenant),
             'pending_requests', (select count(*) from suqa.access_requests ar where ar.user_id = u.id and ar.tenant_id = p_tenant and ar.status = 'pending')
           ) order by coalesce(u.last_sign_in_at, u.created_at) desc), '[]')
      from people pe join auth.users u on u.id = pe.user_id left join suqa.profiles p on p.id = u.id
  );
end $$;
grant execute on function suqa.tenant_accounts(uuid) to authenticated;

-- Owner-side lookup when adding staff: name or number, same tenant only, at least 3 characters, 10 rows, no enumeration of
-- unrelated users (only accounts that have touched this association).
create or replace function suqa.pos_account_search(p_shop uuid, p_q text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid; v_q text := lower(trim(coalesce(p_q, ''))); v_digits text := suqa._digits(coalesce(p_q, ''));
begin
  if suqa.pos_role(p_shop) <> 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  if length(v_q) < 3 then return '[]'::jsonb; end if;
  select tenant_id into v_tenant from suqa.shops where id = p_shop;
  return (
    with people as (
      select tm.user_id from suqa.tenant_members tm where tm.tenant_id = v_tenant
      union select sm.user_id from suqa.shop_members sm join suqa.shops s on s.id = sm.shop_id where s.tenant_id = v_tenant
      union select d.user_id from suqa.shop_drivers d where d.tenant_id = v_tenant and d.user_id is not null
      union select ar.user_id from suqa.access_requests ar where ar.tenant_id = v_tenant
      union select o.customer_id from suqa.orders o where o.tenant_id = v_tenant and o.customer_id is not null
    ), hits as (
      select u.id, p.full_name, u.phone, u.email,
             exists (select 1 from suqa.shop_members m where m.shop_id = p_shop and m.user_id = u.id and m.active) as is_member,
             (select string_agg(s.name->>'ar', '، ') from suqa.shop_members m join suqa.shops s on s.id = m.shop_id where m.user_id = u.id and m.active and s.tenant_id = v_tenant) as works_at
        from people pe join auth.users u on u.id = pe.user_id left join suqa.profiles p on p.id = u.id
       where lower(coalesce(p.full_name, '')) like '%' || v_q || '%'
          or (length(v_digits) >= 3 and suqa._digits(coalesce(u.phone, '')) like '%' || v_digits || '%')
       order by is_member, p.full_name limit 10)
    select coalesce(jsonb_agg(to_jsonb(h)), '[]') from hits h
  );
end $$;
grant execute on function suqa.pos_account_search(uuid, text) to authenticated;

-- Link an existing account as a member by its id (what the picker calls). Same audit row as pos_staff_invite.
create or replace function suqa.pos_staff_add_user(p_shop uuid, p_user uuid, p_role text, p_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_role suqa.shop_role;
begin
  if suqa.pos_role(p_shop) <> 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  if p_role not in ('owner','cashier','stock') then raise exception 'bad_role'; end if;
  v_role := p_role::suqa.shop_role;
  select tenant_id into v_tenant from suqa.shops where id = p_shop;
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'user_not_found'; end if;
  insert into suqa.shop_members (shop_id, user_id, role, display_name, active)
  values (p_shop, p_user, v_role, nullif(trim(p_name), ''), true)
  on conflict (shop_id, user_id) do update set role = excluded.role, display_name = coalesce(excluded.display_name, suqa.shop_members.display_name), active = true, updated_at = now();
  update suqa.access_requests set status = 'approved', role = p_role, decided_at = now(), decided_by = auth.uid() where shop_id = p_shop and user_id = p_user and status = 'pending';
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after)
  values (p_shop, v_tenant, auth.uid(), 'staff.add', 'shop_members', p_user::text, jsonb_build_object('role', p_role, 'by', 'account'));
  return jsonb_build_object('status', 'member', 'user_id', p_user);
end $$;
grant execute on function suqa.pos_staff_add_user(uuid, uuid, text, text) to authenticated;

-- Drivers already known to other shops of the same association (not yet in this shop), so a shop can pick instead of re-typing.
create or replace function suqa.pos_driver_directory(p_shop uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid;
begin
  if suqa.pos_role(p_shop) <> 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  select tenant_id into v_tenant from suqa.shops where id = p_shop;
  return (
    select coalesce(jsonb_agg(x), '[]') from (
      select distinct on (d.phone_key) d.name, d.phone, d.vehicle, d.user_id is not null as has_account,
             (select string_agg(s2.name->>'ar', '، ') from suqa.shop_drivers d2 join suqa.shops s2 on s2.id = d2.shop_id where d2.phone_key = d.phone_key and d2.tenant_id = v_tenant and d2.active) as used_by
        from suqa.shop_drivers d
       where d.tenant_id = v_tenant and d.active and d.shop_id <> p_shop
         and not exists (select 1 from suqa.shop_drivers m where m.shop_id = p_shop and m.phone_key = d.phone_key)
       order by d.phone_key, d.updated_at desc nulls last) x
  );
end $$;
grant execute on function suqa.pos_driver_directory(uuid) to authenticated;

select 'accounts installed' as result;
