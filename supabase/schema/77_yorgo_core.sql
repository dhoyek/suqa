-- 77 — Yorgo assistant, core (docs/yorgo/PLAN.md, step A): switches, caps, conversations, metering.
--   Nothing here calls a model: these are the tables and gates the server route (app/api/yorgo/chat) works through.
--
--   yorgo_settings       one row per association: master switch, shopper switch, monthly caps (USD), rate limit, history length.
--   yorgo_shops          per shop: seller assistant on/off, optional cap of its own. Only the association turns it on — it pays the bill.
--   yorgo_conversations  who talked, in which mode (shopper / seller), on which channel (app / pos / whatsapp).
--   yorgo_messages       every turn: content, model, tokens (input, output, cache read / write), cost estimate, feedback.
--   yorgo_usage          the same numbers per day × shop × user, for caps and the usage page.
--
--   Who writes: ONLY the server, through yorgo_gate / yorgo_record (service role). A person's own token could otherwise
--   under-report its usage and walk past the caps. Who reads: a person their own conversations; the association's admins the
--   usage numbers and switches — never the text of anybody's messages.
--   Shop data is never read here: tools run with the caller's own token (see lib/yorgo), these tables only hold the conversation.
-- Idempotent.

-- ---------- switches and caps ----------
create table if not exists suqa.yorgo_settings (
  tenant_id       uuid primary key references suqa.tenants(id) on delete cascade,
  enabled         boolean not null default false,                       -- master switch for the association
  shopper_enabled boolean not null default false,                       -- the chat on the storefront (sellers are switched per shop)
  cap_global_usd  numeric(10,2) not null default 20 check (cap_global_usd >= 0),   -- per calendar month, everything together
  cap_shop_usd    numeric(10,2) not null default 5  check (cap_shop_usd  >= 0),    -- per calendar month, one shop's sellers
  cap_user_usd    numeric(10,2) not null default 0.50 check (cap_user_usd >= 0),   -- per calendar month, one shopper
  rate_per_min    int not null default 6  check (rate_per_min between 1 and 60),   -- messages a person may send per minute
  history_turns   int not null default 12 check (history_turns between 2 and 40),  -- turns kept word for word; older ones are summarised
  updated_at      timestamptz not null default now(),
  updated_by      uuid
);
alter table suqa.yorgo_settings enable row level security;
drop policy if exists yorgo_settings_admin on suqa.yorgo_settings;
create policy yorgo_settings_admin on suqa.yorgo_settings for all to authenticated
  using (suqa.is_tenant_admin(tenant_id) or suqa.is_platform_admin()) with check (suqa.is_tenant_admin(tenant_id) or suqa.is_platform_admin());
revoke all on suqa.yorgo_settings from anon, authenticated;
grant select, insert, update on suqa.yorgo_settings to authenticated;

create table if not exists suqa.yorgo_shops (
  shop_id     uuid primary key references suqa.shops(id) on delete cascade,
  tenant_id   uuid not null references suqa.tenants(id) on delete cascade,
  enabled     boolean not null default false,                           -- seller assistant in this shop's point of sale
  cap_usd     numeric(10,2) check (cap_usd is null or cap_usd >= 0),     -- null = the association's cap_shop_usd
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
create index if not exists yorgo_shops_tenant on suqa.yorgo_shops(tenant_id);
alter table suqa.yorgo_shops enable row level security;
drop policy if exists yorgo_shops_read on suqa.yorgo_shops;
create policy yorgo_shops_read on suqa.yorgo_shops for select to authenticated
  using (suqa.is_tenant_admin(tenant_id) or suqa.is_platform_admin() or suqa.pos_role(shop_id) is not null);
drop policy if exists yorgo_shops_admin on suqa.yorgo_shops;
create policy yorgo_shops_admin on suqa.yorgo_shops for all to authenticated
  using (suqa.is_tenant_admin(tenant_id) or suqa.is_platform_admin()) with check (suqa.is_tenant_admin(tenant_id) or suqa.is_platform_admin());
revoke all on suqa.yorgo_shops from anon, authenticated;
grant select, insert, update on suqa.yorgo_shops to authenticated;

-- ---------- conversations ----------
create table if not exists suqa.yorgo_conversations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references suqa.tenants(id) on delete cascade,
  user_id     uuid,                                                     -- the signed-in person; null for a WhatsApp guest (later)
  shop_id     uuid references suqa.shops(id) on delete cascade,         -- seller mode: the shop; shopper mode: null
  mode        text not null check (mode in ('shopper','seller')),
  channel     text not null default 'app' check (channel in ('app','pos','whatsapp')),
  summary     text,                                                     -- older turns, condensed, once history_turns is passed
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists yorgo_conversations_user on suqa.yorgo_conversations(user_id, updated_at desc);
create index if not exists yorgo_conversations_shop on suqa.yorgo_conversations(shop_id, updated_at desc);
alter table suqa.yorgo_conversations enable row level security;
drop policy if exists yorgo_conversations_own on suqa.yorgo_conversations;
create policy yorgo_conversations_own on suqa.yorgo_conversations for select to authenticated using (user_id = auth.uid());
revoke all on suqa.yorgo_conversations from anon, authenticated;
grant select on suqa.yorgo_conversations to authenticated;

create table if not exists suqa.yorgo_messages (
  id                  bigserial primary key,
  conversation_id     uuid not null references suqa.yorgo_conversations(id) on delete cascade,
  tenant_id           uuid not null,
  role                text not null check (role in ('user','assistant','tool')),
  content             jsonb not null,                                   -- the turn as sent to / received from the model (text, tool calls, tool results)
  model               text,                                             -- assistant turns: which model answered
  input_tokens        int not null default 0,
  output_tokens       int not null default 0,
  cache_read_tokens   int not null default 0,
  cache_write_tokens  int not null default 0,
  cost_usd            numeric(12,6) not null default 0,                 -- estimate from the price list in the app's configuration
  feedback            smallint check (feedback in (-1, 1)),             -- 👎 / 👍 from the person
  feedback_note       text check (feedback_note is null or char_length(feedback_note) <= 500),
  created_at          timestamptz not null default now()
);
create index if not exists yorgo_messages_conv on suqa.yorgo_messages(conversation_id, id);
alter table suqa.yorgo_messages enable row level security;
drop policy if exists yorgo_messages_own on suqa.yorgo_messages;
create policy yorgo_messages_own on suqa.yorgo_messages for select to authenticated
  using (exists (select 1 from suqa.yorgo_conversations c where c.id = conversation_id and c.user_id = auth.uid()));
revoke all on suqa.yorgo_messages from anon, authenticated;
grant select on suqa.yorgo_messages to authenticated;

-- ---------- usage ----------
create table if not exists suqa.yorgo_usage (
  tenant_id           uuid not null references suqa.tenants(id) on delete cascade,
  day                 date not null,                                    -- in the association's time zone
  shop_id             uuid,                                             -- seller turns: the shop; shopper turns: null
  user_id             uuid,
  messages            int    not null default 0,                        -- messages the person sent
  model_calls         int    not null default 0,
  input_tokens        bigint not null default 0,
  output_tokens       bigint not null default 0,
  cache_read_tokens   bigint not null default 0,
  cache_write_tokens  bigint not null default 0,
  cost_usd            numeric(12,6) not null default 0
);
create unique index if not exists yorgo_usage_key on suqa.yorgo_usage
  (tenant_id, day, coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists yorgo_usage_shop on suqa.yorgo_usage(shop_id, day);
create index if not exists yorgo_usage_user on suqa.yorgo_usage(user_id, day);
alter table suqa.yorgo_usage enable row level security;
drop policy if exists yorgo_usage_admin on suqa.yorgo_usage;
create policy yorgo_usage_admin on suqa.yorgo_usage for select to authenticated
  using (suqa.is_tenant_admin(tenant_id) or suqa.is_platform_admin());     -- numbers only; message text is never readable by the association
revoke all on suqa.yorgo_usage from anon, authenticated;
grant select on suqa.yorgo_usage to authenticated;

-- ---------- the gate: may this person send a message now? ----------
-- reason: off (switches) · rate (too fast) · cap_global / cap_shop / cap_user (month's budget spent). Server only.
create or replace function suqa.yorgo_gate(p_tenant uuid, p_user uuid, p_mode text, p_shop uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s suqa.yorgo_settings; sh suqa.yorgo_shops; v_from date; v_global numeric; v_shop numeric; v_user numeric; v_recent int; v_tz text;
begin
  select * into s from suqa.yorgo_settings where tenant_id = p_tenant;
  if not found or not s.enabled then return jsonb_build_object('ok', false, 'reason', 'off'); end if;
  if p_mode = 'seller' then
    if p_shop is null then return jsonb_build_object('ok', false, 'reason', 'off'); end if;
    select * into sh from suqa.yorgo_shops where shop_id = p_shop and tenant_id = p_tenant;
    if not found or not sh.enabled then return jsonb_build_object('ok', false, 'reason', 'off'); end if;
  elsif p_mode = 'shopper' then
    if not s.shopper_enabled then return jsonb_build_object('ok', false, 'reason', 'off'); end if;
  else return jsonb_build_object('ok', false, 'reason', 'off');
  end if;

  select count(*) into v_recent from suqa.yorgo_messages m join suqa.yorgo_conversations c on c.id = m.conversation_id
   where c.user_id = p_user and m.role = 'user' and m.created_at > now() - interval '1 minute';
  if v_recent >= s.rate_per_min then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;

  select coalesce(timezone, 'UTC') into v_tz from suqa.tenants where id = p_tenant;
  v_from := date_trunc('month', now() at time zone v_tz)::date;
  select coalesce(sum(cost_usd), 0) into v_global from suqa.yorgo_usage where tenant_id = p_tenant and day >= v_from;
  if v_global >= s.cap_global_usd then return jsonb_build_object('ok', false, 'reason', 'cap_global'); end if;
  if p_mode = 'seller' then
    select coalesce(sum(cost_usd), 0) into v_shop from suqa.yorgo_usage where tenant_id = p_tenant and shop_id = p_shop and day >= v_from;
    if v_shop >= coalesce(sh.cap_usd, s.cap_shop_usd) then return jsonb_build_object('ok', false, 'reason', 'cap_shop'); end if;
  else
    select coalesce(sum(cost_usd), 0) into v_user from suqa.yorgo_usage where tenant_id = p_tenant and user_id = p_user and shop_id is null and day >= v_from;
    if v_user >= s.cap_user_usd then return jsonb_build_object('ok', false, 'reason', 'cap_user'); end if;
  end if;
  return jsonb_build_object('ok', true, 'history_turns', s.history_turns);
end $$;
revoke all on function suqa.yorgo_gate(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function suqa.yorgo_gate(uuid, uuid, text, uuid) to service_role;

-- ---------- record a finished exchange ----------
-- p_messages: [{role, content, model?, input_tokens?, output_tokens?, cache_read_tokens?, cache_write_tokens?, cost_usd?}, …] in order.
-- Creates the conversation when p_conversation is null; refuses one that belongs to somebody else. Returns the conversation id. Server only.
create or replace function suqa.yorgo_record(p_conversation uuid, p_tenant uuid, p_user uuid, p_mode text, p_shop uuid, p_channel text, p_messages jsonb, p_summary text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid := p_conversation; c suqa.yorgo_conversations; m jsonb; v_tz text; v_day date;
        v_msgs int := 0; v_calls int := 0; v_in bigint := 0; v_out bigint := 0; v_cr bigint := 0; v_cw bigint := 0; v_cost numeric := 0;
begin
  if v_id is null then
    insert into suqa.yorgo_conversations (tenant_id, user_id, shop_id, mode, channel)
    values (p_tenant, p_user, case when p_mode = 'seller' then p_shop end, p_mode, coalesce(p_channel, 'app')) returning id into v_id;
  else
    select * into c from suqa.yorgo_conversations where id = v_id for update;
    if not found or c.tenant_id <> p_tenant or c.user_id is distinct from p_user or c.mode <> p_mode
       or (p_mode = 'seller' and c.shop_id is distinct from p_shop) then raise exception 'conversation_mismatch'; end if;
  end if;
  for m in select * from jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) loop
    insert into suqa.yorgo_messages (conversation_id, tenant_id, role, content, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
    values (v_id, p_tenant, m->>'role', coalesce(m->'content', '[]'::jsonb), m->>'model',
            coalesce((m->>'input_tokens')::int, 0), coalesce((m->>'output_tokens')::int, 0), coalesce((m->>'cache_read_tokens')::int, 0),
            coalesce((m->>'cache_write_tokens')::int, 0), coalesce((m->>'cost_usd')::numeric, 0));
    if m->>'role' = 'user' then v_msgs := v_msgs + 1; end if;
    if m->>'role' = 'assistant' then v_calls := v_calls + 1; end if;
    v_in := v_in + coalesce((m->>'input_tokens')::int, 0); v_out := v_out + coalesce((m->>'output_tokens')::int, 0);
    v_cr := v_cr + coalesce((m->>'cache_read_tokens')::int, 0); v_cw := v_cw + coalesce((m->>'cache_write_tokens')::int, 0);
    v_cost := v_cost + coalesce((m->>'cost_usd')::numeric, 0);
  end loop;
  update suqa.yorgo_conversations set updated_at = now(), summary = coalesce(p_summary, summary) where id = v_id;

  select coalesce(timezone, 'UTC') into v_tz from suqa.tenants where id = p_tenant;
  v_day := (now() at time zone v_tz)::date;
  insert into suqa.yorgo_usage as u (tenant_id, day, shop_id, user_id, messages, model_calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
  values (p_tenant, v_day, case when p_mode = 'seller' then p_shop end, p_user, v_msgs, v_calls, v_in, v_out, v_cr, v_cw, v_cost)
  on conflict (tenant_id, day, coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set messages = u.messages + excluded.messages, model_calls = u.model_calls + excluded.model_calls, input_tokens = u.input_tokens + excluded.input_tokens,
    output_tokens = u.output_tokens + excluded.output_tokens, cache_read_tokens = u.cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = u.cache_write_tokens + excluded.cache_write_tokens, cost_usd = u.cost_usd + excluded.cost_usd;
  return v_id;
end $$;
revoke all on function suqa.yorgo_record(uuid, uuid, uuid, text, uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function suqa.yorgo_record(uuid, uuid, uuid, text, uuid, text, jsonb, text) to service_role;

-- ---------- 👍 / 👎 on an answer (the person's own conversation only) ----------
create or replace function suqa.yorgo_feedback(p_message bigint, p_value smallint, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if p_value is not null and p_value not in (-1, 1) then raise exception 'bad_value'; end if;
  update suqa.yorgo_messages m set feedback = p_value, feedback_note = nullif(left(btrim(coalesce(p_note, '')), 500), '')
   where m.id = p_message and m.role = 'assistant'
     and exists (select 1 from suqa.yorgo_conversations c where c.id = m.conversation_id and c.user_id = auth.uid());
  if not found then raise exception 'not_found'; end if;
end $$;
revoke all on function suqa.yorgo_feedback(bigint, smallint, text) from public, anon;
grant execute on function suqa.yorgo_feedback(bigint, smallint, text) to authenticated;

select 'yorgo core installed (everything off until an association turns it on)' as result;
