# Yorgo — changelog

## Milestone 1a — item matching (script 75)

**Built**

- `supabase/schema/75_item_matching.sql`
  - `products.aliases text[]` (public, max 40 per item). Base file `04_catalog.sql` lists it.
  - `suqa.norm_text` — lower-case, tashkeel off, alef / ya / ta-marbuta / hamza variants unified, Arabic-Indic digits, punctuation.
  - `suqa.skel_text` — consonant skeleton in one alphabet: خبز = khebez = 5ebez → `xbz`; منقوشة = man2ouche → `mnkc`; بيبسي = pepsi = bebsi → `bbs`. Arabizi digits 2 3 5 7 8 9 count as letters only inside a word, never inside a number (`185ml` stays).
  - `suqa.product_search` — folded names per item, kept by trigger, two trigram indexes, RLS on with no policy.
  - `suqa.match_items(tenant, phrases[], shop?, limit?)` — up to 10 candidates per phrase with score, USD / LBP price, availability, weekday limits and how it matched (exact / spelling / sound).
  - `suqa.alias_suggestions`, `alias_suggest`, `alias_decide` (audited as `alias.approve` / `alias.reject`).
  - `pos_restore_finish` patched: a restore loads rows with triggers off, so the shop's items are folded when it finishes.
- `supabase/test/yorgo_match.sql` + fixtures: the pilot shop's 1,159 item names and 85 phrases.

**Match accuracy** (pilot catalog, 1,159 items, no aliases added)

| Kind | Phrases | Right item first | In the first three |
|---|---|---|---|
| Arabic | 31 | 30 | 31 |
| Arabizi | 22 | 21 | 21 |
| English | 23 | 23 | 23 |
| Mixed script | 5 | 5 | 5 |
| Typos | 4 | 4 | 4 |
| **All** | **85** | **83 (98%)** | **84 (99%)** |

Misses: `bayd` → the skeleton is two letters, too short to trust, and "bayda" in another item's name wins (an alias fixes it); `علبة تونا` → a tinned hot dog comes first because of "tin / علبة", tuna is second.

The phrases were written by the developer from the catalog, not taken from real customers. Six expected answers were widened after the first run because the catalog's own spelling differs ("ketchuup", "FA7EM", "chame3", "HOMMOS", "BATT"). Expect lower numbers on real messages; re-measure with real ones after the first weeks of orders.

**Speed**: about 40 ms per phrase on 1,159 items (local Postgres).

**Access rules proven by the test**

- Anonymous and other shops' staff never get a hidden item; `product_search` cannot be read directly.
- The shop's own staff get all active items; an alias is an exact hit (score 1).
- A suggestion for an item the caller cannot see is dropped; a shopper cannot read suggestions; another shop's owner cannot decide; an approval lands on the item and in the audit log.

**Decisions**

- Milestone 1 split into 1a (this) and 1b (Claude call, conversations, metering) — see PLAN.md.
- No pgvector: not needed at this accuracy.
- Not wired into any screen yet. The storefront and POS searches are unchanged.

## Milestone 1a, follow-up — closest name first (script 76)

Found on prod after 75: "khebez" returned two crouton items ahead of "Arabic bread". All three contain خبز and tied at 0.77, because closeness to the whole name was measured by spelling only, so a Latin phrase against an Arabic name scored 0. The local run had bread first only by row order, which is why the accuracy table did not show it.

- `match_items`: the whole-name term is also measured on the consonant skeleton; equal scores go to the shorter name.
- Test: a dedicated check that bread outscores croutons for "khebez" (it fails on 75, passes on 76).
- Accuracy on the 85 phrases is unchanged: 83 first (98%), 84 in the first three (99%). One more expected answer was widened ("CANDEL", the catalog's own spelling).
- Also learned on real data: searching across all shops is noisier than inside one shop ("bayd b 2awarma" puts a grocery item first). The assistant should search inside the chosen shop whenever there is one.
