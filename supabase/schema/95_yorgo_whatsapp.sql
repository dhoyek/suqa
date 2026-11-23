-- 95: Yorgo on WhatsApp, step W1 — a customer writes an order to the market's number and gets a basket draft behind a link.
--
-- Yorgo on WhatsApp reads the public catalog only. It never looks up an account and never places an order: the phone is used for
-- the conversation, the rate limit, the monthly cap and the tag on the draft, nothing else. The draft opens in the app, where the
-- customer checks it and orders the usual way (docs/yorgo/PLAN.md, "step W1").
--
-- Changed tables: yorgo_settings (+ whatsapp_enabled, cap_wa_phone_usd), yorgo_conversations (+ wa_phone).
-- New tables:     wa_inbox (every inbound message once: Meta retries), yorgo_drafts (a basket draft behind a link, 24 hours).
-- New functions:  wa_inbox_claim / wa_inbox_done, yorgo_gate_wa, yorgo_history_wa, yorgo_record_wa, yorgo_draft_save (server only);
--                 yorgo_draft_get, yorgo_draft_added (anyone who holds the link).
-- Nothing changes for the app chat or the POS. Off until yorgo_settings.whatsapp_enabled is switched on.

-- ── settings (full table; the two new columns are added below for a database that has the table) ─────────────────────────────
create table if not exists suqa.yorgo_settings (
  tenant_id        uuid primary key references suqa.tenants(id) on delete cascade,
  enabled          boolean not null default false,                       -- master switch for the association
  shopper_enabled  boolean not null default false,                       -- the chat on the storefront (sellers are switched per shop)
  whatsapp_enabled boolean not null default false,                       -- 95: Yorgo answers on the market's WhatsApp number
  cap_global_usd   numeric(10,2) not null default 20 check (cap_global_usd >= 0),   -- per calendar month, everything together
  cap_shop_usd     numeric(10,2) not null default 5  check (cap_shop_usd  >= 0),    -- per calendar month, one shop's sellers
  cap_user_usd     numeric(10,2) not null default 0.50 check (cap_user_usd >= 0),   -- per calendar month, one shopper
  cap_wa_phone_usd numeric(10,2) not null default 2.00 check (cap_wa_phone_usd >= 0), -- 95: per calendar month, one WhatsApp phone
  rate_per_min     int not null default 6  check (rate_per_min between 1 and 60),   -- messages a person may send per minute
  history_turns    int not null default 12 check (history_turns between 2 and 40),  -- turns kept word for word; older ones are summarised
  updated_at       timestamptz not null default now(),
  updated_by       uuid
);
alter table suqa.yorgo_settings add column if not exists whatsapp_enabled boolean not null default false;
alter table suqa.yorgo_settings add column if not exists cap_wa_phone_usd numeric(10,2) not null default 2.00 check (cap_wa_phone_usd >= 0);

-- ── conversations (full table; wa_phone added below) ─────────────────────────────────────────────────────────────────────────
create table if not exists suqa.yorgo_conversations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references suqa.tenants(id) on delete cascade,
  user_id     uuid,                                                     -- the signed-in person; null on WhatsApp
  wa_phone    text,                                                     -- 95: the WhatsApp phone; null in the app and the POS
  shop_id     uuid references suqa.shops(id) on delete cascade,         -- seller mode: the shop; shopper mode: null
  mode        text not null check (mode in ('shopper','seller')),
  channel     text not null default 'app' check (channel in ('app','pos','whatsapp')),
  summary     text,                                                     -- older turns, condensed, once history_turns is passed
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table suqa.yorgo_conversations add column if not exists wa_phone text;
create index if not exists yorgo_conversations_wa on suqa.yorgo_conversations(wa_phone, updated_at desc) where wa_phone is not null;
-- RLS is unchanged: a person reads his own rows (user_id = auth.uid()). A WhatsApp conversation has no user: nobody reads it from the app.

-- ── every inbound WhatsApp message, once ─────────────────────────────────────────────────────────────────────────────────────
create table if not exists suqa.wa_inbox (
  wamid           text primary key,                                     -- Meta's message id
  tenant_id       uuid references suqa.tenants(id) on delete cascade,
  phone           text not null,
  phone_number_id text,                                                 -- our number it came in on
  kind            text not null,                                        -- text, audio, image, location, …
  body            text,
  received_at     timestamptz not null default now(),
  handled_at      timestamptz,
  handled_as      text,                                                 -- order_message | location | driver_ack | yorgo | unsupported | silent | off | paused | error
  error           text
);
create index if not exists wa_inbox_pending on suqa.wa_inbox(received_at) where handled_at is null;
create index if not exists wa_inbox_phone on suqa.wa_inbox(phone, received_at desc);
alter table suqa.wa_inbox enable row level security;                    -- no policy: the server only
revoke all on suqa.wa_inbox from anon, authenticated;

-- ── a basket draft behind a link ─────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists suqa.yorgo_drafts (
  id              uuid primary key default gen_random_uuid(),           -- the link: not guessable
  tenant_id       uuid not null references suqa.tenants(id) on delete cascade,
  conversation_id uuid references suqa.yorgo_conversations(id) on delete set null,
  channel         text not null default 'whatsapp' check (channel in ('whatsapp')),
  wa_phone        text,
  draft           jsonb not null,                                       -- product ids, quantities, notes, options, the words not found: no prices, no names
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '24 hours',
  opened_at       timestamptz,
  added_at        timestamptz,                                          -- "add to cart" tapped
  discarded_at    timestamptz                                           -- "discard" tapped (script 102)
);
create index if not exists yorgo_drafts_expiry on suqa.yorgo_drafts(expires_at);
alter table suqa.yorgo_drafts enable row level security;                -- no policy: read only through yorgo_draft_get(id)
revoke all on suqa.yorgo_drafts from anon, authenticated;

-- ── inbox: take a message once ───────────────────────────────────────────────────────────────────────────────────────────────
-- true = this call took it (process it); false = already seen (a retry from Meta: do nothing). Old rows go after 30 days.
create or replace function suqa.wa_inbox_claim(p_wamid text, p_tenant uuid, p_phone text, p_phone_number_id text, p_kind text, p_body text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_wamid, '') = '' or coalesce(p_phone, '') = '' then return false; end if;
  insert into suqa.wa_inbox (wamid, tenant_id, phone, phone_number_id, kind, body)
  values (p_wamid, p_tenant, p_phone, p_phone_number_id, coalesce(nullif(p_kind, ''), 'unknown'), left(p_body, 4000))
  on conflict (wamid) do nothing;
  if not found then return false; end if;
  delete from suqa.wa_inbox where received_at < now() - interval '30 days';
  return true;
end $$;
create or replace function suqa.wa_inbox_done(p_wamid text, p_as text, p_error text default null) returns void
language sql security definer set search_path = public as $$
  update suqa.wa_inbox set handled_at = now(), handled_as = p_as, error = left(p_error, 300) where wamid = p_wamid
$$;

-- ── gate for a WhatsApp phone: switches, rate, caps — before a single token is spent ─────────────────────────────────────────
-- Also says which conversation continues (the phone's latest, if it moved in the last 24 hours) and whether this phone was ever
-- answered before (the first answer carries the AI notice).
create or replace function suqa.yorgo_gate_wa(p_tenant uuid, p_phone text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s suqa.yorgo_settings; v_from timestamptz; v_day date; v_tz text; v_global numeric; v_phone numeric; v_recent int; v_conv uuid; v_known boolean;
begin
  if coalesce(p_phone, '') = '' then return jsonb_build_object('ok', false, 'reason', 'off'); end if;
  select * into s from suqa.yorgo_settings where tenant_id = p_tenant;
  if not found or not s.enabled or not s.shopper_enabled or not s.whatsapp_enabled then return jsonb_build_object('ok', false, 'reason', 'off'); end if;

  select count(*) into v_recent from suqa.yorgo_messages m join suqa.yorgo_conversations c on c.id = m.conversation_id
   where c.tenant_id = p_tenant and c.wa_phone = p_phone and m.role = 'user' and m.created_at > now() - interval '1 minute';
  if v_recent >= s.rate_per_min then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;

  select coalesce(timezone, 'UTC') into v_tz from suqa.tenants where id = p_tenant;
  v_day := date_trunc('month', now() at time zone v_tz)::date; v_from := v_day::timestamp at time zone v_tz;
  select coalesce(sum(cost_usd), 0) into v_global from suqa.yorgo_usage where tenant_id = p_tenant and day >= v_day;
  if v_global >= s.cap_global_usd then return jsonb_build_object('ok', false, 'reason', 'cap_global'); end if;
  select coalesce(sum(m.cost_usd), 0) into v_phone from suqa.yorgo_messages m join suqa.yorgo_conversations c on c.id = m.conversation_id
   where c.tenant_id = p_tenant and c.wa_phone = p_phone and m.created_at >= v_from;
  if v_phone >= s.cap_wa_phone_usd then return jsonb_build_object('ok', false, 'reason', 'cap_user'); end if;

  select id into v_conv from suqa.yorgo_conversations
   where tenant_id = p_tenant and wa_phone = p_phone and channel = 'whatsapp' and updated_at > now() - interval '24 hours' order by updated_at desc limit 1;
  v_known := exists (select 1 from suqa.yorgo_conversations where tenant_id = p_tenant and wa_phone = p_phone);
  return jsonb_build_object('ok', true, 'history_turns', s.history_turns, 'conversation_id', v_conv, 'first', not v_known);
end $$;

-- the phone's own conversation, newest first (the server reads it; the app cannot)
create or replace function suqa.yorgo_history_wa(p_conversation uuid, p_phone text, p_limit int default 36) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('role', x.role, 'content', x.content) order by x.id desc), '[]'::jsonb)
    from (select m.id, m.role, m.content from suqa.yorgo_messages m join suqa.yorgo_conversations c on c.id = m.conversation_id
           where c.id = p_conversation and c.wa_phone = p_phone and c.channel = 'whatsapp' order by m.id desc limit least(greatest(coalesce(p_limit, 36), 1), 120)) x
$$;

-- stores the exchange and its cost. Creates the phone's conversation when p_conversation is null; refuses another phone's.
create or replace function suqa.yorgo_record_wa(p_conversation uuid, p_tenant uuid, p_phone text, p_messages jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := p_conversation; c suqa.yorgo_conversations;
begin
  if coalesce(p_phone, '') = '' then raise exception 'phone_required'; end if;
  if v_id is null then
    insert into suqa.yorgo_conversations (tenant_id, user_id, wa_phone, shop_id, mode, channel) values (p_tenant, null, p_phone, null, 'shopper', 'whatsapp') returning id into v_id;
  else
    select * into c from suqa.yorgo_conversations where id = v_id;
    if not found or c.tenant_id <> p_tenant or c.wa_phone is distinct from p_phone or c.channel <> 'whatsapp' then raise exception 'conversation_mismatch'; end if;
  end if;
  return suqa.yorgo_record(v_id, p_tenant, null, 'shopper', null, 'whatsapp', p_messages, null);       -- messages + the month's usage (counted with no user)
end $$;

-- ── drafts ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- saved by the server after a turn; returns the id that goes in the link. Expired drafts are removed here (no scheduled job).
create or replace function suqa.yorgo_draft_save(p_tenant uuid, p_conversation uuid, p_phone text, p_draft jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_draft is null or jsonb_typeof(p_draft) <> 'object' or pg_column_size(p_draft) > 60000 then raise exception 'bad_draft'; end if;
  delete from suqa.yorgo_drafts where expires_at < now();
  insert into suqa.yorgo_drafts (tenant_id, conversation_id, wa_phone, draft) values (p_tenant, p_conversation, p_phone, p_draft) returning id into v_id;
  return v_id;
end $$;

-- whoever holds the link: the draft itself (public items only), for 24 hours. Nothing about who asked for it.
create or replace function suqa.yorgo_draft_get(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d suqa.yorgo_drafts;
begin
  select * into d from suqa.yorgo_drafts where id = p_id and expires_at > now();
  if not found then return null; end if;
  if d.opened_at is null then update suqa.yorgo_drafts set opened_at = now() where id = p_id; end if;
  return jsonb_build_object('id', d.id, 'tenant_id', d.tenant_id, 'draft', d.draft, 'expires_at', d.expires_at, 'added', d.added_at is not null);
end $$;
create or replace function suqa.yorgo_draft_added(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update suqa.yorgo_drafts set added_at = coalesce(added_at, now()) where id = p_id and expires_at > now()
$$;

-- who may call what (the schema's default would open every function to everyone)
revoke all on function suqa.wa_inbox_claim(text, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function suqa.wa_inbox_done(text, text, text) from public, anon, authenticated;
revoke all on function suqa.yorgo_gate_wa(uuid, text) from public, anon, authenticated;
revoke all on function suqa.yorgo_history_wa(uuid, text, int) from public, anon, authenticated;
revoke all on function suqa.yorgo_record_wa(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function suqa.yorgo_draft_save(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function suqa.wa_inbox_claim(text, uuid, text, text, text, text) to service_role;
grant execute on function suqa.wa_inbox_done(text, text, text) to service_role;
grant execute on function suqa.yorgo_gate_wa(uuid, text) to service_role;
grant execute on function suqa.yorgo_history_wa(uuid, text, int) to service_role;
grant execute on function suqa.yorgo_record_wa(uuid, uuid, text, jsonb) to service_role;
grant execute on function suqa.yorgo_draft_save(uuid, uuid, text, jsonb) to service_role;
revoke all on function suqa.yorgo_draft_get(uuid) from public;
revoke all on function suqa.yorgo_draft_added(uuid) from public;
grant execute on function suqa.yorgo_draft_get(uuid) to anon, authenticated, service_role;
grant execute on function suqa.yorgo_draft_added(uuid) to anon, authenticated, service_role;
