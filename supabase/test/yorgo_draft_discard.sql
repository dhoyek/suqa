-- 102: a discarded basket is known to the server; an added one cannot be discarded. Rolls back.
begin;
do $$
declare t uuid; d uuid; d2 uuid; x jsonb;
begin
  select id into t from suqa.tenants limit 1;
  d := suqa.yorgo_draft_save(t, null, '+96170000009', '{"lines":[{"product_id":"x","quantity":1}],"choices":[],"not_found":[]}');
  x := suqa.yorgo_draft_get(d);
  assert not (x->>'discarded')::boolean and not (x->>'added')::boolean, 'fresh: ' || x;
  perform suqa.yorgo_draft_discarded(d);
  x := suqa.yorgo_draft_get(d);
  assert (x->>'discarded')::boolean and not (x->>'added')::boolean, 'discarded: ' || x;
  assert (select discarded_at is not null from suqa.yorgo_drafts where id = d), 'column';
  -- a basket already added stays added
  d2 := suqa.yorgo_draft_save(t, null, '+96170000009', '{"lines":[]}');
  perform suqa.yorgo_draft_added(d2); perform suqa.yorgo_draft_discarded(d2);
  x := suqa.yorgo_draft_get(d2);
  assert (x->>'added')::boolean and not (x->>'discarded')::boolean, 'added stays: ' || x;
  -- an expired one is left alone; an unknown id does nothing
  update suqa.yorgo_drafts set expires_at = now() - interval '1 minute', discarded_at = null where id = d;
  perform suqa.yorgo_draft_discarded(d); perform suqa.yorgo_draft_discarded(gen_random_uuid());
  assert (select discarded_at is null from suqa.yorgo_drafts where id = d), 'expired untouched';
  -- a visitor may call it, and still cannot read the table
  assert has_function_privilege('anon', 'suqa.yorgo_draft_discarded(uuid)', 'execute'), 'anon may discard';
  assert not has_table_privilege('anon', 'suqa.yorgo_drafts', 'select'), 'table closed';
end $$;
rollback;
select 'yorgo_draft_discard ok' as result;
