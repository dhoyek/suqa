-- 55_pos_approval_pin.sql — a separate APPROVAL PIN per shop ("رمز الموافقة").   (2026-11-12)
-- Until now every gated action at the till (discount over the limit, price change, return, order delete, stock adjustment,
-- undo of a debt collection …) asked for the OWNER'S LOGIN PIN. Typed in front of a cashier once, it opens the owner's tile
-- (reports, profit, settings). The approval PIN only approves: it cannot unlock any tile.
--   * same style as the login PIN: 4 digits, hashed on the device (PBKDF2-SHA256, 100k, random salt); the server never sees
--     the PIN and it can never be displayed — only replaced or removed.
--   * set / replace / remove: shop owner only (pos_set_approval_pin). Audit: approval_pin.set / approval_pin.clear.
--   * read (hash + salt, for checking at the till while offline): members of the shop only (pos_approval_pin).
--   * while a shop has no approval PIN, approvals keep working with the owner's login PIN exactly as before.
-- Kept in its own table, NOT on suqa.shops: shop rows are publicly readable (storefront), a 4-digit hash must not be.
-- No policies on purpose — the table is reachable only through the two functions below. Requires 21. Idempotent.

create table if not exists suqa.shop_approval_pins (
  shop_id   uuid primary key references suqa.shops(id) on delete cascade,
  pin_hash  text not null,
  pin_salt  text not null,
  set_at    timestamptz not null default now(),
  set_by    uuid references auth.users(id) on delete set null
);
alter table suqa.shop_approval_pins enable row level security;
revoke all on table suqa.shop_approval_pins from public, anon, authenticated;

-- owner sets / replaces it (p_hash + p_salt) or removes it (both null)
create or replace function suqa.pos_set_approval_pin(p_shop uuid, p_hash text default null, p_salt text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_clear boolean := (p_hash is null or p_hash = '');
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = 'insufficient_privilege'; end if;
  if suqa.pos_role(p_shop) is distinct from 'owner' then raise exception 'owner_only' using errcode = 'insufficient_privilege'; end if;
  select tenant_id into v_tenant from suqa.shops where id = p_shop;
  if v_tenant is null then raise exception 'shop_not_found'; end if;
  if v_clear then
    delete from suqa.shop_approval_pins where shop_id = p_shop;
  else
    if coalesce(p_salt, '') = '' or length(p_hash) < 20 then raise exception 'bad_pin'; end if;
    insert into suqa.shop_approval_pins (shop_id, pin_hash, pin_salt, set_at, set_by)
    values (p_shop, p_hash, p_salt, now(), auth.uid())
    on conflict (shop_id) do update set pin_hash = excluded.pin_hash, pin_salt = excluded.pin_salt, set_at = now(), set_by = auth.uid();
  end if;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id)
  values (p_shop, v_tenant, auth.uid(), case when v_clear then 'approval_pin.clear' else 'approval_pin.set' end, 'shop_approval_pins', p_shop::text);
  return jsonb_build_object('ok', true, 'set', not v_clear, 'set_at', case when v_clear then null else now() end);
end $$;

-- the till reads it to check an approval locally (also offline, from its cached copy). null = no approval PIN → owner PIN approves.
create or replace function suqa.pos_approval_pin(p_shop uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r suqa.shop_approval_pins;
begin
  if suqa.pos_role(p_shop) is null then raise exception 'not_a_member' using errcode = 'insufficient_privilege'; end if;
  select * into r from suqa.shop_approval_pins where shop_id = p_shop;
  if not found then return null; end if;
  return jsonb_build_object('hash', r.pin_hash, 'salt', r.pin_salt, 'set_at', r.set_at);
end $$;

revoke all on function suqa.pos_set_approval_pin(uuid, text, text) from public, anon;
revoke all on function suqa.pos_approval_pin(uuid) from public, anon;
grant execute on function suqa.pos_set_approval_pin(uuid, text, text) to authenticated;
grant execute on function suqa.pos_approval_pin(uuid) to authenticated;

select 'approval pin installed' as result;
