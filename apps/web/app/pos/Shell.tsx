'use client';
import { useEffect, useState, type MutableRefObject } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CatalogIndex, Staff, SyncStatus } from '@suqa/pos-core';
import { pt, type L } from './i18n';
import type { Booted } from './lib/boot';
import { fmtTime } from './lib/boot';
import Sell from './views/Sell';
import SettingsView from './views/SettingsView';
import ShiftView from './views/ShiftView';
import ReportsView from './views/ReportsView';
import ItemsView from './views/ItemsView';
import StockView from './views/StockView';

export type View = 'sell' | 'orders' | 'items' | 'stock' | 'shift' | 'reports' | 'settings';
const VIEWS: View[] = ['sell', 'orders', 'items', 'stock', 'shift', 'reports', 'settings'];
const ICON: Record<View, string> = { sell: '🧾', orders: '📥', items: '🏷️', stock: '📦', shift: '💵', reports: '📊', settings: '⚙️' };
const LABEL: Record<View, Parameters<typeof pt>[0]> = { sell: 'sell', orders: 'ordersNav', items: 'items', stock: 'stock', shift: 'shift', reports: 'reports', settings: 'settings' };

/** One page, several views (no route changes → nothing to fetch when offline). The view is mirrored into #hash. */
export default function Shell(props: {
  boot: Booted; sb: SupabaseClient; locale: L; status: SyncStatus | null; staff: Staff; index: CatalogIndex; tick: number;
  updateReady: boolean; onUpdate: () => void; busyRef: MutableRefObject<boolean>; onLock: () => void; reindex: () => void;
}) {
  const { boot, locale, status, staff, updateReady, onUpdate, onLock } = props;
  const [view, setView] = useState<View>(() => (VIEWS.includes(location.hash.slice(1) as View) ? (location.hash.slice(1) as View) : 'sell'));
  useEffect(() => { history.replaceState(null, '', `#${view}`); }, [view]);
  const online = status?.online ?? true;

  return (
    <div className="pos" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <header className="pos-bar">
        <nav className="pos-nav">
          {VIEWS.map(v => <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}><span className="ico">{ICON[v]}</span><span>{pt(LABEL[v], locale)}</span></button>)}
        </nav>
        <div className="pos-status">
          <span className={`pill status ${online ? 'ok' : 'warn'}`} title={`${pt('lastSync', locale)}: ${fmtTime(status?.lastSyncAt, locale)}`}>
            <span className={`dot ${online ? 'on' : ''}`} />{online ? pt('online', locale) : pt('offline', locale)}
          </span>
          {!!status?.pending && <span className="pill">{status.pending} {pt('pending', locale)}</span>}
          {!!status?.rejected && <span className="pill bad">{status.rejected} {pt('rejected', locale)}</span>}
          <button className={`btn icon sync ${status?.syncing ? 'spin' : ''}`} title={status?.syncing ? pt('syncing', locale) : pt('syncNow', locale)} onClick={() => boot.engine.poke()} aria-busy={!!status?.syncing}>🔄</button>
          <span className="muted" style={{ fontSize: 13 }}>{staff.display_name || staff.full_name || ''}</span>
          <button className="btn icon" title={pt('lock', locale)} onClick={onLock}>🔒</button>
        </div>
      </header>
      {updateReady && <div className="pos-update"><span>{pt('updateReady', locale)}</span><button className="btn primary" onClick={onUpdate}>{pt('updateNow', locale)}</button></div>}
      <main className="pos-main">
        {view === 'sell' && <Sell {...props} onGo={setView} />}
        {view === 'items' && <ItemsView {...props} />}
        {view === 'stock' && <StockView {...props} />}
        {view === 'shift' && <ShiftView {...props} />}
        {view === 'reports' && <ReportsView {...props} />}
        {view === 'settings' && <SettingsView {...props} />}
        {view === 'orders' && <div className="card muted" style={{ margin: 16 }}>{pt('comingSoon', locale)}</div>}
      </main>
    </div>
  );
}
