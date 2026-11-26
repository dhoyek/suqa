'use client';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CatalogIndex, Staff, SyncStatus } from '@suqa/pos-core';
import { pt, type L } from './i18n';
import type { Booted } from './lib/boot';
import { fmtTime } from './lib/boot';
import AccountMenu from './components/AccountMenu';
import YorgoPanel, { type YorgoCartLine } from './components/YorgoPanel';
import { recordStockMove } from '@suqa/pos-core';
import { initApproval, refreshApproval } from './lib/approval';
import { roleOf, viewsFor } from './lib/perm';
import { newOrderChime } from './lib/chime';
import Modal from './components/Modal';
import { loadNotices, markNoticesRead, syncNotices, type Notice } from './lib/notices';
import Sell from './views/Sell';
import SettingsView from './views/SettingsView';
import ShiftView from './views/ShiftView';
import ReportsView from './views/ReportsView';
import DriversView from './views/DriversView';
import ItemsView from './views/ItemsView';
import StockView from './views/StockView';
import OrdersView from './views/OrdersView';
import DebtsView from './views/DebtsView';
import PinGate from './components/PinGate';
import CustomersView from './views/CustomersView';
import PushReminder from './components/PushReminder';
import PurchasesView from './views/PurchasesView';

export type View = 'sell' | 'orders' | 'customers' | 'debts' | 'items' | 'stock' | 'purchases' | 'shift' | 'reports' | 'drivers' | 'settings';
const VIEWS: View[] = ['sell', 'orders', 'customers', 'debts', 'items', 'stock', 'purchases', 'shift', 'reports', 'drivers', 'settings'];
// the menu in groups by how often they are used: every day · people · goods · back office (a thin line between groups)
const GROUP: Record<View, number> = { sell: 0, orders: 0, shift: 0, debts: 0, customers: 1, drivers: 1, items: 2, stock: 2, purchases: 2, reports: 3, settings: 3 };
const ICON: Record<View, string> = { sell: '🧾', orders: '📥', customers: '👥', debts: '📒', items: '🏷️', stock: '📦', purchases: '🚚', shift: '💵', reports: '📊', drivers: '🛵', settings: '⚙️' };
const LABEL: Record<View, Parameters<typeof pt>[0]> = { sell: 'sell', orders: 'ordersNav', customers: 'customersNav', debts: 'debtsNav', items: 'items', stock: 'stock', purchases: 'purchasesNav', shift: 'shift', reports: 'reports', drivers: 'driversNav', settings: 'settings' };

/** One page, several views (no route changes → nothing to fetch when offline). The view is mirrored into #hash. */
export default function Shell(props: {
  boot: Booted; sb: SupabaseClient; locale: L; status: SyncStatus | null; staff: Staff; index: CatalogIndex; tick: number;
  updateReady: boolean; onUpdate: () => void; busyRef: MutableRefObject<boolean>; onLock: () => void; reindex: () => void; setLocale: (l: L) => void;
}) {
  const { boot, locale, status, staff, updateReady, onUpdate, onLock } = props;
  const [view, setView] = useState<View>(() => (VIEWS.includes(location.hash.slice(1) as View) ? (location.hash.slice(1) as View) : (() => { try { return localStorage.getItem('suqa-pos-start') === 'orders' ? 'orders' : 'sell'; } catch { return 'sell'; } })()));   // the device's start screen (Settings → this device)
  useEffect(() => { history.replaceState(null, '', `#${view}`); }, [view]);
  // the shop's approval PIN: cached copy first, then the server's (again whenever the till comes back online)
  useEffect(() => { void initApproval(props.sb, boot.db, boot.shop.id); }, [props.sb, boot]);
  useEffect(() => { if (status?.online) void refreshApproval(); }, [status?.online]);
  useEffect(() => { document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'; }, [locale]);
  const [pendingCount, setPendingCount] = useState(0);
  // new online/WhatsApp orders: badge on the nav + a chime when the pending count grows (any view, any tab)
  const seenPending = useRef<Set<string> | null>(null);
  useEffect(() => { boot.db.orders.where('status').equals('pending').toArray().then(os => {
    setPendingCount(os.length);
    const ids = new Set(os.map(o => o.id));
    if (seenPending.current && [...ids].some(id => !seenPending.current!.has(id))) { newOrderChime(); document.title = `(${os.length}) ${document.title.replace(/^\(\d+\) /, '')}`; }
    else if (!os.length) document.title = document.title.replace(/^\(\d+\) /, '');
    seenPending.current = ids;
  }); }, [boot, props.tick]);
  // 🔔 what came in, on any screen: new orders, a driver's confirmation / pick-up / delivery, a pickup customer on his way
  const [notices, setNotices] = useState<Notice[]>(() => loadNotices(boot.shop.id)?.items ?? []); const [bellOpen, setBellOpen] = useState(false);
  const viewRef = useRef(view); viewRef.current = view;
  useEffect(() => { boot.db.orders.toArray().then(os => {
    const { store, fresh } = syncNotices(boot.shop.id, os);
    setNotices(store.items);
    // the orders board has its own sound for these; a new order already chimes above
    if (fresh.some(f => f.kind !== 'new') && viewRef.current !== 'orders') newOrderChime();
  }); }, [boot, props.tick]);
  const unread = notices.filter(n => !n.read).length;
  const openBell = () => { setBellOpen(true); };
  const closeBell = () => { setBellOpen(false); const s = markNoticesRead(boot.shop.id); if (s) setNotices(s.items); };
  const noticeText = (n: Notice) => n.kind === 'new' ? `🛒 ${pt('ntNew', locale)}` : n.kind === 'ack' ? `🛵✅ ${pt('driverAcked', locale)}` : n.kind === 'picked' ? `📦 ${pt('driverPicked', locale)}` : n.kind === 'delivered' ? `🏠 ${pt('driverDelivered', locale)}` : `🚶 ${pt('customerComing', locale)}`;
  const online = status?.online ?? true;
  const [manual, setManual] = useState(false);
  const [newOrderReq, setNewOrderReq] = useState(0);
  const [preset, setPreset] = useState<{ phone: string; name: string } | null>(null);
  const allowed = viewsFor(roleOf(staff));
  useEffect(() => { if (!allowed.includes(view)) setView(allowed[0] ?? 'sell'); }, [allowed, view]); // eslint-disable-line react-hooks/exhaustive-deps
  const [custFocus, setCustFocus] = useState<{ phone: string; name: string; n: number } | null>(null);
  const [stockFocus, setStockFocus] = useState<{ id: string; n: number } | null>(null);
  const [purPreset, setPurPreset] = useState<{ supplierId: string | null; items: { id: string; qty: number }[]; n: number } | null>(null);
  const canStock = viewsFor(roleOf(staff)).includes('stock');
  const [orderFocus, setOrderFocus] = useState<{ id: string; n: number; detail?: boolean } | null>(null);
  const openOrder = (id: string, detail?: boolean) => { setOrderFocus(f => ({ id, detail, n: (f?.n ?? 0) + 1 })); setView('orders'); };
  const openCustomer = (phone: string, name: string) => { setCustFocus(f => ({ phone, name, n: (f?.n ?? 0) + 1 })); setView('customers'); };
  const [menu, setMenu] = useState(false);
  // Yorgo, the assistant: shown when the association switched it on for this shop and this person sells. The answer is remembered on the
  // device so the button does not come and go; the assistant itself needs internet, the till never waits for it.
  const yorgoKey = `suqa-yorgo-${boot.shop.id}`;
  const [yorgoOn, setYorgoOn] = useState<boolean>(() => { try { return localStorage.getItem(yorgoKey) === '1'; } catch { return false; } });
  const [yorgoOpen, setYorgoOpen] = useState(false);
  const [yorgoCart, setYorgoCart] = useState<{ lines: YorgoCartLine[]; conversation: string | null; order?: boolean; n: number } | null>(null);
  useEffect(() => { if (!online) return; let on = true;
    props.sb.from('yorgo_shops').select('enabled').eq('shop_id', boot.shop.id).maybeSingle().then(({ data, error }) => { if (!on || error) return; const v = !!(data as { enabled?: boolean } | null)?.enabled; setYorgoOn(v); try { localStorage.setItem(yorgoKey, v ? '1' : '0'); } catch { /* private mode */ } });
    return () => { on = false; }; }, [props.sb, boot.shop.id, online, yorgoKey]);
  const canYorgo = yorgoOn;                                                       // every role may ask about items; drafts are for those who sell (the server decides)
  const yorgoSells = roleOf(staff) === 'owner' || roleOf(staff) === 'cashier';
  const go = (v: View) => { setView(v); setMenu(false); };
  // leaving الدين locks it again; coming back within the grace does not ask twice
  const DEBT_GRACE_MS = 5 * 60_000; const debtUntil = useRef(0); const [debtOk, setDebtOk] = useState(false);
  useEffect(() => { setDebtOk(view === 'debts' && Date.now() < debtUntil.current); }, [view]);                      // user pressed sync → show the icon turning briefly
  const spinning = manual || (!!status?.syncing && (status?.pending ?? 0) > 0);   // background pulls stay silent
  const syncNow = () => { setManual(true); boot.engine.poke(); setTimeout(() => setManual(false), 1500); };

  // an account that can open several shops always sees which one this is (an admin must never edit the wrong shop)
  const shopName = boot.shop.name?.[locale] ?? boot.shop.name?.ar ?? boot.shop.name?.en ?? '';
  const multiShop = (() => { try { return localStorage.getItem('suqa-pos-multi') === '1'; } catch { return false; } })();

  return (
    <div className="pos" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <header className="pos-bar">
        <button className="btn icon pos-menu-btn" aria-label="menu" onClick={() => setMenu(m => !m)}>☰{pendingCount > 0 && view !== 'orders' && <span className="nav-badge">{pendingCount}</span>}</button>
        <span className="pos-menu-current">{ICON[view]} {pt(LABEL[view], locale)}</span>
        <nav className={`pos-nav ${menu ? 'open' : ''}`} onClick={e => { if (e.target === e.currentTarget) setMenu(false); }}>
          {viewsFor(roleOf(staff)).map((v, i, all) => <button key={v} className={`${view === v ? 'active' : ''}${i > 0 && GROUP[all[i - 1]] !== GROUP[v] ? ' nav-group' : ''}`} onClick={() => go(v)}><span className="ico">{ICON[v]}{v === 'orders' && pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}</span><span>{pt(LABEL[v], locale)}</span></button>)}
        </nav>
        <div className="pos-status">
          {multiShop && <span className="pill pos-shopname" title={shopName}>🏪 {shopName}</span>}
          <span className={`pill status ${online ? 'ok' : 'warn'}`} title={`${pt('lastSync', locale)}: ${fmtTime(status?.lastSyncAt, locale)}`}>
            <span className={`dot ${online ? 'on' : ''}`} />{online ? pt('online', locale) : pt('offline', locale)}
          </span>
          {!!status?.pending && <span className="pill">{status.pending} {pt('pending', locale)}</span>}
          {canYorgo && <button className="btn yorgo-btn" title={pt('yorgoOpen', locale)} onClick={() => setYorgoOpen(true)}>✨<span className="yorgo-btn-label"> Yorgo</span></button>}
          <button className="btn icon pos-bell" title={pt('ntTitle', locale)} onClick={openBell}>🔔{unread > 0 && <span className="nav-badge">{unread}</span>}</button>
          <button className={`btn icon sync ${spinning ? 'spin' : ''}`} title={pt('syncNow', locale)} onClick={syncNow}>🔄</button>
          <AccountMenu sb={props.sb} boot={boot} staff={staff} locale={locale} setLocale={props.setLocale} onLock={onLock} />
        </div>
      </header>
      {bellOpen && <Modal open onClose={closeBell} title={`🔔 ${pt('ntTitle', locale)}`}>
        {!notices.length && <p className="muted">{pt('ntNone', locale)}</p>}
        <div className="notice-list">{notices.map(n => (
          <button key={n.key} type="button" className={`notice ${n.read ? '' : 'unread'}`} onClick={() => { closeBell(); setView('orders'); }}>
            <span className="notice-main"><strong>{noticeText(n)}</strong><span> · <bdi dir="ltr">{n.number}</bdi>{n.who ? ` · ${n.who}` : ''}</span></span>
            <span className="muted notice-time">{fmtTime(n.at, locale)}</span>
          </button>))}</div>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>{pt('ntHint', locale)}</p>
      </Modal>}
      {updateReady && <div className="pos-update"><span>{pt('updateReady', locale)}</span><button className="btn primary" onClick={onUpdate}>{pt('updateNow', locale)}</button></div>}
      {view === 'sell' && pendingCount > 0 && <button className="pos-neworder" onClick={() => setView('orders')}>🛎 {pendingCount} {pt('newOrderBanner', locale)} · {pt('openOrders', locale)} ›</button>}
      {(view === 'sell' || view === 'orders') && roleOf(staff) !== 'setup' && <PushReminder sb={props.sb} shopId={boot.shop.id} locale={locale} online={online}
        label={`${staff.display_name || staff.full_name || ''} · ${typeof navigator === 'undefined' ? '' : navigator.userAgent.match(/\(([^;)]+)/)?.[1] ?? ''}`.slice(0, 80)} />}
      <main className="pos-main">
        {view === 'sell' && <Sell {...props} onGo={setView} onOrder={openOrder} onStock={canStock ? id => { setStockFocus(f => ({ id, n: (f?.n ?? 0) + 1 })); setView('stock'); } : undefined} newOrderRequest={newOrderReq} presetCustomer={preset} yorgoCart={yorgoCart} onYorgoTaken={() => setYorgoCart(null)} />}
        {view === 'orders' && <OrdersView {...props} focus={orderFocus} onNewOrder={() => { setPreset(null); setNewOrderReq(n => n + 1); setView('sell'); }} onCustomer={openCustomer} />}
        {view === 'customers' && <CustomersView {...props} focus={custFocus} onNewOrder={c => { setPreset(c); setNewOrderReq(n => n + 1); setView('sell'); }} />}
        {/* الدين: the signed-in person's own PIN again each time it is opened (a short grace after a correct one) */}
        {view === 'debts' && (debtOk ? <DebtsView {...props} onCustomer={openCustomer} /> : <PinGate locale={locale} me={staff} title={pt('debtsNav', locale)} onOk={() => { debtUntil.current = Date.now() + DEBT_GRACE_MS; setDebtOk(true); }} onCancel={() => setView('sell')} />)}
        {view === 'items' && <ItemsView {...props} />}
        {view === 'stock' && <StockView {...props} online={online} focus={stockFocus} onReorder={allowed.includes('purchases') ? (supplierId, items) => { setPurPreset(p => ({ supplierId, items, n: (p?.n ?? 0) + 1 })); setView('purchases'); } : undefined} />}
        {view === 'purchases' && <PurchasesView {...props} preset={purPreset} />}
        {view === 'shift' && <ShiftView {...props} />}
        {view === 'reports' && <ReportsView {...props} />}
        {view === 'drivers' && <DriversView {...props} />}
        {view === 'settings' && <SettingsView {...props} />}
      </main>
      {canYorgo && <YorgoPanel open={yorgoOpen} onClose={() => setYorgoOpen(false)} shopId={boot.shop.id} locale={locale} index={props.index} online={online} sells={yorgoSells} sb={props.sb as never} canReview={['owner', 'stock', 'setup'].includes(roleOf(staff) ?? '')}
        onApplyCount={['owner', 'stock'].includes(roleOf(staff) ?? '') ? async lines => {
          // the till's own stock count, one move per item, from the shelf figure of THIS moment (a count is absolute: writing it twice changes nothing)
          for (const l of lines) { const p = await boot.db.products.get(l.id); if (p && p.track_stock) await recordStockMove(boot.db, p, { kind: 'count', qty: l.counted, note: 'Yorgo', user_id: staff.user_id }); }
          props.reindex(); boot.engine.poke();
        } : undefined}
        onAddToCart={(lines, conversation, order) => { setYorgoCart(c => ({ lines, conversation, order, n: (c?.n ?? 0) + 1 })); setYorgoOpen(false); setView('sell'); }} />}
    </div>
  );
}
