-- 36_known_address.sql — checkout prefill for returning WhatsApp customers   (2026-11-08)
-- A customer who ordered by phone/WhatsApp before has an address in the shop's book (shop_customers.addresses) but no
-- online address yet. On their first web checkout we suggest that address so they only confirm it.
create or replace function suqa.my_known_address(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select a.addr
    from suqa.profiles pr
    join suqa.shop_customers c on c.tenant_id = p_tenant and c.phone_key = suqa._phone_key(pr.phone)
    cross join lateral (
      select x.addr from jsonb_array_elements(case when jsonb_typeof(c.addresses) = 'array' then c.addresses else '[]'::jsonb end) as x(addr)
      union all select c.address
    ) a
   where pr.id = auth.uid() and pr.phone is not null
     and (nullif(a.addr->>'line1', '') is not null or a.addr->>'lat' is not null)
   order by a.addr->>'last_used_at' desc nulls last, c.last_order_at desc nulls last
   limit 1;
$$;
revoke all on function suqa.my_known_address(uuid) from public;
grant execute on function suqa.my_known_address(uuid) to authenticated;

select 'known address installed' as result;
