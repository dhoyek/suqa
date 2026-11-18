'use client';
import { useState } from 'react';

/** Share a page of the site: the phone's share sheet when there is one (WhatsApp contacts and groups, and every other app),
 *  otherwise WhatsApp's own "send to…" picker. `whatsapp` forces the WhatsApp picker; `copy` adds a copy-link button. */
export default function ShareButton({ path, text, label, locale, whatsapp, copy, className = 'btn', iconOnly }: {
  path: string; text: string; label: string; locale: 'ar' | 'en'; whatsapp?: boolean; copy?: boolean; className?: string; iconOnly?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const url = () => new URL(path, window.location.origin).toString();
  const wa = () => window.open(`https://wa.me/?text=${encodeURIComponent(`${text}\n${url()}`)}`, '_blank', 'noopener');
  async function share() {
    if (whatsapp) return wa();
    if (navigator.share) { try { await navigator.share({ title: text, text, url: url() }); } catch { /* closed by the person */ } return; }
    wa();
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(url()); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* no clipboard: the link is on screen anyway */ }
  }
  return (
    <>
      <button type="button" className={className} onClick={e => { e.preventDefault(); e.stopPropagation(); void share(); }} aria-label={label} title={label}>
        {whatsapp
          ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ verticalAlign: 'middle', flex: 'none' }}><path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20.5l1.6-5.2A8.5 8.5 0 1 1 21 11.5Z" /></svg>
          : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ verticalAlign: 'middle', flex: 'none' }}><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></svg>}
        {!iconOnly && <> {label}</>}
      </button>
      {copy && <button type="button" className="btn" onClick={copyLink}>{copied ? (locale === 'ar' ? '✓ تم النسخ' : '✓ Copied') : (locale === 'ar' ? '🔗 نسخ الرابط' : '🔗 Copy link')}</button>}
    </>
  );
}
