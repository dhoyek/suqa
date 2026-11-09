#!/usr/bin/env python3
"""Suqa migration converter — old SQL Server POS (SBCDB export CSVs) → Suqa import batches.

    python3 convert.py --export ./export --out ./out                       # convert only (writes out/*.jsonl + summary)
    python3 convert.py --export ./export --upload https://suqa-dev.netlify.app --shop abou-elie --secret $SUQA_SECRET [--dry-run]

Repeatable: every row carries the old key; the server (suqa.migrate_apply) skips history it already has and refreshes
products / customers / suppliers / balances. Run it again after a newer export and only the new receipts land.

What goes in (and why):
  products   ITEMS ∩ (has stock row ∪ sold ∪ purchased ∪ modified ≤ 2 years), + their ITEM_BARCODE rows (pack sizes kept)
  stock      ITM_WH: opening + in − out  → opening 'count' move per product
  customers  PARTY type C (except "Cash Client"), balance = DEBIT − CREDIT in the party currency → opening debt
  suppliers  PARTY type S (except "Default Supplier"), balance = CREDIT − DEBIT → opening supplier balance
  orders     HISTORIC_RECEIPT + RECEIPT with their lines (prices are in the receipt currency; '-1 PAYMENT' lines are
             account payments, not sales, and are dropped) + RCPT_PAYMENT rows
  purchases  TRANSACTIONS type P with TRANSACTION_CONTENTS (ITM_TOTAL in the transaction currency)
  settings   ScaleSettings → scale prefix / code length / price digits
Skipped on purpose: TRANSACTIONS S / R / SR (ledger postings and party payments — the party balances already carry
their effect), PENDING_RECEIPTS (16 parked baskets), Delivery_Persons (no phone numbers in the old system).
"""
import argparse, csv, json, os, sys, time, urllib.request, collections
try: sys.stdout.reconfigure(encoding='utf-8', errors='replace'); sys.stderr.reconfigure(encoding='utf-8', errors='replace')   # Windows consoles default to cp1252
except Exception: pass
from datetime import datetime, timedelta

LL, USD = '0', '1'
def rd(path):
    with open(path, encoding='utf-8-sig', newline='') as h: return list(csv.DictReader(h))
def num(s, d=0.0):
    try: return float(s) if s not in (None, '') else d
    except ValueError: return d
def cents(usd): return int(round(usd * 100))
def iso(s):
    s = (s or '').strip()
    for f in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d'):
        try: return datetime.strptime(s[:19], f).strftime('%Y-%m-%dT%H:%M:%S+02:00')
        except ValueError: pass
    return None
def name(s):
    s = (s or '').strip() or '—'
    return {'ar': s, 'en': s}
def phone_clean(p):
    d = ''.join(ch for ch in (p or '') if ch.isdigit())
    if d.startswith('00'): d = d[2:]
    if d.startswith('961'): d = d[3:]
    d = d.lstrip('0')
    return d if len(d) >= 6 else ''

def convert(exp, two_years=True):
    S = {}
    # ---------------------------------------------------------------- reference tables
    sub = {r['SubGrp_ID']: r['SubGrp_Name'].strip() for r in rd(f'{exp}/SUBGROUPS.csv')}
    default_rate = max((num(r['CURR_SALES_PARITY']) for r in rd(f'{exp}/CURRENCY.csv') if r['CURR_CODE'].strip() == 'USD'), default=90000.0)
    # ---------------------------------------------------------------- what was sold / bought / stocked
    hr, cur = rd(f'{exp}/HISTORIC_RECEIPT.csv'), rd(f'{exp}/RECEIPT.csv')
    receipts = hr + cur
    rlines = rd(f'{exp}/HISTORIC_RECEIPT_CONTENTS.csv') + rd(f'{exp}/RECEIPT_CONTENTS.csv')
    rpay = rd(f'{exp}/HISTORIC_RCPT_PAYMENT.csv') + rd(f'{exp}/RCPT_PAYMENT.csv')
    trs = rd(f'{exp}/TRANSACTIONS.csv'); tlines = rd(f'{exp}/TRANSACTION_CONTENTS.csv')
    wh = rd(f'{exp}/ITM_WH.csv')
    used = set(c['ITM_CODE'] for c in rlines) | set(c['ITM_CODE'] for c in tlines if c['TRS_TYPE'] == 'P') | set(w['ITM_CODE'] for w in wh)
    used -= {'-1', '0', ''}
    cutoff = (datetime.now() - timedelta(days=730)).strftime('%Y-%m-%d')
    # ---------------------------------------------------------------- barcodes (streamed: 528k rows)
    bcs = collections.defaultdict(list)
    with open(f'{exp}/ITEM_BARCODE.csv', encoding='utf-8-sig', newline='') as h:
        for b in csv.DictReader(h):
            bc = (b['ITM_BARCODE'] or '').strip()
            if not bc or bc.startswith('-'): continue          # internal negative codes are not scannable
            bcs[b['ITM_CODE']].append({'barcode': bc, 'pack': num(b['ITM_PACKAGE'], 1) or 1, 'price': num(b['ITM_PRICE']), 'markup': num(b['ITM_FIXEDPROFIT'])})
    # ---------------------------------------------------------------- items (streamed: 460k rows)
    stock = {}
    for w in wh: stock[w['ITM_CODE']] = stock.get(w['ITM_CODE'], 0) + num(w['OPENING_QTY']) + num(w['STOCK_IN']) - num(w['STOCK_OUT'])
    products, pname = [], {}
    n_all = n_recent = 0
    with open(f'{exp}/ITEMS.csv', encoding='utf-8-sig', newline='') as h:
        for it in csv.DictReader(h):
            code = it['ITM_CODE']; n_all += 1
            if code in ('-1', '0'): continue
            recent = two_years and (it['ITM_DATE_MODIFIED'] or '') >= cutoff
            if code not in used and not recent: continue
            n_recent += recent and code not in used
            scur = it['ITM_SALECURRENCY1'].strip() or LL
            rows = bcs.get(code, [])
            base = next((b for b in rows if b['pack'] == 1), None) or (min(rows, key=lambda b: b['pack']) if rows else None)
            unit_price = (base['price'] / base['pack']) if base else 0.0
            if scur == USD: price_usd, price_lbp, pcur = unit_price, int(round(unit_price * default_rate)), 'usd'
            else: price_usd, price_lbp, pcur = unit_price / default_rate, int(round(unit_price)), 'lbp'
            cost = num(it['ITM_COST']); bcur = it['ITM_BUYCURRENCY'].strip() or LL
            cost_cents = cents(cost if bcur == USD else cost / default_rate) if cost else None
            scale = any(len(b['barcode']) >= 12 and b['barcode'][:2] in ('27', '26') for b in rows)
            barcodes = []
            for b in rows:
                if b['pack'] == 1 or b is base: barcodes.append({'barcode': b['barcode'], 'pack_qty': 1})
                else:
                    pp = b['price']
                    barcodes.append({'barcode': b['barcode'], 'pack_qty': b['pack'], **({'pack_price_usd': round(pp, 2)} if scur == USD else {'pack_price_lbp': int(round(pp))})})
            markup = num((next((b for b in rows if b['pack'] == 1), None) or {}).get('markup', 0))
            margin = round(100 * markup / (100 + markup), 2) if 0 < markup <= 100 else None    # old system: fixed profit % over cost → our margin on selling price
            pname[code] = name(it['ITM_TITLE'])
            products.append({'key': code, 'name': pname[code], 'section': sub.get(it['ITM_SUBGROUP'], '') or None, 'price_currency': pcur,
                             'price_usd': round(price_usd, 4), 'price_lbp': price_lbp, 'cost_cents': cost_cents, 'sku': code,
                             'unit_kind': 'kg' if scale else 'piece', 'decimal_qty': scale, 'vat': num(it['ITM_VAT']) > 0, 'active': it['ITM_ACTIVE'].strip() in ('1', 'True'),
                             'on_hand': round(stock.get(code, 0.0), 3), 'barcodes': barcodes,
                             'supplier_key': it['ITM_SUPPLIER'] if it['ITM_SUPPLIER'] not in ('', None) else None, 'margin_pct': margin})
    S['items_in_old_system'] = n_all; S['products'] = len(products); S['products_only_because_recent'] = n_recent
    S['barcodes'] = sum(len(p['barcodes']) for p in products)
    # ---------------------------------------------------------------- parties
    parties = rd(f'{exp}/PARTY.csv'); pmap = {p['ID']: p for p in parties}
    customers, suppliers = [], []
    for p in parties:
        pcur = p['CURRENCY'].strip() or LL
        conv = (lambda v: v) if pcur == USD else (lambda v: v / default_rate)
        if p['TYPE'] == 'C' and p['ID'] != '1':
            bal = conv(num(p['DEBIT']) - num(p['CREDIT']))
            customers.append({'key': p['ID'], 'phone': phone_clean(p['PHONE']), 'name': p['TITLE'].strip(), 'discount_pct': num(p['DISCOUNT']) or None,
                              'credit_limit_cents': cents(conv(num(p['CREDIT_LIMIT']))) or None, 'notes': (p['REMARKS'] or '').strip() or None, 'balance_cents': cents(bal)})
        elif p['TYPE'] == 'S':   # includes the old 'Default Supplier' (id 0): some purchases point at it
            bal = conv(num(p['CREDIT']) - num(p['DEBIT']))
            suppliers.append({'key': p['ID'], 'name': ('مورّد غير محدد' if p['ID'] == '0' else p['TITLE'].strip()), 'phone': phone_clean(p['PHONE']), 'contact': (p['Contact'] or '').strip() or None,
                              'notes': (p['REMARKS'] or '').strip() or None, 'balance_cents': cents(bal)})
    S['customers'] = len(customers); S['customers_with_phone'] = sum(1 for c in customers if c['phone']); S['customers_owing'] = sum(1 for c in customers if c['balance_cents'] > 0)
    S['suppliers'] = len(suppliers); S['suppliers_owed'] = sum(1 for s in suppliers if s['balance_cents'] != 0); S['suppliers_balance_usd'] = round(sum(s['balance_cents'] for s in suppliers) / 100)
    # ---------------------------------------------------------------- receipts → orders
    lines_by = collections.defaultdict(list)
    for c in rlines: lines_by[c['RCPT_ID']].append(c)
    pay_by = collections.defaultdict(list)
    for p in rpay: pay_by[p['RCPT_ID']].append(p)
    orders = []; n_payonly = 0; n_mismatch = 0
    for r in receipts:
        rate = num(r['CURR_US']) or default_rate; ll = (r['RCPT_CURR'].strip() or LL) == LL
        ls = [c for c in lines_by.get(r['RCPT_ID'], []) if c['ITM_CODE'] not in ('-1', '0')]
        if not ls: n_payonly += 1; continue
        to_usd = (lambda v: v / rate) if ll else (lambda v: v)
        out_lines, total = [], 0.0
        for c in ls:
            q = num(c['ITM_QUANTITY'], 1); p = to_usd(num(c['ITM_PRICE'])); d = num(c['ITM_DISCOUNT'])
            lt = q * p * (1 - d / 100); total += lt
            out_lines.append({'key': c['ITM_CODE'], 'name': pname.get(c['ITM_CODE'], name(c['DETAILS'] or 'صنف')), 'qty': q, 'unit_cents': cents(p), 'total_cents': cents(lt)})
        disc = to_usd(num(r['RCPT_DISCOUNT'])); total_c = cents(total - disc)
        if abs((total - disc) - to_usd(num(r['RCPT_AMOUNT']))) > 0.05: n_mismatch += 1
        paid = []
        for p in pay_by.get(r['RCPT_ID'], []):
            pc = (p['RCPT_CURR'].strip() or LL); amt = num(p['PAID'])
            if amt <= 0: continue
            paid.append({'tender': 'card' if p['PAYMENT_METHOD'].strip() == '2' else ('cash_lbp' if pc == LL else 'cash_usd'), 'currency': 'lbp' if pc == LL else 'usd', 'amount': int(round(amt)) if pc == LL else cents(amt)})
        client = pmap.get(r['RCPT_CLIENT'])
        # number: RCPT_NO restarts every day in the old POS; RCPT_ID is the unique one
        orders.append({'key': r['RCPT_ID'], 'number': 'M-' + r['RCPT_ID'].strip(), 'at': iso(r['RCPT_DATE']), 'rate': int(rate),
                       'customer_name': client['TITLE'].strip() if client and r['RCPT_CLIENT'] != '1' else None,
                       'customer_phone': phone_clean(client['PHONE']) or None if client and r['RCPT_CLIENT'] != '1' else None,
                       'note': (r['REMARK'] or '').strip() or None, 'discount_cents': cents(disc), 'total_cents': total_c, 'lines': out_lines, 'paid': paid})
    S['orders'] = len(orders); S['receipts_payment_only_skipped'] = n_payonly; S['orders_total_mismatch'] = n_mismatch
    S['orders_date_range'] = [min(o['at'] for o in orders)[:10], max(o['at'] for o in orders)[:10]] if orders else None
    # ---------------------------------------------------------------- purchases
    tl_by = collections.defaultdict(list)
    for c in tlines:
        if c['TRS_TYPE'] == 'P': tl_by[c['TRS_NUMBER']].append(c)
    purchases = []
    for t in trs:
        if t['TRS_TYPE'] != 'P': continue
        rate = num(t['CURR_US']) or default_rate; ll = (t['TRS_CURRENCY'].strip() or LL) == LL
        to_usd = (lambda v: v / rate) if ll else (lambda v: v)
        ls = []
        fixed = 0
        for c in tl_by.get(t['TRS_NUMBER'], []):
            q = num(c['ITM_QUANTITY'], 1) or 1; lt = to_usd(num(c['ITM_TOTAL']))
            if not ll and num(c['ITM_PRICE']) >= 20000:   # an LL price typed on a USD invoice (seen once: 150,000 "USD"): treat the line as LL
                lt = num(c['ITM_TOTAL']) / rate; fixed += 1
            ls.append({'key': c['ITM_CODE'], 'name': pname.get(c['ITM_CODE'], name(c['DETAILS'] or 'صنف')), 'qty': q, 'unit_cost_cents': cents(lt / q)})
        total_usd = to_usd(num(t['TRS_AMOUNT']))
        if fixed: total_usd = sum(l['unit_cost_cents'] * l['qty'] for l in ls) / 100.0; n_fixed_purchases = S.get('purchases_currency_fixed', 0) + 1; S['purchases_currency_fixed'] = n_fixed_purchases
        purchases.append({'key': t['TRS_NUMBER'], 'number': 'M-P' + t['TRS_NUMBER'], 'at': iso(t['TRS_DATE']), 'supplier_key': t['TRS_PartyID'], 'invoice_no': (t['TRS_ORDER'] or '').strip() or None,
                          'rate': int(rate), 'note': ((t['TRS_Remarks'] or '').strip() + (' · عملة مصحّحة' if fixed else '')).strip(' ·') or None, 'total_cents': cents(total_usd), 'lines': ls})
    S['purchases'] = len(purchases); S['purchases_total_usd'] = round(sum(p['total_cents'] for p in purchases) / 100); S['transactions_skipped_S_R_SR'] = sum(1 for t in trs if t['TRS_TYPE'] != 'P')
    # ---------------------------------------------------------------- settings
    sc = {r['Number']: r for r in rd(f'{exp}/ScaleSettings.csv')}
    # ScaleSettings rows 1-5 = first format, 11-15 = second (Flag/Code/Price/Weight/Checksum with Length / Value)
    def fmt(base):
        flag, code, price, weight = sc.get(str(base)), sc.get(str(base + 1)), sc.get(str(base + 2)), sc.get(str(base + 3))
        if not flag or not (flag.get('Value') or '').strip(): return None
        by_weight = weight and int(num(weight.get('Length'))) > 0
        return {'prefix': flag['Value'].strip(), 'code_len': int(num((code or {}).get('Length'), 4)), 'value_kind': 'weight' if by_weight else 'price_lbp', 'value_divisor': 1000 if by_weight else 1}
    f1, f2 = fmt(1), fmt(11)
    settings = [{'scale_prefix': (f1 or {}).get('prefix', '27'), 'scale_code_len': (f1 or {}).get('code_len', 3), 'scale_value_kind': (f1 or {}).get('value_kind', 'price_lbp'), 'scale_value_divisor': (f1 or {}).get('value_divisor', 1),
                 'scale_formats': [f2] if f2 else []}]
    S['scale_formats'] = [f for f in (f1, f2) if f]; S['products_with_margin'] = sum(1 for p in products if p['margin_pct']); S['products_with_supplier'] = sum(1 for p in products if p['supplier_key'])
    return {'product': products, 'customer': customers, 'supplier': suppliers, 'order': orders, 'purchase': purchases, 'settings': settings}, S

ORDER = ['settings', 'product', 'customer', 'supplier', 'order', 'purchase']   # products before history (lines link by key), suppliers before purchases
BATCH = {'product': 500, 'order': 300, 'purchase': 300}

def upload(data, base, shop, secret, dry, only=None):
    totals = {}
    for kind in ORDER:
        if only and kind not in only: continue
        rows = data[kind]; n = BATCH.get(kind, 500); agg = collections.Counter(); samples = []
        for i in range(0, len(rows), n):
            body = json.dumps({'shop': shop, 'kind': kind, 'rows': rows[i:i + n], 'dry_run': dry}).encode()
            req = urllib.request.Request(f'{base}/api/admin/migrate', data=body, headers={'content-type': 'application/json', 'x-suqa-secret': secret}, method='POST')
            for attempt in range(3):
                try:
                    with urllib.request.urlopen(req, timeout=120) as res: out = json.load(res); break
                except urllib.error.HTTPError as e:
                    msg = e.read().decode()[:300]
                    if attempt == 2: print(f'  {kind} batch {i}: HTTP {e.code} {msg}', file=sys.stderr); out = {'errors': len(rows[i:i + n])}; break
                    time.sleep(3)
                except Exception as e:
                    if attempt == 2: raise
                    time.sleep(3)
            for k in ('inserted', 'updated', 'skipped', 'errors'): agg[k] += int(out.get(k, 0))
            samples += out.get('samples', [])[:3]
            print(f'  {kind:9} {min(i + n, len(rows)):6}/{len(rows)}  +{agg["inserted"]} ~{agg["updated"]} ={agg["skipped"]} !{agg["errors"]}', end='\r', flush=True)
        print(); totals[kind] = dict(agg, samples=samples[:5])
    return totals

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--export', default='export'); ap.add_argument('--out', default='out')
    ap.add_argument('--upload', help='site origin, e.g. https://suqa-dev.netlify.app'); ap.add_argument('--shop', help='shop slug'); ap.add_argument('--secret', default=os.environ.get('SUQA_SECRET'))
    ap.add_argument('--dry-run', action='store_true'); ap.add_argument('--only', help='comma-separated kinds to upload (e.g. order,purchase)'); ap.add_argument('--used-only', action='store_true', help='only items with stock or sales/purchase history (skip the "modified in 2 years" rule)')
    a = ap.parse_args()
    t0 = time.time(); data, summary = convert(a.export, two_years=not a.used_only)
    os.makedirs(a.out, exist_ok=True)
    for kind, rows in data.items():
        with open(f'{a.out}/{kind}.jsonl', 'w', encoding='utf-8') as h:
            for r in rows: h.write(json.dumps(r, ensure_ascii=False) + '\n')
    summary['converted_in_s'] = round(time.time() - t0, 1)
    print(json.dumps(summary, ensure_ascii=True, indent=1))
    if a.upload:
        if not (a.shop and a.secret): sys.exit('--upload needs --shop and --secret (or SUQA_SECRET)')
        print(('DRY RUN -> ' if a.dry_run else 'UPLOAD -> ') + a.upload)
        res = upload(data, a.upload.rstrip('/'), a.shop, a.secret, a.dry_run, set(a.only.split(',')) if a.only else None)
        print(json.dumps(res, ensure_ascii=True, indent=1))
        with open(f'{a.out}/upload-result.json', 'w', encoding='utf-8') as h: json.dump({'summary': summary, 'result': res}, h, ensure_ascii=False, indent=1)

if __name__ == '__main__': main()
