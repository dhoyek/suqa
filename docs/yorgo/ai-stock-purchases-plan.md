# Yorgo for stock and purchases — plan (26 Nov 2026)

Dan's go: all five, plus "how much do I have of this item". Built one at a time; each is small enough to test alone.
Rules that hold for all of them: the till stays offline-first (these are online helpers, the till works without them); nothing is
posted, counted or priced without the person confirming on screen; money is never counted twice; costs are for the owner only;
the association never sees a shop's costs or purchases; same switch and monthly limits as Yorgo in the till.

| # | What | State | Script |
|---|---|---|---|
| 3 | Stock questions in the Yorgo panel: "adde 3ande pepsi?", "shou na2es?", "what expires?", "what is not selling?" | **built on dev** (`stock_of`, `stock_watch`); "how much" works now, the lists need 123 | 123 `pos_stock_watch` |
| 1 | Photo of a supplier invoice → draft purchase invoice | next | none expected (uses the `photo_read` route) |
| 4 | Price check in the purchase invoice: a cost that went up → suggested selling price to keep the margin | next, with 1 (same screen) | none |
| 2 | "What should I order?" per supplier, from what sold and what is left; send to the supplier on WhatsApp | after 1 | one read-only function (sales per item for N days + stock + supplier; owner / stock) |
| 5 | Stock count by voice or text: "pepsi 12, labne 5" → a count draft to confirm | last | none expected (uses the till's own stock count) |

## 1 — invoice photo, how
- Purchases → new invoice → "📷✨ From a photo of the invoice". The photo is shrunk on the device (as item photos are) and sent to
  `/api/pos/purchase-photo`; the model returns supplier name, invoice no., date, currency and lines (name as printed, barcode if
  printed, quantity, unit price, line discount, line total).
- The till matches each line to the shop's own items ON THE DEVICE (barcode first, then the same search as the sale screen) and
  fills the invoice rows. A line it cannot match is listed with a "pick the item" button; nothing is created by itself.
- A check line under the table: the photo's total vs the total of the filled rows. The owner corrects and taps "Receive & post".
- Not stored: the photo. Recorded: the cost on the shop's Yorgo usage.
- Open question for Dan: create a missing supplier from the photo's name, or always ask?

## 2 — what to order, how
- Suggestion per item = what sold in the last N days (default 14) scaled to the days to cover (default 7), minus what is on the shelf,
  rounded up; only items that track stock and have sold. Grouped by the item's supplier.
- Shown as a list the owner edits (quantities, remove lines), then "send on WhatsApp" opens the supplier's chat with the list.
  Nothing is ordered or recorded by the app.

## 5 — count by voice, how
- "3ed: pepsi 12, labne 5" → items matched, a card with item, counted, on the shelf now, difference → the owner confirms → the
  till's existing stock count writes the adjustment (one operation per confirm, so a repeat cannot count twice).
