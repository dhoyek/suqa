-- Yorgo core (77): switches, caps, rate limit, metering, and who can read what. Run after smoke.sql:
--   psql -v ON_ERROR_STOP=1 -f supabase/test/yorgo_core.sql        (one transaction, rolled back)
begin;
insert into suqa.tenants (id, slug, name, brand_name) values ('7e570000-0000-4000-8000-000000000002', 'yorgo-core', '{"en":"T"}', 'T');
insert into suqa.shops (id, tenant_id, slug, name, status) values
  ('7e570000-0000-4000-8000-0000000000c1', '7e570000-0000-4000-8000-000000000002', 'one', '{"en":"One"}', 'active'),
  ('7e570000-0000-4000-8000-0000000000c2', '7e570000-0000-4000-8000-000000000002', 'two', '{"en":"Two"}', 'active');
insert into auth.users (id) values ('7e570000-0000-4000-8000-0000000a0001'), ('7e570000-0000-4000-8000-0000000a0002'), ('7e570000-0000-4000-8000-0000000a0003'), ('7e570000-0000-4000-8000-0000000a0004');
insert into suqa.shop_members (shop_id, user_id, role) values ('7e570000-0000-4000-8000-0000000000c1', '7e570000-0000-4000-8000-0000000a0001', 'owner');   -- seller
insert into suqa.tenant_members (tenant_id, user_id, role) values ('7e570000-0000-4000-8000-000000000002', '7e570000-0000-4000-8000-0000000a0003', 'admin');  -- association admin
-- …a0002 is a shopper, …a0004 a stranger

do $$
declare T uuid := '7e570000-0000-4000-8000-000000000002'; S1 uuid := '7e570000-0000-4000-8000-0000000000c1'; S2 uuid := '7e570000-0000-4000-8000-0000000000c2';
        seller uuid := '7e570000-0000-4000-8000-0000000a0001'; shopper uuid := '7e570000-0000-4000-8000-0000000a0002'; adm uuid := '7e570000-0000-4000-8000-0000000a0003'; other uuid := '7e570000-0000-4000-8000-0000000a0004';
        g jsonb; c1 uuid; c2 uuid; n int; v numeric;
        turn jsonb := '[{"role":"user","content":[{"type":"text","text":"2 man2ouche"}]},
                        {"role":"assistant","content":[{"type":"text","text":"ok"}],"model":"claude-haiku-5-5","input_tokens":1200,"output_tokens":80,"cache_read_tokens":900,"cache_write_tokens":0,"cost_usd":0.4}]';
begin
  -- off by default, at every level
  if (suqa.yorgo_gate(T, seller, 'seller', S1)->>'reason') <> 'off' then raise exception 'gate open with no settings'; end if;
  insert into suqa.yorgo_settings (tenant_id, enabled, cap_global_usd, cap_shop_usd, cap_user_usd, rate_per_min) values (T, true, 2, 1, 0.5, 3);
  if (suqa.yorgo_gate(T, seller, 'seller', S1)->>'reason') <> 'off' then raise exception 'seller gate open while the shop is off'; end if;
  if (suqa.yorgo_gate(T, shopper, 'shopper')->>'reason') <> 'off' then raise exception 'shopper gate open while shopper chat is off'; end if;
  insert into suqa.yorgo_shops (shop_id, tenant_id, enabled) values (S1, T, true);
  update suqa.yorgo_settings set shopper_enabled = true where tenant_id = T;
  g := suqa.yorgo_gate(T, seller, 'seller', S1);
  if not (g->>'ok')::boolean or (g->>'history_turns')::int <> 12 then raise exception 'gate should be open: %', g; end if;
  if (suqa.yorgo_gate(T, seller, 'seller', S2)->>'reason') <> 'off' then raise exception 'another shop is on'; end if;

  -- metering: one exchange = 1 message, 1 model call, tokens and cost in the day's row
  c1 := suqa.yorgo_record(null, T, seller, 'seller', S1, 'pos', turn);
  perform suqa.yorgo_record(c1, T, seller, 'seller', S1, 'pos', turn);
  select messages, cost_usd into n, v from suqa.yorgo_usage where tenant_id = T and shop_id = S1 and user_id = seller;
  if n <> 2 or v <> 0.8 then raise exception 'usage row wrong: % messages, % usd', n, v; end if;
  if (select count(*) from suqa.yorgo_messages where conversation_id = c1) <> 4 then raise exception 'messages not stored'; end if;
  -- a conversation cannot be continued by somebody else, or in another shop
  begin perform suqa.yorgo_record(c1, T, other, 'seller', S1, 'pos', turn); raise exception 'foreign user continued a conversation';
  exception when others then if sqlerrm <> 'conversation_mismatch' then raise; end if; end;
  begin perform suqa.yorgo_record(c1, T, seller, 'seller', S2, 'pos', turn); raise exception 'conversation moved to another shop';
  exception when others then if sqlerrm <> 'conversation_mismatch' then raise; end if; end;

  -- rate: 3 per minute for this association; the seller has sent 2
  perform suqa.yorgo_record(c1, T, seller, 'seller', S1, 'pos', jsonb_build_array(turn->0));
  if (suqa.yorgo_gate(T, seller, 'seller', S1)->>'reason') <> 'rate' then raise exception 'rate limit not applied'; end if;
  update suqa.yorgo_messages set created_at = now() - interval '5 minutes' where conversation_id = c1;

  -- shop cap 1 usd: 0.8 spent → open; one more exchange → closed for the shop, still open for a shopper
  if not (suqa.yorgo_gate(T, seller, 'seller', S1)->>'ok')::boolean then raise exception 'closed under the shop cap'; end if;
  perform suqa.yorgo_record(c1, T, seller, 'seller', S1, 'pos', turn);
  update suqa.yorgo_messages set created_at = now() - interval '5 minutes' where conversation_id = c1;
  if (suqa.yorgo_gate(T, seller, 'seller', S1)->>'reason') <> 'cap_shop' then raise exception 'shop cap not applied: %', suqa.yorgo_gate(T, seller, 'seller', S1); end if;
  if not (suqa.yorgo_gate(T, shopper, 'shopper')->>'ok')::boolean then raise exception 'shopper closed by a shop''s cap'; end if;
  -- a cap of its own lifts that shop only
  update suqa.yorgo_shops set cap_usd = 5 where shop_id = S1;
  if not (suqa.yorgo_gate(T, seller, 'seller', S1)->>'ok')::boolean then raise exception 'shop''s own cap ignored'; end if;

  -- shopper cap 0.5: one 0.4 exchange is fine, the second closes it; seller usage does not count against a shopper
  c2 := suqa.yorgo_record(null, T, shopper, 'shopper', null, 'app', turn);
  update suqa.yorgo_messages set created_at = now() - interval '5 minutes' where conversation_id = c2;
  if not (suqa.yorgo_gate(T, shopper, 'shopper')->>'ok')::boolean then raise exception 'shopper closed too early'; end if;
  perform suqa.yorgo_record(c2, T, shopper, 'shopper', null, 'app', turn);
  update suqa.yorgo_messages set created_at = now() - interval '5 minutes' where conversation_id = c2;
  update suqa.yorgo_settings set cap_global_usd = 100 where tenant_id = T;   -- look at the shopper's own cap first
  if (suqa.yorgo_gate(T, shopper, 'shopper')->>'reason') <> 'cap_user' then raise exception 'shopper cap not applied: %', suqa.yorgo_gate(T, shopper, 'shopper'); end if;
  if not (suqa.yorgo_gate(T, seller, 'seller', S1)->>'ok')::boolean then raise exception 'a shopper''s cap closed a seller'; end if;
  -- global cap 2: 1.2 (seller) + 0.8 (shopper) = 2.0 → everything stops, and the global reason comes first
  update suqa.yorgo_settings set cap_global_usd = 2 where tenant_id = T;
  if (suqa.yorgo_gate(T, shopper, 'shopper')->>'reason') <> 'cap_global' then raise exception 'global cap not applied to shoppers'; end if;
  if (suqa.yorgo_gate(T, seller, 'seller', S1)->>'reason') <> 'cap_global' then raise exception 'global cap not applied: %', suqa.yorgo_gate(T, seller, 'seller', S1); end if;
  -- the master switch
  update suqa.yorgo_settings set cap_global_usd = 100, enabled = false where tenant_id = T;
  if (suqa.yorgo_gate(T, seller, 'seller', S1)->>'reason') <> 'off' then raise exception 'master switch ignored'; end if;

  -- ---- who can read and write ----
  perform set_config('request.jwt.claim.sub', seller::text, true); set local role authenticated;
  if (select count(*) from suqa.yorgo_conversations) <> 1 or (select count(*) from suqa.yorgo_messages) <> 7 then raise exception 'seller does not see exactly their own conversation'; end if;
  if (select count(*) from suqa.yorgo_usage) <> 0 then raise exception 'seller reads usage'; end if;
  if (select count(*) from suqa.yorgo_shops) <> 1 then raise exception 'seller cannot see their shop''s switch'; end if;
  begin update suqa.yorgo_shops set enabled = true, cap_usd = 999 where shop_id = S1; get diagnostics n = row_count; if n <> 0 then raise exception 'seller changed the switch'; end if; end;
  begin perform suqa.yorgo_record(null, T, seller, 'seller', S1, 'pos', '[]'); raise exception 'a signed-in person can write usage';
  exception when insufficient_privilege then null; end;
  begin perform suqa.yorgo_gate(T, seller, 'seller', S1); raise exception 'a signed-in person can call the gate';
  exception when insufficient_privilege then null; end;
  begin insert into suqa.yorgo_messages (conversation_id, tenant_id, role, content) values (c1, T, 'user', '[]'); raise exception 'direct insert into messages';
  exception when insufficient_privilege then null; end;
  perform suqa.yorgo_feedback((select max(id) from suqa.yorgo_messages where conversation_id = c1 and role = 'assistant'), 1::smallint, 'good');
  begin perform suqa.yorgo_feedback((select max(id) from suqa.yorgo_messages m where m.conversation_id <> c1), 1::smallint); raise exception 'feedback on a message that is not readable';
  exception when others then if sqlerrm not in ('not_found', 'bad_value') and sqlerrm not like '%null%' then raise; end if; end;
  reset role;
  if (select feedback from suqa.yorgo_messages where conversation_id = c1 and role = 'assistant' order by id desc limit 1) <> 1 then raise exception 'feedback not stored'; end if;

  perform set_config('request.jwt.claim.sub', other::text, true); set local role authenticated;
  if (select count(*) from suqa.yorgo_conversations) + (select count(*) from suqa.yorgo_messages) + (select count(*) from suqa.yorgo_usage) + (select count(*) from suqa.yorgo_settings) + (select count(*) from suqa.yorgo_shops) <> 0 then raise exception 'a stranger reads something'; end if;
  begin perform suqa.yorgo_feedback((select id from suqa.yorgo_messages limit 1), 1::smallint); exception when others then null; end;
  reset role;

  -- the association's admin: switches and numbers, never the words
  perform set_config('request.jwt.claim.sub', adm::text, true); set local role authenticated;
  if (select count(*) from suqa.yorgo_usage) <> 2 or (select count(*) from suqa.yorgo_settings) <> 1 then raise exception 'admin cannot read usage / settings'; end if;
  if (select count(*) from suqa.yorgo_conversations) + (select count(*) from suqa.yorgo_messages) <> 0 then raise exception 'admin reads conversations'; end if;
  update suqa.yorgo_shops set enabled = false where shop_id = S1; get diagnostics n = row_count; if n <> 1 then raise exception 'admin cannot switch a shop'; end if;
  reset role;

  set local role anon;
  begin perform 1 from suqa.yorgo_usage; raise exception 'anon reads usage'; exception when insufficient_privilege then null; end;
  begin perform 1 from suqa.yorgo_messages; raise exception 'anon reads messages'; exception when insufficient_privilege then null; end;
  reset role;
end $$;
select 'yorgo core: gates, metering and access hold' as result;
rollback;
