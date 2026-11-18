'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

/**
 * "Install the app" for the storefront (a PWA — no app store).
 *  - Android Chrome/Samsung: catches the browser's install event and shows our own one-tap Install button.
 *  - iPhone/iPad: Apple has no install button for websites, so we show a short Share → Add to Home Screen guide.
 *  - Inside WhatsApp / Facebook / Instagram browsers: installing is impossible there, so we offer "Open in Chrome/Safari".
 * Shown on its own only after the first order or on a second visit, never again for 14 days after "Not now",
 * and never when the site is already running as an installed app. <InstallLink/> opens it on demand.
 * Also registers the storefront service worker (/sw.js — fast loading + a proper offline screen).
 */

type Mode = 'android' | 'ios' | 'inapp-android' | 'inapp-ios' | 'other';
type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

const K_DISMISSED = 'suqa_install_dismissed_at';
const K_VISITS = 'suqa_visits';
const K_ORDERED = 'suqa_ordered';
const SS_COUNTED = 'suqa_visit_counted';
const SNOOZE_MS = 14 * 24 * 3600 * 1000;
const OPEN_EVENT = 'suqa:install-open';

function store(kind: 'local' | 'session'): Storage | null {
  try { return kind === 'local' ? window.localStorage : window.sessionStorage; } catch { return null; }
}
function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}
function detect(): Mode {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  // In-app browsers that block installing. "; wv)" is the Android WebView marker most in-app browsers carry.
  const inApp = /FBAN|FBAV|FB_IAB|FBIOS|Instagram|WhatsApp|Line\/|Snapchat|musical_ly|BytedanceWebview|TikTok|; wv\)/i.test(ua);
  if (inApp && ios) return 'inapp-ios';
  if (inApp && android) return 'inapp-android';
  if (ios) return 'ios';
  if (android) return 'android';
  return 'other';
}

const T = {
  en: {
    getApp: (b: string) => `Get the ${b} app`,
    androidBody: 'Install it on your phone in one tap — no app store, almost no space.',
    install: 'Install', notNow: 'Not now', close: 'Close',
    iosTitle: (b: string) => `Add ${b} to your Home Screen`,
    iosStep1: 'Tap the Share button', iosStep1b: '(bottom of Safari, or top right in Chrome)',
    iosStep2: 'Scroll and choose “Add to Home Screen”', iosStep3: 'Tap “Add” — the app icon appears on your phone',
    inappTitle: (br: string) => `Open in ${br} to install the app`,
    inappBody: 'You are inside another app’s browser (WhatsApp, Facebook…). Installing works only from your phone’s own browser.',
    openIn: (br: string) => `Open in ${br}`, orMenu: (br: string) => `Or tap ⋯ at the top and choose “Open in ${br}”.`,
    copy: 'Copy link', copied: '✓ Copied',
    otherTitle: (b: string) => `Install ${b}`,
    otherBody: 'Open your browser menu and choose “Install app” or “Add to Home screen”.',
  },
  ar: {
    getApp: (b: string) => `حمّل تطبيق ${b}`,
    androidBody: 'ثبّته على هاتفك بكبسة واحدة، بلا متجر تطبيقات وبلا مساحة تقريباً.',
    install: 'تثبيت', notNow: 'ليس الآن', close: 'إغلاق',
    iosTitle: (b: string) => `أضف ${b} إلى الشاشة الرئيسية`,
    iosStep1: 'اضغط زر المشاركة', iosStep1b: '(أسفل سفاري، أو أعلى اليمين في كروم)',
    iosStep2: 'انزل واختر «إضافة إلى الشاشة الرئيسية»', iosStep3: 'اضغط «إضافة» — تظهر أيقونة التطبيق على هاتفك',
    inappTitle: (br: string) => `افتح الرابط في ${br} لتثبيت التطبيق`,
    inappBody: 'أنت داخل متصفح تطبيق آخر (واتساب، فيسبوك…). التثبيت يعمل فقط من متصفح هاتفك.',
    openIn: (br: string) => `افتح في ${br}`, orMenu: (br: string) => `أو اضغط ⋯ في الأعلى واختر «فتح في ${br}».`,
    copy: 'نسخ الرابط', copied: '✓ تم النسخ',
    otherTitle: (b: string) => `ثبّت ${b}`,
    otherBody: 'افتح قائمة المتصفح واختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».',
  },
};

const ShareIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0A84FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ verticalAlign: 'middle' }}>
    <path d="M12 3v12" /><path d="m7 8 5-5 5 5" /><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
  </svg>
);
const PlusIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden style={{ verticalAlign: 'middle' }}>
    <rect x="3" y="3" width="18" height="18" rx="4" /><path d="M12 8v8M8 12h8" />
  </svg>
);

export default function InstallApp({ brand, locale, iconUrl }: { brand: string; locale: 'ar' | 'en'; iconUrl?: string | null }) {
  const t = T[locale];
  const pathname = usePathname();
  const [mode, setMode] = useState<Mode | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const deferred = useRef<BIPEvent | null>(null);
  const [canPrompt, setCanPrompt] = useState(false);

  // service worker (production only; the POS keeps its own worker under /pos)
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    if (window.location.pathname.startsWith('/pos')) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* not critical */ });
  }, []);

  // one-time setup: detection, visit counting, install events, on-demand open
  useEffect(() => {
    if (isStandalone()) return;            // already installed and running as the app
    const m = detect();
    setMode(m);
    const ls = store('local'), ss = store('session');
    if (ss && !ss.getItem(SS_COUNTED)) { ss.setItem(SS_COUNTED, '1'); ls?.setItem(K_VISITS, String(Number(ls.getItem(K_VISITS) ?? '0') + 1)); }

    const onBIP = (e: Event) => { e.preventDefault(); deferred.current = e as BIPEvent; setCanPrompt(true); };
    const onInstalled = () => { deferred.current = null; setCanPrompt(false); setOpen(false); ls?.setItem(K_DISMISSED, String(Date.now() + 3650 * 24 * 3600 * 1000)); };
    const onOpen = () => setOpen(true);
    window.addEventListener('beforeinstallprompt', onBIP);
    window.addEventListener('appinstalled', onInstalled);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => { window.removeEventListener('beforeinstallprompt', onBIP); window.removeEventListener('appinstalled', onInstalled); window.removeEventListener(OPEN_EVENT, onOpen); };
  }, []);

  // remember that this person has ordered (order pages), so we may offer the app
  useEffect(() => { if (pathname?.startsWith('/orders/')) store('local')?.setItem(K_ORDERED, '1'); }, [pathname]);

  // automatic offer: after the first order or on the second visit, unless snoozed
  useEffect(() => {
    if (!mode || mode === 'other') return;
    if (mode === 'android' && !canPrompt) return;       // Chrome decides when installing is possible
    if (pathname?.startsWith('/checkout')) return;     // never interrupt a checkout
    const ls = store('local');
    const snoozed = Number(ls?.getItem(K_DISMISSED) ?? '0');
    if (snoozed && Date.now() - snoozed < SNOOZE_MS) return;
    const eligible = ls?.getItem(K_ORDERED) === '1' || Number(ls?.getItem(K_VISITS) ?? '0') >= 2;
    if (!eligible) return;
    const id = setTimeout(() => setOpen(true), 2500);
    return () => clearTimeout(id);
  }, [mode, canPrompt, pathname]);

  if (!open || !mode) return null;

  const snooze = () => { store('local')?.setItem(K_DISMISSED, String(Date.now())); setOpen(false); };
  async function install() {
    const e = deferred.current;
    if (!e) return;
    await e.prompt();
    const { outcome } = await e.userChoice;
    deferred.current = null; setCanPrompt(false); setOpen(false);
    if (outcome === 'dismissed') store('local')?.setItem(K_DISMISSED, String(Date.now()));
  }
  function openInBrowser() {
    const { host, pathname: p, search } = window.location;
    if (mode === 'inapp-android') {
      window.location.href = `intent://${host}${p}${search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(window.location.href)};end`;
    } else {
      window.location.href = `x-safari-https://${host}${p}${search}`;   // iOS 17+; older phones use the ⋯ menu
    }
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(window.location.href); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* link stays visible in the address bar */ }
  }

  const browser = mode === 'inapp-ios' ? (locale === 'ar' ? 'سفاري' : 'Safari') : (locale === 'ar' ? 'كروم' : 'Chrome');
  // eslint-disable-next-line @next/next/no-img-element
  const icon = <img src={iconUrl || '/icons/icon-192.png'} alt="" width={48} height={48} style={{ borderRadius: 12, flex: 'none' }} />;

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={t.getApp(brand)} onClick={snooze} data-install-mode={mode}>
      {(mode === 'inapp-android' || mode === 'inapp-ios') && (
        <div aria-hidden style={{ position: 'fixed', top: 6, right: 14, color: '#fff', fontSize: 40, lineHeight: 1, textShadow: '0 2px 6px rgba(0,0,0,.5)', animation: 'install-bob 1.2s ease-in-out infinite' }}>↗</div>
      )}
      <div className="panel stack" style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }} onClick={e => e.stopPropagation()}>
        {mode === 'android' && <>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>{icon}<div><b>{t.getApp(brand)}</b><div className="muted" style={{ fontSize: 14 }}>{t.androidBody}</div></div></div>
          <div style={{ display: 'flex', gap: 8 }}>
            {canPrompt
              ? <button type="button" className="btn primary" style={{ flex: 1 }} onClick={install}>{t.install}</button>
              : <div className="muted" style={{ fontSize: 14, flex: 1 }}>{t.otherBody}</div>}
            <button type="button" className="btn" onClick={snooze}>{t.notNow}</button>
          </div>
        </>}

        {mode === 'ios' && <>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>{icon}<b>{t.iosTitle(brand)}</b></div>
          <ol style={{ margin: 0, paddingInlineStart: 22, display: 'grid', gap: 10 }}>
            <li>{t.iosStep1} <ShareIcon /> <span className="muted" style={{ fontSize: 13 }}>{t.iosStep1b}</span></li>
            <li>{t.iosStep2} <PlusIcon /></li>
            <li>{t.iosStep3}</li>
          </ol>
          <button type="button" className="btn wide" onClick={snooze}>{t.notNow}</button>
        </>}

        {(mode === 'inapp-android' || mode === 'inapp-ios') && <>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>{icon}<b>{t.inappTitle(browser)}</b></div>
          <div className="muted" style={{ fontSize: 14 }}>{t.inappBody}</div>
          <button type="button" className="btn primary wide" onClick={openInBrowser}>{t.openIn(browser)}</button>
          <div className="muted" style={{ fontSize: 13 }}>{t.orMenu(browser)}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn" style={{ flex: 1 }} onClick={copyLink}>{copied ? t.copied : t.copy}</button>
            <button type="button" className="btn" style={{ flex: 1 }} onClick={snooze}>{t.notNow}</button>
          </div>
        </>}

        {mode === 'other' && <>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>{icon}<b>{t.otherTitle(brand)}</b></div>
          {canPrompt
            ? <button type="button" className="btn primary wide" onClick={install}>{t.install}</button>
            : <div className="muted" style={{ fontSize: 14 }}>{t.otherBody}</div>}
          <button type="button" className="btn wide" onClick={() => setOpen(false)}>{t.close}</button>
        </>}
      </div>
    </div>
  );
}

/** Small "Install the app" link (footer). Hidden when already running as the installed app. */
export function InstallLink({ label }: { label: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => { setShow(!isStandalone()); }, []);
  if (!show) return null;
  return (<>·
    <button type="button" onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}
      style={{ background: 'none', border: 0, padding: 0, color: 'inherit', font: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>
      📲 {label}
    </button>
  </>);
}
