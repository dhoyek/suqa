'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { CatalogIndex, type SyncError, type Staff, type SyncEvent, type SyncStatus } from '@suqa/pos-core';
import { pt, type L } from './i18n';
import AccessRequest from './components/AccessRequest';
import { LS_SHOP, bootDevice, downloadJson, myMemberships, subscribePoke, type Booted, type Membership } from './lib/boot';
import LockScreen from './LockScreen';
import Shell from './Shell';
import './pos.css';

type Phase =
  | { k: 'loading' } | { k: 'needSignIn' } | { k: 'chooseShop'; shops: Membership[] } | { k: 'askName'; resolve: (n: string) => void }
  | { k: 'downloading' } | { k: 'error'; msg: string; retry: () => void } | { k: 'locked' } | { k: 'open' } | { k: 'revoked' } | { k: 'noAccess' };

export const LS_LOCALE = 'suqa-pos-locale';
export default function PosApp({ locale: tenantLocale, brand, tenantId }: { locale: L; brand: string; tenantId: string }) {
  // per-device language (Settings → اللغة); falls back to the tenant default
  const [locale, setLocaleState] = useState<L>(tenantLocale);
  useEffect(() => { try { const v = localStorage.getItem(LS_LOCALE); if (v === 'ar' || v === 'en') setLocaleState(v); if (localStorage.getItem('suqa-pos-big') === '1') document.documentElement.classList.add('pos-big'); } catch {} }, []);
  const setLocale = useCallback((l: L) => { setLocaleState(l); try { localStorage.setItem(LS_LOCALE, l); } catch {} }, []);
  const sb = useMemo(() => supabaseBrowser(), []);
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  const [boot, setBoot] = useState<Booted | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [staff, setStaff] = useState<Staff | null>(null);          // who unlocked
  const [tick, setTick] = useState(0);                              // bump when feed rows applied → views re-read
  const [updateReady, setUpdateReady] = useState(false);
  const index = useRef(new CatalogIndex());
  const busyRef = useRef(false);                                    // an open sale / payment dialog → defer the SW update
  const swReg = useRef<ServiceWorkerRegistration | null>(null);

  const onEvent = useCallback((e: SyncEvent) => {
    if (e.type === 'status') {
      setStatus(e.status);
      // the device has local data but the signed-in account is not a member of this shop (someone signed in with
      // another number on this browser): stop showing stale data as if it were fine
      if (e.status.error && /not_a_member/.test(e.status.error)) setPhase(p => p.k === 'noAccess' ? p : { k: 'noAccess' });
    }
    else if (e.type === 'applied') setTick(t => t + 1);
    else if (e.type === 'order.new') { setTick(t => t + 1); void playDing(); }
    else if (e.type === 'revoked') { downloadJson(`suqa-pos-unsynced-${new Date().toISOString().slice(0, 19)}.json`, e.outbox); setPhase({ k: 'revoked' }); }
  }, []);

  const start = useCallback(async () => {
    setPhase({ k: 'loading' });
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { setPhase({ k: 'needSignIn' }); return; }
    const userId = session.user.id;
    let shopId = localStorage.getItem(LS_SHOP);
    if (!shopId) {
      let shops: Membership[];
      try { shops = await myMemberships(sb); }
      catch (e) { setPhase({ k: 'error', msg: (e as Error).message, retry: () => void start() }); return; }
      if (!shops.length) { setPhase({ k: 'noAccess' }); return; }
      if (shops.length > 1) { setPhase({ k: 'chooseShop', shops }); return; }
      shopId = shops[0].shop_id; localStorage.setItem(LS_SHOP, shopId);
    }
    try {
      const b = await bootDevice(sb, shopId, userId, onEvent, () => new Promise<string>(resolve => setPhase({ k: 'askName', resolve: n => { setPhase({ k: 'downloading' }); resolve(n); } })));
      setBoot(b);
      await reloadIndex(b);
      b.engine.start();
      setPhase({ k: 'locked' });
    } catch (e) {
      const err = e as SyncError;
      const msg = err.code === 'device_revoked' ? pt('revokedTitle', locale) : err.code === 'pos_disabled' ? pt('posDisabled', locale)
        : err.code === 'network' ? pt('offlineNoSetup', locale) : err.message;
      if (err.code === 'device_revoked') { setPhase({ k: 'revoked' }); return; }
      // signed in with an account that is not a member of the shop this device was set up for → ask for access
      if (err.code === 'auth' && /not_a_member/.test(err.message)) { localStorage.removeItem(LS_SHOP); setPhase({ k: 'noAccess' }); return; }
      setPhase({ k: 'error', msg, retry: () => void start() });
    }
  }, [sb, locale, onEvent]);

  const reloadIndex = async (b: Booted) => {
    const [ps, bs, cs, qs] = await Promise.all([b.db.products.toArray(), b.db.barcodes.toArray(), b.db.categories.toArray(), b.db.quickButtons.toArray()]);
    index.current.load(ps, bs, cs, qs);
  };

  useEffect(() => { void start(); }, [start]);
  useEffect(() => { if (boot && tick) void reloadIndex(boot).then(() => setTick(t => t)); }, [tick, boot]);   // feed applied → refresh index
  useEffect(() => { if (!boot) return; return subscribePoke(sb, boot.shop.id, boot.engine); }, [boot, sb]);
  useEffect(() => () => { void boot?.engine.stop(); }, [boot]);

  // Service worker: register, watch for a waiting update, apply only when idle.
  useEffect(() => {
    if (!('serviceWorker' in navigator) || process.env.NODE_ENV === 'development') return;
    navigator.serviceWorker.register('/pos-sw.js', { scope: '/pos' }).then(reg => {
      swReg.current = reg;
      const watch = () => { const w = reg.waiting; if (w && navigator.serviceWorker.controller) setUpdateReady(true); };
      watch();
      reg.addEventListener('updatefound', () => { const nw = reg.installing; nw?.addEventListener('statechange', watch); });
      setInterval(() => void reg.update(), 30 * 60_000);
    }).catch(() => undefined);
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
  }, []);
  const applyUpdate = useCallback(() => { swReg.current?.waiting?.postMessage({ type: 'SKIP_WAITING' }); }, []);
  useEffect(() => {
    if (!updateReady) return;
    const t = setInterval(() => { if (!busyRef.current && phase.k === 'locked') applyUpdate(); }, 60_000);   // idle on the lock screen → auto-apply
    return () => clearInterval(t);
  }, [updateReady, phase.k, applyUpdate]);

  // ---- phases ----
  if (phase.k === 'loading' || phase.k === 'downloading') return <Center><div className="brand">{brand}</div><p className="muted">{pt(phase.k === 'downloading' ? 'downloading' : 'loading', locale)}</p></Center>;
  if (phase.k === 'needSignIn') return <Center><div className="brand">{brand}</div><p>{pt('signInNeeded', locale)}</p><a className="btn primary" href="/login?next=/pos">{pt('signIn', locale)}</a></Center>;
  if (phase.k === 'chooseShop') return (
    <Center><div className="brand">{brand}</div><h2>{pt('chooseShop', locale)}</h2>
      <div className="stack">{phase.shops.map(m => <button key={m.shop_id} className="btn big" onClick={() => { localStorage.setItem(LS_SHOP, m.shop_id); void start(); }}>{m.shop.name[locale] ?? m.shop.name.ar ?? m.shop.name.en}</button>)}</div>
    </Center>);
  if (phase.k === 'noAccess') return <AccessRequest sb={sb} locale={locale} brand={brand} tenantId={tenantId} onRetry={() => void start()} />;
  if (phase.k === 'askName') return <AskName locale={locale} brand={brand} onDone={phase.resolve} />;
  if (phase.k === 'error') return <Center><div className="brand">{brand}</div><p className="bad">{phase.msg}</p><button className="btn" onClick={phase.retry}>{pt('retry', locale)}</button><a className="btn ghost" href="/shop">{pt('backToShop', locale)}</a></Center>;
  if (phase.k === 'revoked') return <Center><div className="brand">{brand}</div><h2>{pt('revokedTitle', locale)}</h2><p className="muted">{pt('revokedBody', locale)}</p><a className="btn" href="/shop">{pt('backToShop', locale)}</a></Center>;
  if (!boot) return null;
  if (phase.k === 'locked') return <LockScreen boot={boot} sb={sb} locale={locale} status={status} onUnlock={s => { setStaff(s); setPhase({ k: 'open' }); }} />;
  return (
    <Shell boot={boot} sb={sb} locale={locale} setLocale={setLocale} status={status} staff={staff!} index={index.current} tick={tick} updateReady={updateReady} onUpdate={applyUpdate}
      busyRef={busyRef} onLock={() => { setStaff(null); setPhase({ k: 'locked' }); }} reindex={() => setTick(t => t + 1)} />
  );
}

function Center({ children }: { children: React.ReactNode }) { return <main className="pos-center"><div className="card stack" style={{ textAlign: 'center', maxWidth: 420, width: '100%' }}>{children}</div></main>; }

function AskName({ locale, brand, onDone }: { locale: L; brand: string; onDone: (n: string) => void }) {
  const [name, setName] = useState('');
  return (
    <Center>
      <div className="brand">{brand}</div>
      <p className="muted">{pt('firstSetup', locale)}</p>
      <label className="label">{pt('deviceName', locale)}</label>
      <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder={pt('deviceNameHint', locale)} autoFocus />
      <button className="btn primary big" disabled={!name.trim()} onClick={() => onDone(name.trim())}>{pt('register', locale)}</button>
    </Center>
  );
}

let audio: AudioContext | null = null;
async function playDing() {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator(); const g = audio.createGain();
    o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.2; o.connect(g); g.connect(audio.destination);
    o.start(); o.frequency.setValueAtTime(1320, audio.currentTime + 0.12); o.stop(audio.currentTime + 0.3);
  } catch { /* no audio */ }
}
