-- 41_access_requests.sql — "I work here, let me in": a signed-in user who is not a member of any POS shop can ask the
-- shop owner for access from the POS entry screen; the owner approves (→ shop_members, synced to every device) or
-- rejects from the POS staff panel. Requires: 25_pos_m6 (pos_staff_set, pos_my_shops), 21_pos.

create table if not exists suqa.access_requests (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references suqa.tenants(id) on delete cascade,
  shop_id     uuid not null references suqa.shops(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text,                                   -- what the requester typed (defaults to profile name)
  phone       text,                                   -- profile phone at request time (digits, no +)
  note        text,
  status      text not null default 'pending' check (status in ('pending','approved','rejected')),
  role        text,                                   -- role granted on approval
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  uuid references auth.users(id) on delete set null
);
create unique index if not exists access_requests_pending on suqa.access_requests (shop_id, user_id) where status = 'pending';
create index if not exists access_requests_shop on suqa.access_requests (shop_id, status, created_at desc);
alter table suqa.access_requests enable row level security;
drop policy if exists access_requests_own on suqa.access_requests;
create policy access_requests_own on suqa.access_requests for select using (user_id = auth.uid());
grant select on suqa.access_requests to authenticated;

-- Shops of a tenant that a signed-in non-member may ask to join (POS-enabled ones). Nothing sensitive: id + name.
create or replace function suqa.pos_request_targets(p_tenant uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name,
           'pending', exists (select 1 from suqa.access_requests r where r.shop_id = s.id and r.user_id = auth.uid() and r.status = 'pending'),
           'rejected_at', (select max(r.decided_at) from suqa.access_requests r where r.shop_id = s.id and r.user_id = auth.uid() and r.status = 'rejected'))
           order by s.sort_order), '[]')
    from suqa.shops s where s.tenant_id = p_tenant and s.pos_enabled
$$;
grant execute on function suqa.pos_request_targets(uuid) to authenticated;

-- Requester side: one pending request per shop; re-asking after a rejection is allowed (new row).
create or replace function suqa.pos_request_access(p_shop uuid, p_name text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_shop suqa.shops; v_prof suqa.profiles; v_row suqa.access_requests;
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = 'insufficient_privilege'; end if;
  select * into v_shop from suqa.shops where id = p_shop and pos_enabled;
  if not found then raise exception 'shop_not_found'; end if;
  if exists (select 1 from suqa.shop_members m where m.shop_id = p_shop and m.user_id = auth.uid() and m.active) then
    raise exception 'already_member';
  end if;
  select * into v_prof from suqa.profiles where id = auth.uid();
  insert into suqa.access_requests (tenant_id, shop_id, user_id, name, phone, note)
  values (v_shop.tenant_id, p_shop, auth.uid(), coalesce(nullif(trim(p_name), ''), v_prof.full_name), regexp_replace(coalesce(v_prof.phone, ''), '\D', '', 'g'), nullif(trim(p_note), ''))
  on conflict (shop_id, user_id) where status = 'pending'
  do update set name = excluded.name, note = excluded.note, created_at = now()
  returning * into v_row;
  if v_prof.full_name is null and nullif(trim(p_name), '') is not null then
    update suqa.profiles set full_name = trim(p_name) where id = auth.uid();
  end if;
  return to_jsonb(v_row);
end $$;
grant execute on function suqa.pos_request_access(uuid, text, text) to authenticated;

-- Owner side: list pending requests (owners only).
create or replace function suqa.pos_access_requests(p_shop uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if suqa.pos_role(p_shop) <> 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at), '[]') from suqa.access_requests r where r.shop_id = p_shop and r.status = 'pending');
end $$;
grant execute on function suqa.pos_access_requests(uuid) to authenticated;

-- Owner decides. Approve = add (or re-activate) the member with the chosen role; the shop_members trigger puts the
-- row on the sync feed so every device sees the new staff tile.
create or replace function suqa.pos_access_decide(p_id uuid, p_approve boolean, p_role text default 'cashier')
returns void language plpgsql security definer set search_path = public as $$
declare v_req suqa.access_requests;
begin
  select * into v_req from suqa.access_requests where id = p_id and status = 'pending';
  if not found then raise exception 'request_not_found'; end if;
  if suqa.pos_role(v_req.shop_id) <> 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  if p_approve then
    if p_role not in ('owner','cashier','stock') then raise exception 'bad_role'; end if;
    insert into suqa.shop_members (shop_id, user_id, role, display_name, active)
    values (v_req.shop_id, v_req.user_id, p_role::suqa.shop_role, v_req.name, true)
    on conflict (shop_id, user_id) do update set role = excluded.role, active = true, display_name = coalesce(suqa.shop_members.display_name, excluded.display_name);
  end if;
  update suqa.access_requests set status = case when p_approve then 'approved' else 'rejected' end, role = case when p_approve then p_role end,
         decided_at = now(), decided_by = auth.uid() where id = p_id;
end $$;
grant execute on function suqa.pos_access_decide(uuid, boolean, text) to authenticated;

select 'access requests installed' as result;
