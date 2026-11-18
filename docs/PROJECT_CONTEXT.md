# Suqa — project context

_Last updated 2026-11-18. Kept by Claude; update when environments, rules or status change._

## What it is
Suqa is a white-label platform for local shops: a public storefront where people order from nearby shops, and an offline-first point of sale (POS) for each shop. Owner: Dan. Code: GitHub `dhoyek/suqa` (Next.js monorepo: `apps/web`, `packages/pos-core`, `packages/shared`). Database: Supabase, schema `suqa`.

## Environments
| | Dev | Prod |
|---|---|---|
| Site | suqa-dev.netlify.app ("Batroun Basket") | purplestore.app ("Yorgo Suqa") |
| Netlify project | `suqa-dev`, builds from branch `main` | `yorgo-suqa`, builds from branch `prod` |
| Supabase project | "Suqa" `ixwyhiecmudqeahlejzp` | "Suqa Prod" `snkvytnyzaxmjnlxbubs` |

Supabase organisation "PurpleDigits" is on the Free plan (no automatic backups).

## Working rules
- **Release rule:** work goes to `main` (dev) only. Prod changes only when Dan says "release": database scripts on Suqa Prod first, then push `main` to `prod`.
- **Database scripts:** applied only with Dan's approval per script ("approve NN" = dev; prod with "release"). Full table scripts (complete CREATE TABLE), numbered files in `supabase/schema/`, README row, then `bash supabase/build.sh`.
- **Secrets:** Claude never types, copies or stores passwords, API keys, service-role keys, tokens or one-time codes. Dan enters them himself. Nothing secret in git.
- **Product constraints:** offline-first POS; USD + LBP; multi-device sync; mobile-first; supplier payments, driver and cash actions must never double count.
- **Privacy:** admins can help in every shop but must not see a shop's finances; the setup role sees items and settings only.
- **UI:** change only what was asked. When Dan asks "do you recommend…", advise and wait for his go.
- **Language:** explanations in English, Arabic words in Latin letters (e.g. "sourat al-ghilaf"). Dan sometimes writes in Arabizi.
- **Before reporting a state** (addresses, zones, settings), re-check it in the database.

## Shops on prod
Yorgo shop · Dekanet Jadde (mini market, 174 items) · Furn El Dayaa (28 items) · Abi Hanna Agriculture (324 items) · B4 Sushi (45 items) · Jneinet Baytna (43 items, LBP prices).

## Item matching (done, dev + prod — scripts 75, 76)
Search understands Arabic, Arabizi and English spellings of the same item (khebez = خبز = 5ebez). Used by shop search, home item search and POS search (offline). Items can carry aliases.

## Yorgo — the AI assistant (in progress)
Plan: `docs/yorgo/PLAN.md` in the repo. Non-negotiables: the caller's own sign-in for every tool; no service-role key on paths that read shop data; no cross-shop data; drafts only, a person confirms; never in the POS critical path; no free-form SQL; everything audited; reply in the user's language and script.

- **Step A (core):** on dev. Script 77 applied on **dev** 2026-11-18, not on prod. `ANTHROPIC_API_KEY` is set on both Netlify projects (Dan entered them). First real calls made on dev: about $0.0005 per message. Model thinking is switched off for Yorgo.
- **Step B (POS draft order):** on dev. ✨ Yorgo button in the POS top bar when `yorgo_shops.enabled` for the shop. Owner and cashier paste a customer message and get a draft order to check and send to the cart; other roles can only ask about items. Sales from a draft carry `via_yorgo` in the audit log. Draft → cart was not yet tested in a browser with an owner account.
- Dev switches: Yorgo on, seller mode on for Elie Grocery only. Dev caps: $10/month overall, $3 per shop, $0.50 per shopper. Suggested prod caps: $100 / $10 / $0.50.
- API credits: Console organisation "Purple Digits", Ultra credit $200/month, no payment method on file (nothing can be charged).
- Next: C shopper chat · D usage page · E WhatsApp · F photo tools.

## Restore point
Before the AI work: git branch `milestone/2026-11-18-pre-yorgo` and prod database snapshot schema `suqa_snap_20261118`.

## Open items (Dan)
First real order per shop · owners signing in · B4 Sushi logo and cover · decision on pesticides, tobacco, alcohol, nargile items · Abi Hanna delivery zones · Supabase paid plan for backups · real WhatsApp order messages as test material.
