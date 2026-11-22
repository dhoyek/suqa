-- 95: Yorgo on WhatsApp — a message is taken once; the gate per phone; a phone's conversation; a draft behind a link. Rolls back.
\set ON_ERROR_STOP on
begin;
\i supabase/schema/95_yorgo_whatsapp.sql
\i supabase/schema/101_yorgo_wa_recent_history.sql
do $$
declare t uuid := (select id from suqa.tenants where slug = 'batroun'); g jsonb; c1 uuid; c2 uuid; d uuid; x jsonb; n int;
        msg jsonb := '[{"role":"user","content":[{"type":"text","text":"bade khebez"}]},{"role":"assistant","content":[{"type":"text","text":"ok"}],"model":"m","input_tokens":100,"output_tokens":10,"cost_usd":0.2}]';
begin
  -- a message id is taken once
  assert suqa.wa_inbox_claim('wamid.1', t, '+96170000001', 'pn', 'text', 'bade khebez'), 'first claim';
  assert not suqa.wa_inbox_claim('wamid.1', t, '+96170000001', 'pn', 'text', 'bade khebez'), 'a retry is not taken again';
  assert not suqa.wa_inbox_claim('', t, '+96170000001', 'pn', 'text', 'x') and not suqa.wa_inbox_claim('wamid.2', t, '', 'pn', 'text', 'x'), 'empty id / phone';
  perform suqa.wa_inbox_done('wamid.1', 'yorgo'); assert (select handled_as from suqa.wa_inbox where wamid = 'wamid.1') = 'yorgo' and (select handled_at from suqa.wa_inbox where wamid = 'wamid.1') is not null, 'done';

  -- off until all three switches are on
  assert suqa.yorgo_gate_wa(t, '+96170000001')->>'reason' = 'off', 'no settings = off';
  insert into suqa.yorgo_settings (tenant_id, enabled, shopper_enabled) values (t, true, true) on conflict (tenant_id) do update set enabled = true, shopper_enabled = true, whatsapp_enabled = false;
  assert suqa.yorgo_gate_wa(t, '+96170000001')->>'reason' = 'off', 'whatsapp switch off = off';
  update suqa.yorgo_settings set whatsapp_enabled = true, cap_wa_phone_usd = 0.50, cap_global_usd = 20, rate_per_min = 3 where tenant_id = t;
  g := suqa.yorgo_gate_wa(t, '+96170000001');
  assert (g->>'ok')::boolean and (g->>'first')::boolean and g->>'conversation_id' is null, 'first time: ' || g;
  assert suqa.yorgo_gate_wa(t, '')->>'reason' = 'off', 'no phone';

  -- the phone's conversation: created, continued, refused to another phone
  c1 := suqa.yorgo_record_wa(null, t, '+96170000001', msg);
  assert (select wa_phone = '+96170000001' and user_id is null and channel = 'whatsapp' and mode = 'shopper' from suqa.yorgo_conversations where id = c1), 'conversation';
  g := suqa.yorgo_gate_wa(t, '+96170000001');
  assert (g->>'ok')::boolean and not (g->>'first')::boolean and (g->>'conversation_id')::uuid = c1, 'continues: ' || g;
  assert jsonb_array_length(suqa.yorgo_history_wa(c1, '+96170000001')) = 2 and suqa.yorgo_history_wa(c1, '+96170000001')->0->>'role' = 'assistant', 'history, newest first';
  assert jsonb_array_length(suqa.yorgo_history_wa(c1, '+96170000002')) = 0, 'another phone reads nothing';
  begin perform suqa.yorgo_record_wa(c1, t, '+96170000002', msg); raise exception 'should refuse'; exception when others then assert sqlerrm = 'conversation_mismatch', sqlerrm; end;
  assert (suqa.yorgo_gate_wa(t, '+96170000002')->>'first')::boolean, 'the other phone is new';
  -- a conversation silent for a day is not continued
  update suqa.yorgo_conversations set updated_at = now() - interval '25 hours' where id = c1;
  g := suqa.yorgo_gate_wa(t, '+96170000001'); assert g->>'conversation_id' is null and not (g->>'first')::boolean, 'after 24 h: new conversation, not a first time: ' || g;

  -- the cap per phone (0.20 spent per exchange, cap 0.50) and the rate (3 a minute)
  c2 := suqa.yorgo_record_wa(null, t, '+96170000001', msg);
  assert (suqa.yorgo_gate_wa(t, '+96170000001')->>'ok')::boolean, 'under the cap (0.40)';
  perform suqa.yorgo_record_wa(c2, t, '+96170000001', msg);
  assert suqa.yorgo_gate_wa(t, '+96170000001')->>'reason' = 'rate', 'three messages in a minute: ' || suqa.yorgo_gate_wa(t, '+96170000001');
  update suqa.yorgo_messages set created_at = now() - interval '5 minutes' where conversation_id in (c1, c2);
  assert suqa.yorgo_gate_wa(t, '+96170000001')->>'reason' = 'cap_user', 'cap per phone reached (0.60): ' || suqa.yorgo_gate_wa(t, '+96170000001');
  assert (suqa.yorgo_gate_wa(t, '+96170000002')->>'ok')::boolean, 'another phone is not capped';
  update suqa.yorgo_settings set cap_global_usd = 0.50 where tenant_id = t;
  assert suqa.yorgo_gate_wa(t, '+96170000002')->>'reason' = 'cap_global', 'global cap counts WhatsApp spending';
  assert (select count(*) from suqa.yorgo_usage where tenant_id = t and user_id is null and shop_id is null) = 1, 'usage in one row with no user';

  -- drafts
  d := suqa.yorgo_draft_save(t, c2, '+96170000001', '{"lines":[{"product_id":"x","quantity":2}],"choices":[],"not_found":["zzz"]}');
  x := suqa.yorgo_draft_get(d);
  assert x->'draft'->'lines'->0->>'quantity' = '2' and not (x->>'added')::boolean and not (x ? 'wa_phone') and not (x ? 'conversation_id'), 'draft read: ' || x;
  assert (select opened_at is not null from suqa.yorgo_drafts where id = d), 'opened';
  perform suqa.yorgo_draft_added(d); assert (suqa.yorgo_draft_get(d)->>'added')::boolean, 'added';
  assert suqa.yorgo_draft_get(gen_random_uuid()) is null, 'unknown id';
  update suqa.yorgo_drafts set expires_at = now() - interval '1 minute' where id = d;
  assert suqa.yorgo_draft_get(d) is null, 'expired';
  perform suqa.yorgo_draft_save(t, c2, '+96170000001', '{"lines":[]}');
  assert not exists (select 1 from suqa.yorgo_drafts where id = d), 'expired drafts are removed at the next save';
  begin perform suqa.yorgo_draft_save(t, c2, 'p', '[]'); raise exception 'should refuse'; exception when others then assert sqlerrm = 'bad_draft', sqlerrm; end;
end $$;

-- from the app: a signed-in customer, the shop owner and a visitor see none of it, and can only open a draft by its id
create schema if not exists t_yw; grant usage on schema t_yw to authenticated, anon;
create or replace function t_yw.try(q text) returns text language plpgsql as $$ declare n bigint; begin execute q into n; return n::text; exception when others then return 'denied'; end $$;
create or replace function t_yw.a_draft() returns uuid language sql security definer as $$ select id from suqa.yorgo_drafts where expires_at > now() limit 1 $$;
grant execute on all functions in schema t_yw to authenticated, anon;
do $$
declare r text; who text; t uuid := (select id from suqa.tenants where slug = 'batroun');
begin
  foreach who in array array['authenticated', 'anon'] loop
    execute format('set local role %I', who);
    if who = 'authenticated' then perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true); end if;
    assert t_yw.try('select count(*) from suqa.wa_inbox') in ('0', 'denied'), who || ' inbox: ' || t_yw.try('select count(*) from suqa.wa_inbox');
    assert t_yw.try('select count(*) from suqa.yorgo_drafts') in ('0', 'denied'), who || ' drafts';
    assert t_yw.try('select count(*) from suqa.yorgo_conversations where wa_phone is not null') in ('0', 'denied'), who || ' conversations';
    assert t_yw.try('select count(*) from suqa.yorgo_messages') in ('0', 'denied'), who || ' messages';
    assert t_yw.try(format('select (suqa.yorgo_gate_wa(%L, ''+96170000001'')->>''ok'')::boolean::int', t)) = 'denied', who || ' gate';
    assert t_yw.try('select jsonb_array_length(suqa.yorgo_history_wa(gen_random_uuid(), ''+96170000001''))') = 'denied', who || ' history';
    assert t_yw.try(format('select (suqa.wa_inbox_claim(''w9'', %L, ''p'', ''n'', ''text'', ''x''))::int', t)) = 'denied', who || ' claim';
    assert t_yw.try(format('select (suqa.yorgo_draft_save(%L, null, ''p'', ''{}'') is not null)::int', t)) = 'denied', who || ' save';
    assert t_yw.try(format('select (suqa.yorgo_draft_get(%L) is not null)::int', t_yw.a_draft())) = '1', who || ' opens a draft by its id';
    reset role;
  end loop;
end $$;
\echo yorgo_whatsapp OK
rollback;
