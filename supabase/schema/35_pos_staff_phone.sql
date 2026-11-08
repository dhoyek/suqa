-- 35_pos_staff_phone.sql — owner changes an employee's login number   (2026-11-08)
-- Requires 25. Idempotent. The phone IS the login (WhatsApp code), so this moves the account to the new number:
-- auth.users.phone + suqa.profiles.phone, refused when another account already owns that number.
create or replace function suqa.pos_staff_phone(p_shop uuid, p_user uuid, p_phone text)
returns text language plpgsql security definer set search_path = public as $$
declare v_digits text := suqa._digits(p_phone); v_e164 text; v_tenant uuid; v_old text;
begin
  if suqa.pos_role(p_shop) <> 'owner' then raise exception 'not_owner' using errcode = 'insufficient_privilege'; end if;
  if not exists (select 1 from suqa.shop_members where shop_id = p_shop and user_id = p_user) then raise exception 'not_member'; end if;
  if v_digits is null or length(v_digits) < 8 then raise exception 'bad_phone'; end if;
  v_e164 := '+' || v_digits;
  if exists (select 1 from auth.users where id <> p_user and suqa._digits(phone) = v_digits) then raise exception 'phone_taken' using errcode = 'unique_violation'; end if;
  select phone into v_old from auth.users where id = p_user;
  update auth.users set phone = v_e164, phone_confirmed_at = coalesce(phone_confirmed_at, now()), updated_at = now() where id = p_user;   -- fires handle_user_phone → profiles.phone
  update suqa.profiles set phone = v_e164, updated_at = now() where id = p_user;
  select tenant_id into v_tenant from suqa.shops where id = p_shop;
  insert into suqa.audit_log (shop_id, tenant_id, user_id, action, ref_tbl, ref_id, before, after)
  values (p_shop, v_tenant, auth.uid(), 'staff.phone', 'shop_members', p_user::text, jsonb_build_object('phone', v_old), jsonb_build_object('phone', v_e164));
  return v_e164;
end $$;
revoke all on function suqa.pos_staff_phone(uuid, uuid, text) from public;
grant execute on function suqa.pos_staff_phone(uuid, uuid, text) to authenticated;

select 'pos staff phone installed' as result;
