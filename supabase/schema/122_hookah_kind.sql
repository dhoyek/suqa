-- 122: a new kind for the item search — the water pipe ("argile", "arguile", "nargile", "shisha", "hookah", أرغيلة, أركيلة, نرجيلة …).
--   People asked for it three different ways on prod (أرغيلة, نبريش أركيلة, …) and four shops sell it or its parts.
--   Asking for the kind now finds the pipe itself, its tobacco (maassel), its charcoal and its foil, in the shop page search,
--   the home search and Yorgo. The same entry is in packages/pos-core/src/concepts.ts (the till); a test keeps the two in step.
--   It is not food, so it has no "never in these categories" list. No table change, no function change. Safe to run twice.

insert into suqa.match_concepts (id, say, tags) values
  ('hookah',
   array['argile', 'arguile', 'argileh', '2argile', 'arjile', 'nargile', 'narguile', 'nargileh', 'narjile', 'shisha', 'chicha', 'hookah', 'أرغيلة', 'أركيلة', 'أرجيلة', 'نرجيلة', 'نارجيلة', 'شيشة'],
   array['argile', 'arguile', 'argileh', 'nargile', 'narguile', 'hookah', 'shisha', 'أرغيلة', 'أركيلة', 'أرجيلة', 'نرجيلة', 'للأركيلة', 'للأرغيلة', 'معسل', 'ma3sal', 'maassel'])
on conflict (id) do update set say = excluded.say, tags = excluded.tags, updated_at = now();

update suqa.match_concepts set not_in = array[]::text[] where id = 'hookah';
