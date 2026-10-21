-- 17_wa_conversations.sql — WhatsApp numbers per tenant/shop + message log + reply matching   (2026-10-21)
-- Numbers: the platform owns Cloud-API numbers. A number may be bound to a shop (dedicated SIM) or serve the whole
-- tenant (shared). Messages for an order go out from the shop's number when it has one, else the tenant's, else the
-- platform default (env WHATSAPP_PHONE_ID). Inbound webhooks carry the receiving phone_number_id, so replies route back.
-- Messages: every outbound message is logged with its WhatsApp id (wamid) and order, so a reply that quotes it — or
-- comes from a phone with exactly one open order — can be attached to that order and forwarded to the other party.

create table if not exists suqa.wa_numbers (
  phone_number_id text primary key,                            -- Meta phone number id
  tenant_id       uuid not null references suqa.tenants(id) on delete cascade,
  shop_id         uuid references suqa.shops(id) on delete set null,    -- null = shared tenant number
  display_phone   text not null,                               -- '+961 70 …' for humans
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);
create index if not exists wa_numbers_tenant_idx on suqa.wa_numbers(tenant_id, shop_id);
alter table suqa.wa_numbers enable row level security;
select suqa._policy('wa_numbers','wa_numbers_read','select','authenticated','suqa.is_tenant_member(tenant_id) or suqa.is_shop_member(shop_id)');
select suqa._policy('wa_numbers','wa_numbers_admin','all','authenticated','suqa.is_tenant_admin(tenant_id)','suqa.is_tenant_admin(tenant_id)');

create table if not exists suqa.wa_messages (
  wamid           text primary key,                            -- WhatsApp message id
  order_id        uuid references suqa.orders(id) on delete cascade,
  tenant_id       uuid references suqa.tenants(id) on delete cascade,
  direction       text not null check (direction in ('out','in')),
  party           text not null check (party in ('customer','shop','courier','unknown')),
  phone           text not null,                               -- counterparty number (digits only)
  phone_number_id text,                                        -- our number used
  body            text,
  status          text,                                        -- sent/delivered/read/failed (outbound)
  error           text,
  created_at      timestamptz not null default now()
);
create index if not exists wa_messages_order_idx on suqa.wa_messages(order_id, created_at);
create index if not exists wa_messages_phone_idx on suqa.wa_messages(phone, created_at desc);
alter table suqa.wa_messages enable row level security;
select suqa._policy('wa_messages','wa_messages_read','select','authenticated',
  'exists (select 1 from suqa.orders o where o.id = order_id and (o.customer_id = auth.uid() or suqa.is_shop_member(o.shop_id) or suqa.is_tenant_member(o.tenant_id)))');
-- writes: service role only (the webhook)

-- Which of our numbers should talk to this order's parties?
create or replace function suqa.wa_sender_for_order(p_order uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select n.phone_number_id from suqa.wa_numbers n join suqa.orders o on o.shop_id = n.shop_id where o.id = p_order and n.is_active limit 1),
    (select n.phone_number_id from suqa.wa_numbers n join suqa.orders o on o.tenant_id = n.tenant_id where o.id = p_order and n.shop_id is null and n.is_active limit 1))
$$;

-- Attach an inbound message to an order. Priority: the quoted outbound message's order; else the single open order
-- where the sender is the customer or the shop's WhatsApp (scoped to the receiving number's tenant when known).
create or replace function suqa.wa_match_order(p_phone text, p_context_wamid text, p_phone_number_id text)
returns table (order_id uuid, party text)
language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid; v_digits text := regexp_replace(p_phone, '\D', '', 'g');
begin
  if p_context_wamid is not null then
    return query select m.order_id, m.party from suqa.wa_messages m where m.wamid = p_context_wamid and m.order_id is not null;
    if found then return; end if;
  end if;
  select tenant_id into v_tenant from suqa.wa_numbers where phone_number_id = p_phone_number_id;
  return query
    with open_orders as (
      select o.id, case when regexp_replace(o.customer_phone, '\D', '', 'g') = v_digits then 'customer'
                        when regexp_replace(coalesce(s.whatsapp, ''), '\D', '', 'g') = v_digits then 'shop' end as party,
             o.placed_at
        from suqa.orders o join suqa.shops s on s.id = o.shop_id
       where o.closed_at is null and (v_tenant is null or o.tenant_id = v_tenant)
         and (regexp_replace(o.customer_phone, '\D', '', 'g') = v_digits or regexp_replace(coalesce(s.whatsapp, ''), '\D', '', 'g') = v_digits))
    select id, open_orders.party from open_orders where open_orders.party is not null order by placed_at desc limit 1;
end $$;

-- include the sender number in the trigger payload
create or replace function suqa.order_event_payload(p_order suqa.orders, p_event text, p_old_status suqa.order_status)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'event',      p_event,
    'old_status', p_old_status,
    'phone_number_id', suqa.wa_sender_for_order(p_order.id),
    'order', jsonb_build_object(
      'id', p_order.id, 'number', p_order.number, 'status', p_order.status, 'tenant_id', p_order.tenant_id,
      'basket_id', p_order.basket_id, 'basket_seq', p_order.basket_seq,
      'customer_name', p_order.customer_name, 'customer_phone', p_order.customer_phone, 'customer_notes', p_order.customer_notes,
      'address', p_order.address, 'subtotal_usd', p_order.subtotal_usd, 'delivery_fee_usd', p_order.delivery_fee_usd,
      'total_usd', p_order.total_usd, 'fx_lbp_rate', p_order.fx_lbp_rate,
      'reject_reason', p_order.reject_reason, 'eta_minutes', p_order.eta_minutes, 'shop_notes', p_order.shop_notes,
      'courier_id', p_order.courier_id, 'placed_at', p_order.placed_at),
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'unit', i.unit, 'quantity', i.quantity, 'line_total_usd', i.line_total_usd, 'notes', i.notes))
                         from suqa.order_items i where i.order_id = p_order.id), '[]'::jsonb),
    'shop', (select jsonb_build_object('id', s.id, 'slug', s.slug, 'name', s.name, 'whatsapp', s.whatsapp, 'phone', s.phone)
               from suqa.shops s where s.id = p_order.shop_id),
    'tenant', (select jsonb_build_object('id', t.id, 'slug', t.slug, 'brand_name', t.brand_name, 'default_locale', t.default_locale,
                                         'display_currency', t.display_currency,
                                         'courier_enabled', coalesce((t.settings->>'courier_enabled')::boolean, false),
                                         'delivery_mode', coalesce(t.settings->>'delivery_mode', 'per_shop'))
                 from suqa.tenants t where t.id = p_order.tenant_id),
    'courier_phone', (select p.phone from suqa.profiles p where p.id = p_order.courier_id),
    'couriers', coalesce((select jsonb_agg(p.phone) from suqa.couriers c join suqa.profiles p on p.id = c.user_id
                           where c.tenant_id = p_order.tenant_id and c.is_active and p.phone is not null), '[]'::jsonb)
  )
$$;

-- order_events: allow the 'note' events from WhatsApp to show who said what
-- (actor_kind 'customer'/'shop' with a note; inserted by the service role, no policy change needed)

select 'wa conversations installed' as result;
