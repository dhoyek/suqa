-- 106 — the item photo tools do not need Yorgo switched on for the shop (Dan, 24 Nov 2026).
--   "Fill from a photo" and "Remove background" in the POS item editor asked suqa.yorgo_gate in seller mode, which also
--   requires the shop's own Yorgo switch (yorgo_shops.enabled). A shop where the assistant was never switched on
--   (Najem Market on prod) got "not available right now" for a tool that is not the assistant.
--   suqa.yorgo_gate_tools(tenant, user, shop) is the gate of those tools: everything yorgo_gate checks EXCEPT the shop's
--   assistant switch —
--     * the association's Yorgo master switch (yorgo_settings.enabled): off = off for the tools too;
--     * the shop is one of this association's;
--     * the per-minute rate of the person;
--     * the association's monthly cap, and the SHOP's monthly cap (its own yorgo_shops.cap_usd when set, else the default).
--   The cost is still recorded on the shop's usage (yorgo_record, seller mode), so assistant and tools share one shop cap.
--   yorgo_gate itself is not changed: the assistant in the till still needs the shop's switch.
-- No table is changed. Idempotent.

create or replace function suqa.yorgo_gate_tools(p_tenant uuid, p_user uuid, p_shop uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s suqa.yorgo_settings; v_cap numeric; v_from date; v_global numeric; v_shop numeric; v_recent int; v_tz text;
begin
  select * into s from suqa.yorgo_settings where tenant_id = p_tenant;
  if not found or not s.enabled then return jsonb_build_object('ok', false, 'reason', 'off'); end if;
  if p_shop is null or not exists (select 1 from suqa.shops where id = p_shop and tenant_id = p_tenant) then
    return jsonb_build_object('ok', false, 'reason', 'off');
  end if;

  select count(*) into v_recent from suqa.yorgo_messages m join suqa.yorgo_conversations c on c.id = m.conversation_id
   where c.user_id = p_user and m.role = 'user' and m.created_at > now() - interval '1 minute';
  if v_recent >= s.rate_per_min then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;

  select coalesce(timezone, 'UTC') into v_tz from suqa.tenants where id = p_tenant;
  v_from := date_trunc('month', now() at time zone v_tz)::date;
  select coalesce(sum(cost_usd), 0) into v_global from suqa.yorgo_usage where tenant_id = p_tenant and day >= v_from;
  if v_global >= s.cap_global_usd then return jsonb_build_object('ok', false, 'reason', 'cap_global'); end if;
  select coalesce((select cap_usd from suqa.yorgo_shops where shop_id = p_shop and tenant_id = p_tenant), s.cap_shop_usd) into v_cap;
  select coalesce(sum(cost_usd), 0) into v_shop from suqa.yorgo_usage where tenant_id = p_tenant and shop_id = p_shop and day >= v_from;
  if v_shop >= v_cap then return jsonb_build_object('ok', false, 'reason', 'cap_shop'); end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function suqa.yorgo_gate_tools(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function suqa.yorgo_gate_tools(uuid, uuid, uuid) to service_role;

select 'yorgo gate for tools installed' as result;
