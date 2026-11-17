# Yorgo — plan

One assistant, two modes (shopper, seller), built on the Claude API with tool use. Community project, one operator: cost control is a requirement, not an afterthought.

Status: **milestone 1 (item matching) built; the AI core is not started.** Nothing below milestone 1 exists yet.

## What the repo already gives us

| Area | What is there | Consequence for Yorgo |
|---|---|---|
| Runtime | Next.js on Netlify (`apps/web`), route handlers under `app/api/*`; the WhatsApp webhook is `app/api/wa/webhook`. No Supabase Edge Functions are deployed. | Yorgo runs as Next route handlers (`app/api/yorgo/*`) next to the webhook, not as Edge Functions: one runtime, one place for secrets, one deploy. |
| Access | Supabase RLS; `suqa.pos_role(shop)` = owner / cashier / stock / setup; column grants on `products` (71) hide cost, margin, supplier. | Every tool runs a Supabase call with the caller's JWT. No service key in a tool path. |
| POS | Offline-first: every change is an op in the outbox → `pos_push`; devices follow `sync_log`. | A confirmed draft becomes ordinary outbox ops on the device. Yorgo never writes orders, stock or money on the server. |
| Privacy | `setup` role (association) sees items and settings, never sales, purchases or costs. | Seller tools are filtered by role before the model sees the tool list; a `setup` caller gets item tools only. |
| Audit | `suqa.audit_log(shop, user, action, ref, before, after, acting_as_admin)`. | Drafts and confirmations are logged with `after.via_yorgo` and the conversation id. |
| Catalog | `products.name {ar,en}`, `section`, `available_days`, `visible_online`; Arabic folding existed three times in TS. | One folding in SQL (75), used by search and by Yorgo. |

## Architecture

```
app/api/yorgo/chat      POST {mode, shop_id?, conversation_id, message, attachments?}   (user JWT)
app/api/wa/webhook      existing → lib/yorgo/core in shopper mode                        (milestone 4)
lib/yorgo/core          prompts · tool definitions · tool executors · model routing · metering
```

- Models are configuration (`YORGO_MODEL_DEFAULT`, `YORGO_MODEL_HEAVY`): the small model by default, the larger one only for photo reading and bulk name cleanup.
- Prompt caching on the system prompt and tool definitions.
- The API key is a Netlify environment secret, entered by the operator. Never in the client, never in the repo.
- Context: last N turns verbatim, older turns summarised.
- Rate limit per user and monthly caps (shop, shopper, global) checked before the model is called.

## The rule that keeps it honest: the model never names an item or a price

The model extracts `{text, quantity, unit, notes}` from what the person wrote. `match_items` — plain SQL, no AI — turns `text` into real items with real prices. The model may only speak about candidates that came back, and asks a short question when the best score is low or two candidates are close.

## Tools

| Mode | Tool | Who | Milestone |
|---|---|---|---|
| both | `match_items` | everyone (public catalog) / staff (own shop, all active items) | 1 ✔ |
| shopper | `search_shops`, `get_item_availability`, `build_basket_draft`, `get_my_orders`, `get_order_status`, `contact_shop` | signed-in shopper | 3 |
| seller | `draft_order_from_message` | owner, cashier | 2 |
| seller | `draft_purchase_from_invoice`, `draft_item_from_photo` | owner, stock | 5 |
| seller | `suggest_item_cleanup` | owner (and setup: names only) | 5 |
| seller | `shop_report` (fixed reports, existing RPCs) | owner; cashier only what cashier screens show; never setup | 6 |
| seller | `write_offer_text` | owner | 6 |

Every draft is a stable JSON object the UI renders with Confirm / Edit / Discard. Confirm calls the same code as the manual flow, including the approval PIN.

## Data model

| Table | Milestone | Notes |
|---|---|---|
| `products.aliases` | 1 ✔ | other names for an item |
| `product_search` | 1 ✔ | folded names, trigger-kept, no direct access |
| `alias_suggestions` | 1 ✔ | picks waiting for the shop's decision |
| `yorgo_conversations`, `yorgo_messages` | 2 | history, tool calls, tokens, cost estimate, feedback |
| `yorgo_usage` | 2 | per day per shop and per user; caps |

Full CREATE TABLE text for every table lives in the schema files (base files for changed tables, the numbered script for new ones).

## Decisions taken (change them if you disagree)

1. **Next route handlers instead of Edge Functions** — follows the repo.
2. **Milestone 1 is split.** 1a (done): matching, aliases, test set. 1b (with milestone 2): the Claude call, conversations, metering — they are only testable once there is a first tool flow and an API key.
3. **Aliases are public** like item names, and approved by owner, stock or the association's setup role (it is item setup, not finance).
4. **No embeddings.** Trigram + consonant skeleton reached 98% top-3 on the pilot test set. The hook is a column on `product_search`.

## Open points that are the operator's

- WhatsApp shoppers have no login, so "the caller's own JWT" cannot hold there. Proposal: a read-only public path limited to the public catalog and that phone number's own orders.
- Wording shown to shoppers ("answers come from an AI assistant"), the paused-assistant message, and the monthly caps.
- Privacy page: messages, phone numbers and invoice photos are sent to the model provider.
- Meta's current rules for AI assistants on the WhatsApp Business API, before milestone 4.

## Milestones

1. **Foundation + item matching** — 1a done (see CHANGELOG); 1b with 2.
2. POS: paste a WhatsApp message → draft order.
3. Shopper chat → basket draft, order status.
4. Yorgo on WhatsApp (dev test number only).
5. Photo tools and item cleanup.
6. Fixed reports, offer text, usage page, polish.
