# Yorgo — plan

One assistant, two modes (shopper, seller), built on the Claude API with tool use. Community project, one operator: cost control is a requirement, not an afterthought.

Status: **item matching live (75, 76); step A (core) and step B (POS: paste a message → draft order) on dev with script 77; prod untouched.**

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

## What it costs (estimate)

List prices checked 2026-11-18, USD per million tokens: the everyday model 0.10 in / 0.50 out (cache read 0.01); the heavy model 2 in / 10 out.

| Exchange | Assumed size | Estimate |
|---|---|---|
| Seller pastes an order, or a shopper asks for items (2 model calls, 1 search) | ~2,900 tokens in, ~210 out | about $0.0004 |
| The same, deep in a long conversation | ~8,000 in, ~300 out | about $0.001 |
| Invoice or product photo on the heavy model | ~3,000 in, ~800 out | about $0.014 |

So one dollar buys roughly 1,000 to 2,500 ordinary exchanges, or about 70 photos. These are estimates from assumed sizes, not measurements:
the usage page will show real numbers once a key is in place. Script 77's defaults are $20 a month for the whole site, $5 per shop and
$0.50 per shopper; all three are settings.

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

---

# Plan — step W1: order by WhatsApp text (2026-11-21)

**Status: plan only. Nothing built, no script applied, no secret touched. Waiting for Dan's approval and his decisions (last section).**

## Bottom line

A customer writes what he wants to the market's WhatsApp number; Yorgo answers in a few seconds with a short summary and a link;
the link opens the ready basket in the app, where he checks it and orders the usual way. In this step Yorgo on WhatsApp reads the
public catalog only and never acts as the customer: no account lookup, no order placed from WhatsApp. That removes the main risk
(acting for someone because of a phone number) and needs no new secret.

## What is there today (read in the code and on dev, 21 Nov)

1. **The webhook** (`app/api/wa/webhook`) verifies Meta's signature, then for each inbound message: a shared location pins the
   customer's address; a driver's "ok" confirms his dispatch; a message that quotes one of our order messages — or comes from a phone
   with exactly one open order — is added to that order's history and passed on to the other side. **Everything else is logged and
   gets no reply.** A voice note is stored as the text `[audio]`: nothing is downloaded or transcribed.
2. **No guard against Meta's retries**: the log is an upsert on the message id, so a message delivered twice is processed twice.
3. **The work runs before the webhook answers Meta.** Fine for today's quick work; a Yorgo answer takes 5–20 s.
4. **Yorgo's customer tools read the public catalog only** (`match_items` is open to anyone; `draft_basket` re-reads items that are
   on sale online). They need no signed-in person. The gate and the metering take a user id (`yorgo_gate`, `yorgo_record`).
5. **The basket lives in the browser.** A draft becomes a basket when the customer taps "add to cart" in the app chat. There is no
   stored draft and no link to one.
6. **One WhatsApp number** for the market (env `WHATSAPP_PHONE_ID`; `wa_numbers` is empty on dev). The same number sends the order
   notifications.
7. **Runtime**: Next 15.5 on Netlify, route handlers, 60 s limit on the chat route. No background job exists yet.
8. **Meta's rules** (their pricing pages, read 21 Nov 2026): general-purpose AI assistants are barred from the Business Platform
   since 15 Jan 2026; an assistant that serves the business's own ordering is the permitted kind (Meta's page does not spell this
   case out; that reading comes from a vendor's summary — to confirm in Meta's terms before prod). Free-form replies inside the
   24-hour window are **charged since 1 Oct 2026 after 1,000 free per number per month**; Lebanon is in "Rest of Middle East";
   the rate is in Meta's rate card (to confirm).

## How it works

```
customer text ─► webhook: signature ✓ ─► wa_inbox (message id, once) ─► 200 to Meta
                                              │ background
                                              ▼
                 existing rules first (location, driver ok, order message) ── match ─► as today
                                              │ no match
                                              ▼
                 Yorgo, shopper mode, public catalog, conversation = this phone
                                              ▼
                 draft stored (yorgo_drafts, 24 h) ─► WhatsApp reply: one line + summary + link /y/<id>
                                              ▼
                 app: the same basket card (pick options, quantities) ─► add to cart ─► normal checkout (sign-in there)
```

- **Routing on the shared number** stays as today for anything that matches an order (see decision 1). Only what is silent today
  goes to Yorgo.
- **Identity**: the phone is used for three things only — one conversation per phone (a new one after 24 h of silence), the rate
  limit and monthly cap per phone, and the tag on the draft. No profile is read, no order is read.
- **The draft** stores product ids, quantities, notes, options and the customer's own words for what was not found. The page
  re-reads names, prices and availability when it opens, so it never shows an old price. The id is a random uuid; whoever has the
  link sees a basket of public items, nothing personal.
- **The reply**: language as in the app (English → English, Arabic or Arabizi → Arabic), one short line, then e.g.
  `Dekanet Elie · 6 items · $18.40 (1,656,000 L.L.) · 2 to choose · 1 not found` and the link. No item list in the text.
- **More than 10 unclear lines** → one short question instead of a draft (same rule as the app).
- **Other message types** (voice until step W2, photo, sticker, contact) → one short polite line, at most once per hour per phone.
- **Switch**: `yorgo_settings.whatsapp_enabled`, off by default. Prod stays off until you release and switch it on.

## Work, in small steps (each testable on its own)

| # | Step | Files | Tested how |
|---|---|---|---|
| 1 | Script 95 (below) | `supabase/schema/95_yorgo_whatsapp.sql`, `supabase/test/yorgo_whatsapp.sql` | database test: a message id is taken once; gate per phone (rate, cap, switch off); draft read by id, gone after 24 h; nobody can list drafts or read another phone's conversation; a signed-in customer and an admin read nothing of it |
| 2 | Core takes a caller without an account | `lib/yorgo/core.ts` (user id optional, phone in), `core.test.ts` | unit tests: same turn with a phone instead of a user; gate and record called with the phone |
| 3 | Draft page `/y/[id]` | new `app/(store)/y/[id]/page.tsx`; the basket card moved out of `components/YorgoChat.tsx` into `components/YorgoBasketCard.tsx` and used by both | browser on dev: open a stored draft, pick options, add to cart, reach checkout; expired and unknown ids |
| 4 | Webhook → Yorgo | `app/api/wa/webhook/route.ts` (once-only guard, background run with Next `after()`), new `lib/yorgo/whatsapp.ts` (routing decision, reply text) + tests | unit tests on routing and reply text; end to end on dev **needs you**: you write to the Meta test number, I read the result in the database (I cannot send WhatsApp messages or sign a webhook) |
| 5 | Admin → Yorgo: WhatsApp switch, cap per phone, counts | `app/admin/yorgo/*` | browser on dev as admin |
| 6 | Test set | `docs/yorgo/eval-cases.json`: the customer cases run through the WhatsApp path (reply text + stored draft) | run before and after; reported in the CHANGELOG |

If Next `after()` does not hold on Netlify for 20 s (checked in step 4 on dev), the fallback is a Netlify background function fed
from `wa_inbox`; the table is there for that.

## Database — script 95 (not applied until "approve 95")

Full table scripts. Two changed tables, two new ones. The functions (gate and record with a phone, draft save / read, inbox claim)
come with the script file at build time and are covered by the database test.

```sql
-- changed: + whatsapp_enabled, cap_wa_phone_usd
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

-- changed: + wa_phone (a WhatsApp conversation belongs to a phone, not to an account)
create table if not exists suqa.yorgo_conversations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references suqa.tenants(id) on delete cascade,
  user_id     uuid,                                                     -- the signed-in person; null on WhatsApp
  wa_phone    text,                                                     -- 95: the WhatsApp phone (E.164); null in the app and the POS
  shop_id     uuid references suqa.shops(id) on delete cascade,         -- seller mode: the shop; shopper mode: null
  mode        text not null check (mode in ('shopper','seller')),
  channel     text not null default 'app' check (channel in ('app','pos','whatsapp')),
  summary     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table suqa.yorgo_conversations add column if not exists wa_phone text;
create index if not exists yorgo_conversations_wa on suqa.yorgo_conversations(wa_phone, updated_at desc) where wa_phone is not null;
-- RLS unchanged: a person reads his own (user_id = auth.uid()); a WhatsApp conversation has no user, so nobody reads it from the app.

-- new: every inbound message once (Meta retries), and the queue a background job can read
create table if not exists suqa.wa_inbox (
  wamid           text primary key,                                     -- Meta's message id
  tenant_id       uuid references suqa.tenants(id) on delete cascade,
  phone           text not null,
  phone_number_id text,
  kind            text not null,                                        -- text, audio, image, …
  body            text,
  received_at     timestamptz not null default now(),
  handled_at      timestamptz,
  handled_as      text,                                                 -- order_message | location | driver_ack | yorgo | unsupported | off | error
  error           text
);
create index if not exists wa_inbox_pending on suqa.wa_inbox(received_at) where handled_at is null;
alter table suqa.wa_inbox enable row level security;                    -- no policy: service role only

-- new: a basket draft behind a link
create table if not exists suqa.yorgo_drafts (
  id              uuid primary key default gen_random_uuid(),           -- the link: unguessable
  tenant_id       uuid not null references suqa.tenants(id) on delete cascade,
  conversation_id uuid references suqa.yorgo_conversations(id) on delete set null,
  channel         text not null default 'whatsapp' check (channel in ('whatsapp')),
  wa_phone        text,
  draft           jsonb not null,                                       -- product ids, quantities, notes, options, not-found words: no prices, no names
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '24 hours',
  opened_at       timestamptz,
  added_at        timestamptz                                           -- "add to cart" tapped
);
create index if not exists yorgo_drafts_expiry on suqa.yorgo_drafts(expires_at);
alter table suqa.yorgo_drafts enable row level security;                -- no policy: read only through yorgo_draft_get(id), which returns the draft column of an unexpired row
```

## Secrets you add

None for this step. `WHATSAPP_TOKEN`, the app secret and the Yorgo key are already in Netlify (dev and prod).

## Cost

- **AI**: measured on dev on 21 Nov with the customer model: 12 messages = 30 model calls = $0.13, so **about $0.011 per customer
  message**. A WhatsApp order is usually 1–3 messages: **$0.01–0.03 per order**.
- **Meta**: one reply per customer message. Free up to 1,000 replies a month on the number, then Meta's "Rest of Middle East"
  service rate per reply — **to confirm** from the rate card.
- The global monthly cap and the new cap per phone stop spending when reached; the customer then gets the "paused" line.

## Risks and open questions

- **Meta's policy**: an ordering assistant for our own shops is the allowed kind, but that reading must be confirmed in Meta's
  terms before prod. Dev with the test number is not affected.
- **Shared number**: a customer with an open order who writes a new order is, by today's rule, passed to the shop as a message on
  that order. Kept as is in this step (nothing that works today changes); see decision 1.
- **Unknown phones cost money**: anyone can write to the number. Rate limit, cap per phone, global cap, and decision 6.
- **Pasted text as instructions**: the customer's text can only lead to a search and a draft of public items; no tool can do more.
- **Speed**: 5–20 s per answer. Meta gets its 200 at once; the customer sees the reply when it is ready.
- **Not in this step**: voice notes (W2, with the provider wrapper — Claude does not take audio, so it needs the second provider),
  Confirm inside WhatsApp, order status by WhatsApp, staff forwarding.

## Order of the modules after W1

W1 text orders → **B + W2 together** (provider wrapper and voice notes: voice is what needs a second provider) → photo and voice
in the app chat → staff forwarding → screen-aware Yorgo → item images.

## Decisions (Dan, 21 Nov)

1. **Number**: the same market number. Order messages keep working as today; only what is silent today goes to Yorgo.
2. **Confirm inside WhatsApp**: no in this step — always "open in app".
3. **Wording**: proposed below, waiting for his OK.
4. **Cap per WhatsApp phone**: $2 a month (a setting; the cap per app customer on prod was raised to $2 the same day). The global cap stays as it is.
5. **Drafts** are deleted after 24 hours (removed at the next save; no scheduled job).
6. **Who gets an answer**: every phone.
7. **Privacy page**: one line saying messages to the WhatsApp number are read by the AI assistant.

## Wording proposed (waiting for Dan's OK)

`{brand}` = the market's name, `{link}` = the draft link, `{site}` = the market's address.

| When | Arabic | English |
|---|---|---|
| First answer to a phone (added once, under the answer) | أنا يورغو، المساعد الآلي (ذكاء اصطناعي) لـ{brand}. أجهّز لك السلة، وأنت تراجعها وتؤكّد الطلب من التطبيق. | I'm Yorgo, {brand}'s AI assistant. I prepare your basket; you check it and confirm the order in the app. |
| Under the summary | افتح السلة، راجعها واطلب: {link}\n(الرابط صالح 24 ساعة) | Open your basket, check it and order: {link}\n(the link works for 24 hours) |
| Cap reached / assistant off for the month | المساعد متوقف مؤقتاً. يمكنك الطلب مباشرة من التطبيق: {site} | The assistant is paused for now. You can order directly in the app: {site} |
| Too many messages in a minute | لحظة من فضلك، ثم أرسل رسالتك من جديد. | One moment please, then send your message again. |
| Voice note, photo, sticker, contact (once an hour at most; both languages in one message, since there is no text to tell the language from) | حالياً أقرأ الرسائل المكتوبة فقط. اكتب لي ما تريد طلبه وأجهّز لك السلة. | For now I read text messages only. Write what you would like to order and I'll prepare your basket. |
| Something failed | عذراً، حصل خطأ. جرّب مرة أخرى، أو اطلب من التطبيق: {site} | Sorry, something went wrong. Try again, or order in the app: {site} |
| Privacy page | الرسائل التي ترسلها إلى رقم واتساب السوق يقرأها المساعد الآلي (يورغو) لتجهيز سلتك. | Messages you send to the market's WhatsApp number are read by the AI assistant (Yorgo) to prepare your basket. |

## Built so far

- **Script 95** (`supabase/schema/95_yorgo_whatsapp.sql`) written, **not applied**. Database test `supabase/test/yorgo_whatsapp.sql` passes on the local database.
