# Shop backup and restore

## What a backup is
One file per shop, `suqa-backup-<shop>-<date>.json.gz`, taken by the **owner** from POS → Settings → Backup. It holds everything the
shop owns: items and barcodes, orders with lines / payments / history, customers and debts, suppliers / purchases / supplier payments,
stock and cash movements, shifts, drivers and their payouts, ratings, quick buttons, delivery zones, exchange rates.
It does **not** hold logins, staff PINs, the approval PIN or registered tills — those stay on the server and are untouched by a restore.

Take one every week (the panel turns orange after 7 days) and keep it off the till: USB stick, email to yourself, cloud drive.
Supabase also keeps its own daily database backups of the whole platform; this file is the shop's own copy and the only way to bring
back a single shop without rolling everyone else back.

## When to restore
- rows were deleted by mistake (an import gone wrong, a bulk delete);
- a shop has to be rebuilt on a fresh database (take the file from the old one, restore into the new one after the shop row exists).

A restore **only adds rows that are missing**. It never overwrites or deletes anything that exists now, so it is safe to run twice and
it cannot undo a wrong edit — for that, correct the record at the till.

## Steps (association admin)
1. Ask the shop to stop selling and wait until every till shows "synced" (anything still unsent on a till is kept and sent afterwards).
2. Admin → Shops → the shop → **Restore from a backup** → choose the file. The page shows when the backup was taken and how many rows it has;
   a file from another shop is refused.
3. Press Restore and wait for the result line ("rows put back: N of M").
4. On each till: it reloads its data by itself on the next sync (a few seconds when online). Check one order, one supplier balance and
   one item's stock.

## What happens on the server
`pos_restore_page` inserts missing rows table by table in parent → child order with triggers off (stock, balances and the sync feed are
not replayed). `pos_restore_finish` then recomputes supplier balances from their documents, drops the shop's sync feed so every till
takes a fresh snapshot, and writes `shop.restore` to the audit log.

Stock on hand comes back with the item rows as it was at backup time. If items already exist and only their movements were missing,
on-hand is left as it is now — recount the affected items.
