'use client';
import { useState, type ReactNode } from 'react';

export default function LoginTabs({ email, phone, labels }: { email: ReactNode; phone: ReactNode; labels: { email: string; phone: string } }) {
  const [tab, setTab] = useState<'phone' | 'email'>('phone');
  return (
    <div className="stack">
      <div className="row" role="tablist" style={{ gap: 6 }}>
        <button role="tab" aria-selected={tab === 'phone'} className={`btn ${tab === 'phone' ? 'primary' : ''}`} style={{ flex: 1 }} onClick={() => setTab('phone')}>{labels.phone}</button>
        <button role="tab" aria-selected={tab === 'email'} className={`btn ${tab === 'email' ? 'primary' : ''}`} style={{ flex: 1 }} onClick={() => setTab('email')}>{labels.email}</button>
      </div>
      {tab === 'phone' ? phone : email}
    </div>
  );
}
