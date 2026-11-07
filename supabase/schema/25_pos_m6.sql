-- 25_pos_m6.sql — POS M6: staff invites by phone, staff admin, period reports, per-shop export   (2026-11-07)
-- Requires 21–24. Idempotent. Base files 04 (staff_invites) and 07 (handle_new_user) carry the full scripts.

-- ---------- staff invites ------------------------------------------------------------------------------------
-- An owner adds staff by WhatsApp number. If that number already has an account the membership is created at
-- once; otherwise the invite waits and is claimed automatically on the person's first sign-in (phone OTP).
create table if not exists suqa.staff_invites (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references suqa.shops(id) on delete cascade,
  tenant_id    uuid not null,
  phone        text not null,                                  -- digits only, E.164 without '+'
  display_name text,
  role         suqa.shop_role not null default 'cashier',
  invited_by   uuid,
  created_at   timestamptz not null default now(),
  claimed_at   timestamptz,
  claimed_by   uuid
);
create index if not exists staff_invites_phone_idx on suqa.staff_invites(phone) where claimed_at is null;
alter table suqa.staff_invites enable row level security;
select suqa._policy('staff_invites','si_owner','all','authenticated',
  'suqa.is_shop_owner(shop_id) or suqa.is_tenant_member(tenant_id)',
  'suqa.is_shop_owner(shop_id) or suqa.is_tenant_member(tenant_id)');
grant select, insert, update, delete on suqa.staff_invites to authenticated;

create or replace function suqa._digits(p text) returns text language sql immutable as $$
  select regexp_replace(coalesce(p, ''), '\D', '', 'g')
$$;

-- Owner / tenant admin / platform admin: add or update a staff member by phone.
create or replace function suqa.pos_staff_invite(p_shop uuid, p_phone text, p_name text, p_role text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_phone text := suqa._digits(p_phone); v_user uuid; v_tenant uuid; v_role suqa.shop_role;
begin
  if suqa.pos_role(p_shop) <> 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  if length(v_phone) < 8 then raise exception 'bad_phone'; end if;
  if p_role not in ('owner','cashier','stock') then raise exception 'bad_role'; end if;
  v_role := p_role::suqa.shop_role;
  select tenant_id into v_tenant from suqa.shops where id = p_shop;
  select id into v_user from auth.users where suqa._digits(phone) = v_phone limit 1;
  if v_user is not null then
    insert into suqa.shop_members (shop_id, user_id, role, display_name, active)
    values (p_shop, v_user, v_role, nullif(trim(p_name), ''), true)
    on conflict (shop_id, user_id) do update set role = excluded.role, display_name = coalesce(excluded.display_name, suqa.shop_members.display_name), active = true, updated_at = now();
    insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after)
    values (p_shop, v_tenant, auth.uid(), 'staff.add', 'shop_members', v_user::text, jsonb_build_object('role', p_role, 'phone', v_phone));
    return jsonb_build_object('status', 'member', 'user_id', v_user);
  end if;
  -- no account yet: keep one open invite per shop+phone
  update suqa.staff_invites set display_name = nullif(trim(p_name), ''), role = v_role, invited_by = auth.uid()
   where shop_id = p_shop and phone = v_phone and claimed_at is null;
  if not found then
    insert into suqa.staff_invites (shop_id, tenant_id, phone, display_name, role, invited_by)
    values (p_shop, v_tenant, v_phone, nullif(trim(p_name), ''), v_role, auth.uid());
  end if;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after)
  values (p_shop, v_tenant, auth.uid(), 'staff.invite', 'staff_invites', v_phone, jsonb_build_object('role', p_role));
  return jsonb_build_object('status', 'invited', 'phone', v_phone);
end $$;
grant execute on function suqa.pos_staff_invite(uuid, text, text, text) to authenticated;

-- Owner: change role / name / active flag of a member (cannot demote or deactivate the last active owner).
create or replace function suqa.pos_staff_set(p_shop uuid, p_user uuid, p_role text default null, p_name text default null, p_active boolean default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_owners int;
begin
  if suqa.pos_role(p_shop) <> 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  if p_role is not null and p_role not in ('owner','cashier','stock') then raise exception 'bad_role'; end if;
  select tenant_id into v_tenant from suqa.shops where id = p_shop;
  select count(*) into v_owners from suqa.shop_members where shop_id = p_shop and role = 'owner' and active and user_id <> p_user;
  if v_owners = 0 and ((p_role is not null and p_role <> 'owner') or p_active = false)
     and exists (select 1 from suqa.shop_members where shop_id = p_shop and user_id = p_user and role = 'owner') then
    raise exception 'last_owner';
  end if;
  update suqa.shop_members
     set role = coalesce(p_role::suqa.shop_role, role),
         display_name = coalesce(nullif(trim(p_name), ''), display_name),
         active = coalesce(p_active, active),
         updated_at = now()
   where shop_id = p_shop and user_id = p_user;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, after)
  values (p_shop, v_tenant, auth.uid(), 'staff.set', 'shop_members', p_user::text, jsonb_strip_nulls(jsonb_build_object('role', p_role, 'name', p_name, 'active', p_active)));
end $$;
grant execute on function suqa.pos_staff_set(uuid, uuid, text, text, boolean) to authenticated;

-- Claim pending invites on first sign-in (phone OTP creates the auth user with its phone).
create or replace function suqa.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into suqa.profiles (id, home_tenant_id, full_name, phone, locale)
  values (
    new.id,
    nullif(new.raw_user_meta_data->>'tenant_id','')::uuid,
    new.raw_user_meta_data->>'full_name',
    new.phone,
    coalesce(new.raw_user_meta_data->>'locale','ar'))
  on conflict (id) do nothing;
  -- staff invites waiting for this number (21_pos / 25_pos_m6)
  if new.phone is not null then
    insert into suqa.shop_members (shop_id, user_id, role, display_name, active)
    select i.shop_id, new.id, i.role, i.display_name, true
      from suqa.staff_invites i where i.phone = suqa._digits(new.phone) and i.claimed_at is null
    on conflict (shop_id, user_id) do update set role = excluded.role, display_name = coalesce(excluded.display_name, suqa.shop_members.display_name), active = true;
    update suqa.staff_invites set claimed_at = now(), claimed_by = new.id where phone = suqa._digits(new.phone) and claimed_at is null;
  end if;
  return new;
end $$;

-- Also claim when an existing account adds/changes its phone (e.g. email user later verifies WhatsApp number).
create or replace function suqa.handle_user_phone() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.phone is not null and new.phone is distinct from old.phone then
    update suqa.profiles set phone = new.phone, updated_at = now() where id = new.id;
    insert into suqa.shop_members (shop_id, user_id, role, display_name, active)
    select i.shop_id, new.id, i.role, i.display_name, true
      from suqa.staff_invites i where i.phone = suqa._digits(new.phone) and i.claimed_at is null
    on conflict (shop_id, user_id) do update set role = excluded.role, display_name = coalesce(excluded.display_name, suqa.shop_members.display_name), active = true;
    update suqa.staff_invites set claimed_at = now(), claimed_by = new.id where phone = suqa._digits(new.phone) and claimed_at is null;
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_phone on auth.users;
create trigger on_auth_user_phone after update of phone on auth.users
  for each row execute function suqa.handle_user_phone();

-- ---------- cash on delivery settlement -------------------------------------------------------------------------
-- When a delivery order is handed over, the POS records what the customer paid (payments), who delivered it and the
-- driver's fee. The fee leaves the drawer as a cash move ('out') on the open shift, so expected cash stays right.
alter table suqa.orders
  add column if not exists courier_fee_cents int  not null default 0,                  -- paid to the driver (USD cents)
  add column if not exists courier_name     text;                                       -- shop's own driver (free text; association couriers use courier_id)

create or replace function suqa._pos_order_pay(d suqa.devices, p jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_o suqa.orders; v_l jsonb; v_status suqa.order_status;
begin
  select * into v_o from suqa.orders where id = (p->>'id')::uuid and shop_id = d.shop_id;
  if not found then raise exception 'order_not_found'; end if;
  for v_l in select * from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) loop
    insert into suqa.payments (id, order_id, shop_id, tenant_id, tender, amount, currency, reference, unpaid_name, unpaid_phone, note, at)
    values ((v_l->>'id')::uuid, v_o.id, d.shop_id, d.tenant_id, v_l->>'tender', (v_l->>'amount')::bigint, v_l->>'currency', v_l->>'reference', v_l->>'unpaid_name', v_l->>'unpaid_phone', v_l->>'note', coalesce((v_l->>'at')::timestamptz, now()))
    on conflict (id) do nothing;
  end loop;
  v_status := coalesce(p->>'status', 'delivered')::suqa.order_status;
  update suqa.orders set
    paid_usd_cents = coalesce((p->>'paid_usd_cents')::int, paid_usd_cents), paid_lbp = coalesce((p->>'paid_lbp')::bigint, paid_lbp),
    change_usd_cents = coalesce((p->>'change_usd_cents')::int, change_usd_cents), change_lbp = coalesce((p->>'change_lbp')::bigint, change_lbp),
    courier_fee_cents = coalesce((p->>'courier_fee_cents')::int, courier_fee_cents), courier_name = coalesce(nullif(p->>'courier_name', ''), courier_name),
    shift_id = coalesce(nullif(p->>'shift_id', '')::uuid, shift_id), device_id = coalesce(device_id, d.id), staff_user_id = coalesce(staff_user_id, p_user),
    status = case when status <> v_status and suqa.order_transition_allowed(status, v_status) then v_status else status end,
    delivered_at = case when v_status = 'delivered' then coalesce(delivered_at, now()) else delivered_at end,
    closed_at = case when v_status = 'delivered' then coalesce(closed_at, now()) else closed_at end
  where id = v_o.id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- reports -------------------------------------------------------------------------------------------
-- Period report for owners. Dates are shop-local (Asia/Beirut). Walk-in/WhatsApp/phone/online all included;
-- cancelled, rejected and parked orders excluded; returns netted separately.
create or replace function suqa.pos_report(p_shop uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz := (p_from::timestamp at time zone 'Asia/Beirut');
        v_to   timestamptz := ((p_to + 1)::timestamp at time zone 'Asia/Beirut');
        v_rate numeric;
begin
  if suqa.pos_role(p_shop) <> 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  select lbp_per_usd into v_rate from suqa.exchange_rates where shop_id = p_shop order by effective_at desc limit 1;
  v_rate := coalesce(v_rate, 89500);
  return (
    with o as (
      select * from suqa.orders
       where shop_id = p_shop and not parked and status not in ('cancelled','rejected')
         and placed_at >= v_from and placed_at < v_to
    ), li as (
      select i.* from suqa.order_items i join o on o.id = i.order_id where not i.voided
    ), r as (
      select * from suqa.returns where shop_id = p_shop and at >= v_from and at < v_to
    )
    select jsonb_build_object(
      'from', p_from, 'to', p_to, 'rate', v_rate,
      'totals', (select jsonb_build_object(
          'sales_count', count(*), 'total_cents', coalesce(sum(total_cents), 0),
          'items_count', (select coalesce(sum(quantity), 0) from li),
          'discount_cents', coalesce(sum(discount_cents), 0),
          'courier_fees_cents', coalesce(sum(courier_fee_cents), 0), 'delivery_fees_cents', coalesce(sum(round(delivery_fee_usd * 100)), 0),
          'cost_cents', (select coalesce(sum(round(coalesce(cost_cents, 0) * quantity)), 0) from li),
          'returns_count', (select count(*) from r),
          'returns_cents', (select coalesce(sum(refund_usd_cents + round(refund_lbp / v_rate * 100)), 0) from r))
        from o),
      'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'count', c, 'cents', s) order by d), '[]')
                   from (select (placed_at at time zone 'Asia/Beirut')::date d, count(*) c, sum(total_cents) s from o group by 1) x),
      'by_channel', (select coalesce(jsonb_object_agg(channel, jsonb_build_object('count', c, 'cents', s)), '{}')
                       from (select channel, count(*) c, sum(total_cents) s from o group by 1) x),
      'by_tender', (select coalesce(jsonb_object_agg(tender, jsonb_build_object('count', c, 'usd', u, 'lbp', l)), '{}')
                      from (select p.tender, count(*) c, sum(case when p.currency = 'usd' then p.amount else 0 end) u,
                                   sum(case when p.currency = 'lbp' then p.amount else 0 end) l
                              from suqa.payments p join o on o.id = p.order_id group by 1) x),
      'by_item', (select coalesce(jsonb_agg(jsonb_build_object('product_id', product_id, 'name', name, 'qty', q, 'cents', s, 'cost_cents', c) order by s desc), '[]')
                    from (select product_id, min(name::text)::jsonb name, sum(quantity) q, sum(line_total_cents) s, sum(round(coalesce(cost_cents, 0) * quantity)) c
                            from li group by product_id order by s desc limit 100) x),
      'by_section', (select coalesce(jsonb_agg(jsonb_build_object('section', section, 'qty', q, 'cents', s) order by s desc), '[]')
                       from (select coalesce(p.section, '') section, sum(li.quantity) q, sum(li.line_total_cents) s
                               from li left join suqa.products p on p.id = li.product_id group by 1) x),
      'slow', (select coalesce(jsonb_agg(jsonb_build_object('product_id', p.id, 'name', p.name, 'on_hand', p.on_hand, 'cost_cents', p.cost_cents) order by p.on_hand desc), '[]')
                 from (select * from suqa.products where shop_id = p_shop and is_active and track_stock and on_hand > 0
                         and not exists (select 1 from li where li.product_id = products.id) order by on_hand desc limit 100) p),
      'stock', (select jsonb_build_object(
          'skus', count(*), 'units', coalesce(sum(on_hand), 0),
          'cost_cents', coalesce(sum(round(coalesce(cost_cents, 0) * on_hand)), 0),
          'retail_cents', coalesce(sum(round(case when price_currency = 'usd' then price_usd * 100 else price_lbp / v_rate * 100 end * on_hand)), 0),
          'low', (select count(*) from suqa.products where shop_id = p_shop and is_active and track_stock and on_hand <= min_stock))
        from suqa.products where shop_id = p_shop and is_active and track_stock),
      'unpaid', (select coalesce(jsonb_agg(jsonb_build_object('order_id', o.id, 'number', coalesce(o.number, o.local_number), 'at', p.at, 'name', p.unpaid_name, 'phone', p.unpaid_phone, 'amount', p.amount, 'currency', p.currency) order by p.at desc), '[]')
                   from suqa.payments p join suqa.orders o on o.id = p.order_id
                  where o.shop_id = p_shop and p.tender = 'unpaid' and p.at >= v_from and p.at < v_to),
      'shifts', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'opened_at', opened_at, 'closed_at', closed_at, 'device_id', device_id,
                          'expected_usd_cents', expected_usd_cents, 'counted_usd_cents', counted_usd_cents, 'diff_usd_cents', diff_usd_cents,
                          'expected_lbp', expected_lbp, 'counted_lbp', counted_lbp, 'diff_lbp', diff_lbp) order by opened_at desc), '[]')
                   from suqa.shifts where shop_id = p_shop and opened_at >= v_from and opened_at < v_to)
    )
  );
end $$;
grant execute on function suqa.pos_report(uuid, date, date) to authenticated;

-- ---------- per-shop export ------------------------------------------------------------------------------------
-- Everything the shop owns, as one JSON document (the POS turns it into CSV/Excel sheets client-side).
create or replace function suqa.pos_export(p_shop uuid, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz := coalesce((p_from::timestamp at time zone 'Asia/Beirut'), '2000-01-01');
        v_to   timestamptz := coalesce(((p_to + 1)::timestamp at time zone 'Asia/Beirut'), '2100-01-01');
begin
  if suqa.pos_role(p_shop) <> 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  return jsonb_build_object(
    'exported_at', now(), 'shop', (select to_jsonb(s) - 'printer' from suqa.shops s where id = p_shop),
    'products', (select coalesce(jsonb_agg(to_jsonb(p) order by p.section, p.sort_order), '[]') from suqa.products p where shop_id = p_shop),
    'barcodes', (select coalesce(jsonb_agg(to_jsonb(b)), '[]') from suqa.product_barcodes b where shop_id = p_shop),
    'orders', (select coalesce(jsonb_agg(to_jsonb(o) order by o.placed_at), '[]') from suqa.orders o where shop_id = p_shop and placed_at >= v_from and placed_at < v_to),
    'order_items', (select coalesce(jsonb_agg(to_jsonb(i)), '[]') from suqa.order_items i join suqa.orders o on o.id = i.order_id where o.shop_id = p_shop and o.placed_at >= v_from and o.placed_at < v_to),
    'payments', (select coalesce(jsonb_agg(to_jsonb(p)), '[]') from suqa.payments p where shop_id = p_shop and at >= v_from and at < v_to),
    'stock_moves', (select coalesce(jsonb_agg(to_jsonb(m) order by m.at), '[]') from suqa.stock_moves m where shop_id = p_shop and at >= v_from and at < v_to),
    'shifts', (select coalesce(jsonb_agg(to_jsonb(s) order by s.opened_at), '[]') from suqa.shifts s where shop_id = p_shop and opened_at >= v_from and opened_at < v_to),
    'cash_moves', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from suqa.cash_moves c join suqa.shifts s on s.id = c.shift_id where s.shop_id = p_shop and c.at >= v_from and c.at < v_to),
    'returns', (select coalesce(jsonb_agg(to_jsonb(r)), '[]') from suqa.returns r where shop_id = p_shop and at >= v_from and at < v_to),
    'return_lines', (select coalesce(jsonb_agg(to_jsonb(l)), '[]') from suqa.return_lines l join suqa.returns r on r.id = l.return_id where r.shop_id = p_shop and r.at >= v_from and r.at < v_to),
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role, 'display_name', m.display_name, 'full_name', p.full_name, 'phone', p.phone, 'active', m.active)), '[]')
                from suqa.shop_members m left join suqa.profiles p on p.id = m.user_id where m.shop_id = p_shop),
    'devices', (select coalesce(jsonb_agg(to_jsonb(d)), '[]') from suqa.devices d where shop_id = p_shop),
    'audit_log', (select coalesce(jsonb_agg(to_jsonb(a) order by a.at), '[]') from suqa.audit_log a where shop_id = p_shop and at >= v_from and at < v_to)
  );
end $$;
grant execute on function suqa.pos_export(uuid, date, date) to authenticated;

-- Staff with phone for the Settings → staff list (owners only; cashiers see names via the sync mirror).
create or replace function suqa.pos_staff_list(p_shop uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if suqa.pos_role(p_shop) <> 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  return jsonb_build_object(
    'members', (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role, 'display_name', m.display_name, 'full_name', p.full_name,
                         'phone', p.phone, 'active', m.active, 'pin', m.pin_hash is not null) order by m.role, m.created_at), '[]')
                  from suqa.shop_members m left join suqa.profiles p on p.id = m.user_id where m.shop_id = p_shop),
    'invites', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'phone', phone, 'display_name', display_name, 'role', role, 'created_at', created_at) order by created_at desc), '[]')
                  from suqa.staff_invites where shop_id = p_shop and claimed_at is null));
end $$;
grant execute on function suqa.pos_staff_list(uuid) to authenticated;

-- ---------- which shops can I open the POS for? ------------------------------------------------------------
-- Memberships (active only) plus, for platform admins and tenant members, every POS-enabled shop they administer.
create or replace function suqa.pos_my_shops()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('shop_id', x.id, 'role', x.r,
           'shop', jsonb_build_object('id', x.id, 'name', s.name, 'pos_enabled', s.pos_enabled, 'tenant_id', s.tenant_id, 'slug', s.slug)) order by s.sort_order), '[]')
    from (
      select m.shop_id id, case when m.role::text = 'staff' then 'cashier' else m.role::text end r
        from suqa.shop_members m where m.user_id = auth.uid() and m.active
      union
      select s.id, 'owner' from suqa.shops s
       where s.pos_enabled and (suqa.is_platform_admin() or suqa.is_tenant_member(s.tenant_id))
         and not exists (select 1 from suqa.shop_members m where m.shop_id = s.id and m.user_id = auth.uid())
    ) x join suqa.shops s on s.id = x.id
$$;
grant execute on function suqa.pos_my_shops() to authenticated;

select 'pos m6 installed' as result;
