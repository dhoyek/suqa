import Link from 'next/link';
import type { ReactNode } from 'react';

// Shared shell for the legal pages: readable width, both languages on one page (ar first), footer nav.
export default function Legal({ brand, titleAr, titleEn, updated, children }: { brand: string; titleAr: string; titleEn: string; updated: string; children: ReactNode }) {
  return (
    <main className="container legal">
      <header className="topbar" style={{ position: 'static', boxShadow: 'none', background: 'transparent' }}>
        <div className="container" style={{ paddingInline: 0 }}><Link href="/" className="brand">{brand}</Link></div>
      </header>
      <h1 style={{ fontSize: 24, margin: '8px 0 0' }}>{titleAr} <span className="muted" style={{ fontWeight: 400, fontSize: 16 }}>/ {titleEn}</span></h1>
      <p className="muted" style={{ fontSize: 13 }}>آخر تحديث / Last updated: {updated}</p>
      {children}
      <nav className="row" style={{ marginTop: 24, fontSize: 14 }}>
        <Link href="/legal/privacy">سياسة الخصوصية · Privacy</Link><span className="muted">·</span>
        <Link href="/legal/terms">الشروط · Terms</Link><span className="muted">·</span>
        <Link href="/legal/delete-data">حذف البيانات · Data deletion</Link>
      </nav>
    </main>
  );
}
