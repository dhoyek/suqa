-- 50_pos_account_addresses.sql — POS customer dialog: when the phone belongs to a registered customer account in this
-- association, show that account's own saved addresses as suggestions (read-only). Nothing is written to the account.
-- Shop members of p_shop only; matches auth.users.phone or profiles.phone by suqa._phone_key. Requires 05, 21, 28.

create or replace function suqa.pos_account_addresses(p_shop uuid, p_phone text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid; v_key text := suqa._phone_key(p_phone); v_user uuid;
begin
  if suqa.pos_role(p_shop) is null then raise exception 'not_a_member' using errcode = 'insufficient_privilege'; end if;
  if v_key is null or length(v_key) < 6 then return '[]'::jsonb; end if;
  select tenant_id into v_tenant from suqa.shops where id = p_shop;
  select u.id into v_user
    from auth.users u left join suqa.profiles p on p.id = u.id
   where (suqa._phone_key(u.phone) = v_key or suqa._phone_key(p.phone) = v_key)
     and (u.banned_until is null or u.banned_until < now())
   order by u.created_at limit 1;
  if v_user is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', 'acct-' || a.id, 'label', a.label, 'line1', concat_ws(', ', nullif(a.line1, ''), nullif(a.line2, '')), 'notes', a.notes,
      'lat', st_y(a.location::geometry), 'lng', st_x(a.location::geometry), 'is_default', a.is_default) order by a.is_default desc, a.updated_at desc)
    from suqa.addresses a where a.user_id = v_user and a.tenant_id = v_tenant), '[]'::jsonb);
end $$;
grant execute on function suqa.pos_account_addresses(uuid, text) to authenticated;

select 'account addresses installed' as result;
